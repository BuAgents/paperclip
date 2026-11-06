import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTerminateLocalService = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Picked up the handoff.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../services/local-service-supervisor.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/local-service-supervisor.js")
  >("../services/local-service-supervisor.js");
  mockTerminateLocalService.mockImplementation(actual.terminateLocalService);
  return { ...actual, terminateLocalService: mockTerminateLocalService };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const { runningProcesses } = await import("../adapters/index.ts");
const { heartbeatService } = await import("../services/heartbeat.ts");
const { issueRoutes } = await import("../routes/issues.js");
const { errorHandler } = await import("../middleware/index.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping same-issue handoff wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function isPidAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number | undefined) {
  await vi.waitFor(() => expect(isPidAlive(pid)).toBe(false), { timeout: 5_000 });
}

/**
 * Agent A hands issue X to agent B with a comment, from inside A's own turn.
 * The reassignment stops A's run, but A's provider process group (the CLI and
 * the very `curl` that made the PATCH) outlives the terminal status for a
 * moment, so B's assignment wake is parked as `deferred_issue_execution`
 * behind conversation ownership. These tests prove B is promoted once that
 * process is gone, both by A's executor cleanup and by the periodic sweeper.
 */
describeEmbeddedPostgres("same-issue handoff wakes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children = new Set<ChildProcess>();
  const pendingReleases = new Set<() => void>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-handoff-wake-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "handoff-owner",
      name: "Handoff Owner",
      email: "handoff-owner@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterEach(async () => {
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    for (const release of pendingReleases) release();
    pendingReleases.clear();
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
    const actual = await vi.importActual<
      typeof import("../services/local-service-supervisor.js")
    >("../services/local-service-supervisor.js");
    mockTerminateLocalService.mockReset();
    mockTerminateLocalService.mockImplementation(actual.terminateLocalService);
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function spawnLingeringProcess() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.add(child);
    return child;
  }

  async function killLingeringProcess(child: ChildProcess) {
    child.kill("SIGKILL");
    await waitForPidExit(child.pid);
  }

  function agentApp(companyId: string, agentId: string, runId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId,
        runId,
        companyId,
        source: "agent_key",
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Handoff Co",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "handoff-owner",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "handoff-owner",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values([agentA, agentB].map((id, index) => ({
      id,
      companyId,
      name: index === 0 ? "Agent A" : "Agent B",
      role: "engineer",
      status: "idle" as const,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateAgents: false },
    })));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `HAND-${issueId.slice(0, 8)}`,
      issueNumber: 1,
      title: "Same-issue handoff",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentA,
      responsibleUserId: "handoff-owner",
    });
    return { companyId, agentA, agentB, issueId };
  }

  /** A legacy claude_local run for A on X whose provider pid is `pid`. */
  async function seedRunningLegacyRun(
    seeded: Awaited<ReturnType<typeof seedCompany>>,
    child: ChildProcess,
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: seeded.companyId,
      agentId: seeded.agentA,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      runtimeModeResolvedAt: new Date(),
      startedAt: new Date(),
      processPid: child.pid,
      processGroupId: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, wakeReason: "issue_assigned" },
    });
    await db.update(issues)
      .set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: new Date() })
      .where(eq(issues.id, seeded.issueId));
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
    return runId;
  }

  /** A hands X to B with a comment while A's process is still alive. */
  async function handOffToB(seeded: Awaited<ReturnType<typeof seedCompany>>, runId: string) {
    // The Stop signal reaches the CLI, but its process group lingers.
    mockTerminateLocalService.mockImplementationOnce(async () => undefined);
    const res = await request(agentApp(seeded.companyId, seeded.agentA, runId))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ assigneeAgentId: seeded.agentB, status: "todo", comment: "Handing this to B for review." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [comment] = await db.select().from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comment?.body).toBe("Handing this to B for review.");
    const [runA] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runA).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    return comment!;
  }

  async function wakesFor(agentId: string, issueId: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, agentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    ));
  }

  async function runsFor(agentId: string, issueId: string) {
    return db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
    ));
  }

  async function expectParkedHandoff(agentB: string, issueId: string, commentId: string) {
    // The route enqueues assignment wakes after its update commits.
    const parked = await vi.waitFor(async () => {
      const rows = (await wakesFor(agentB, issueId)).filter(w => w.status === "deferred_issue_execution");
      expect(rows).toHaveLength(1);
      return rows;
    }, { timeout: 5_000 });
    expect(parked[0]?.reason).toBe("issue_assigned");
    expect((parked[0]?.payload as any)?._paperclipWakeContext?.wakeCommentIds).toContain(commentId);
    expect(await runsFor(agentB, issueId)).toHaveLength(0);
  }

  async function expectPromotedHandoff(agentB: string, issueId: string, commentId: string) {
    await vi.waitFor(async () => {
      const runs = await runsFor(agentB, issueId);
      expect(runs).toHaveLength(1);
      expect(["queued", "running", "succeeded"]).toContain(runs[0]!.status);
      const ctx = runs[0]!.contextSnapshot as Record<string, unknown>;
      expect([ctx.wakeCommentId, ...((ctx.wakeCommentIds as string[] | undefined) ?? [])]).toContain(commentId);
    }, { timeout: 10_000 });
    const wakes = await wakesFor(agentB, issueId);
    expect(wakes.filter(w => w.status === "deferred_issue_execution")).toHaveLength(0);
  }

  it("promotes the new assignee's parked wake when the old owner's executor cleans up", async () => {
    const seeded = await seedCompany();
    const lingering = spawnLingeringProcess();
    let releaseA!: () => void;
    const aReleased = new Promise<void>(resolve => { releaseA = resolve; });
    pendingReleases.add(releaseA);
    let aStarted!: (runId: string) => void;
    const aRunning = new Promise<string>(resolve => { aStarted = resolve; });
    mockAdapterExecute.mockImplementationOnce((async (input: any) => {
      runningProcesses.set(input.runId, { child: lingering, graceSec: 1, processGroupId: null });
      await input.onSpawn({ pid: lingering.pid, startedAt: new Date().toISOString() });
      aStarted(input.runId);
      // The CLI exits on Stop; the executor settles only once its pipes close.
      await aReleased;
      return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: "stopped" };
    }) as any);

    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(seeded.agentA, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: seeded.issueId },
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    const runId = await aRunning;
    const [running] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(running).toMatchObject({ status: "running", runtimeMode: "legacy", processPid: lingering.pid });

    const comment = await handOffToB(seeded, runId);
    await expectParkedHandoff(seeded.agentB, seeded.issueId, comment.id);

    await killLingeringProcess(lingering);
    releaseA();
    await expectPromotedHandoff(seeded.agentB, seeded.issueId, comment.id);
  }, 30_000);

  it("lets the sweeper promote the new assignee although it never ran on the issue", async () => {
    const seeded = await seedCompany();
    const lingering = spawnLingeringProcess();
    // No live executor owns A's run (for example after a server restart), so
    // nothing runs A's post-cleanup; only the periodic sweep can recover B.
    const runId = await seedRunningLegacyRun(seeded, lingering);
    const comment = await handOffToB(seeded, runId);
    await expectParkedHandoff(seeded.agentB, seeded.issueId, comment.id);

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    // Still owned by A's live process: the sweep must not admit B yet.
    await expectParkedHandoff(seeded.agentB, seeded.issueId, comment.id);

    await killLingeringProcess(lingering);
    await heartbeat.resumeQueuedRuns();
    await expectPromotedHandoff(seeded.agentB, seeded.issueId, comment.id);
  }, 30_000);

  it("promotes the new assignee, not the old owner's parked assignment wake", async () => {
    const seeded = await seedCompany();
    const lingering = spawnLingeringProcess();
    const runId = await seedRunningLegacyRun(seeded, lingering);
    // An older assignment wake for A, parked behind A's own run.
    const [oldWake] = await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.agentA,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      requestedAt: new Date(Date.now() - 60_000),
      payload: {
        issueId: seeded.issueId,
        _paperclipWakeContext: { issueId: seeded.issueId, taskId: seeded.issueId, wakeReason: "issue_assigned" },
      },
    }).returning();
    const comment = await handOffToB(seeded, runId);
    await expectParkedHandoff(seeded.agentB, seeded.issueId, comment.id);

    await killLingeringProcess(lingering);
    await heartbeatService(db).resumeQueuedRuns();
    await expectPromotedHandoff(seeded.agentB, seeded.issueId, comment.id);
    // The handoff drain is pinned to B's wake; A's stale wake waits for B's
    // own release and is then retired without starting a turn for A.
    await vi.waitFor(async () => {
      const [old] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, oldWake!.id));
      expect(old?.status).not.toBe("deferred_issue_execution");
    }, { timeout: 10_000 });
    await heartbeatService(db).drainActiveRunExecutions();
    const runsA = await runsFor(seeded.agentA, seeded.issueId);
    expect(runsA.filter(r => r.id !== runId).every(r => r.status === "cancelled" && !r.startedAt)).toBe(true);
  }, 30_000);
});
