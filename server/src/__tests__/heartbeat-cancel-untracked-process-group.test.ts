import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  registerServerAdapter,
  runningProcesses,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.js";
import { isProcessGroupAlive } from "../services/local-service-supervisor.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// External adapter plugins (antigravity_local, zai_local) load their own copy
// of @paperclipai/adapter-utils, so their child lands in that copy's
// `runningProcesses`, never the server's. Only onSpawn's PID/group reaches the
// server. This adapter reproduces that: it spawns outside the server map.
const PLUGIN_ADAPTER_TYPE = "antigravity_local";

// Leader and grandchildren all ignore SIGTERM, like CLIs hung on tool children.
const STUBBORN_GROUP_SCRIPT = [
  "trap '' TERM",
  "(trap '' TERM; sleep 600) &",
  "(trap '' TERM; sleep 600) &",
  "echo ready",
  "wait",
].join("\n");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres =
  embeddedPostgresSupport.supported && process.platform !== "win32"
    ? describe
    : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping untracked process-group cancellation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("cancelling a run whose process is not in runningProcesses", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  const spawned: ChildProcess[] = [];

  const execute: ServerAdapterModule["execute"] = async (ctx) => {
    const child = spawn("sh", ["-c", STUBBORN_GROUP_SCRIPT], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    spawned.push(child);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    await ctx.onSpawn?.({
      pid: child.pid!,
      processGroupId: child.pid!,
      startedAt: new Date().toISOString(),
    });
    const { code, signal } = await exited;
    return { exitCode: code, signal, timedOut: false };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "heartbeat-cancel-untracked-group-",
    );
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: PLUGIN_ADAPTER_TYPE,
      supportsLocalAgentJwt: false,
      execute,
      testEnvironment: async () => ({
        adapterType: PLUGIN_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 30_000);

  afterEach(async () => {
    for (const child of spawned.splice(0)) {
      if (child.pid && isProcessGroupAlive(child.pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(
      sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `),
    );
  });

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(PLUGIN_ADAPTER_TYPE);
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Untracked group",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin agent",
      role: "qa",
      status: "idle",
      adapterType: PLUGIN_ADAPTER_TYPE,
      adapterConfig: { graceSec: 1 },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `UNT-${issueId.slice(0, 8)}`,
      issueNumber: 1,
      title: "Reassigned mid-run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "owner",
    });
    return { companyId, agentId, issueId };
  }

  async function startRun(seeded: Awaited<ReturnType<typeof seed>>) {
    const queued = await heartbeat.invoke(
      seeded.agentId,
      "assignment",
      { issueId: seeded.issueId, taskId: seeded.issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(queued).not.toBeNull();
    const running = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queued!.id));
      return row?.status === "running" && row.processGroupId ? row : null;
    });
    // The precondition of the incident: the server holds no handle for it.
    expect(runningProcesses.has(running.id)).toBe(false);
    expect(isProcessGroupAlive(running.processGroupId)).toBe(true);
    return running;
  }

  it("terminates the persisted process group on issue_reassigned, escalating past SIGTERM", async () => {
    const seeded = await seed();
    const run = await startRun(seeded);

    const cancelled = await heartbeat.cancelRun(
      run.id,
      "Cancelled before issue reassignment",
      {
        errorCode: "issue_reassigned",
        resultJson: { reassignmentStopConfirmed: true },
        terminationGraceMs: 300,
      },
    );

    expect(cancelled?.status).toBe("cancelled");
    expect(isProcessGroupAlive(run.processGroupId)).toBe(false);
    expect(
      await getConversationOwnershipBlocker(db, seeded.companyId, seeded.issueId),
    ).toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [final] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(final).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
  }, 30_000);

  it("terminates the persisted process group when the agent's active runs are cancelled", async () => {
    const seeded = await seed();
    const run = await startRun(seeded);

    await heartbeat.cancelActiveForAgent(seeded.agentId, "Cancelled due to agent pause");

    await waitFor(async () => !isProcessGroupAlive(run.processGroupId), 10_000);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(
      await getConversationOwnershipBlocker(db, seeded.companyId, seeded.issueId),
    ).toBeNull();
  }, 30_000);
});
