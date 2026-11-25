// bu-fork: "Automatic recovery stopped" diagnosis, against a real database
// and a real git repo (the workspace check shells out to git).
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { diagnoseRecoveryAction } from "./bu-recovery-diagnosis.js";

const execFile = promisify(execFileCallback);
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("recovery-stopped diagnosis", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  let paperclipHome: string;
  let runLogBase: string;
  let previousHome: string | undefined;
  let previousRunLogBase: string | undefined;

  async function writeRunLog(logRef: string, content: string) {
    const file = path.join(runLogBase, logRef);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async function makeIssue(
    cause: string,
    status: "active" | "resolved",
    runOverrides: { status?: string; logRef?: string | null } = {},
    evidenceExtra: Record<string, unknown> = {},
  ) {
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "t", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: runOverrides.status ?? "failed",
      logRef: runOverrides.logRef === undefined ? null : runOverrides.logRef,
      logStore: "local_file",
      contextSnapshot: { issueId },
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status, cause, fingerprint: randomUUID(),
      evidence: { runId, ...evidenceExtra }, nextAction: "test",
    }).returning({ id: issueRecoveryActions.id });
    return { issueId, runId, actionId: action!.id };
  }

  beforeAll(async () => {
    previousHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await mkdtemp(path.join(os.tmpdir(), "bu-recovery-diag-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    // Logs are read through the real run-log store (local_file), rooted here.
    previousRunLogBase = process.env.RUN_LOG_BASE_PATH;
    runLogBase = path.join(paperclipHome, "run-logs");
    process.env.RUN_LOG_BASE_PATH = runLogBase;
    database = await startEmbeddedPostgresTestDatabase("paperclip-bu-recovery-diag-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "RecoveryDiag", issuePrefix: "RDG" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "claude_local" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Repo" });
  }, 120_000);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousRunLogBase === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousRunLogBase;
    await database?.cleanup();
  });

  it("is safe when there is no execution workspace and no tool-call markers in the log", async () => {
    const { issueId, actionId } = await makeIssue("legacy_execution_requires_reconciliation", "active", { logRef: null });
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(true);
    expect(result.reconciliation?.actionId).toBe(actionId);
    expect(result.reconciliation?.executionReconciliation.actionOutcome).toBe("not_performed");
  });

  it("is unsafe when the run log has a tool-call marker", async () => {
    const { issueId, actionId, runId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
    await db.update(heartbeatRuns).set({ logRef }).where(eq(heartbeatRuns.id, runId));
    await writeRunLog(logRef, '{"type":"assistant"}\n{"type":"tool_use","name":"Bash"}\n');
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/tool-call marker/);
  });

  it("is safe when the run log exists but has no tool-call markers", async () => {
    const { issueId, actionId, runId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
    await db.update(heartbeatRuns).set({ logRef }).where(eq(heartbeatRuns.id, runId));
    await writeRunLog(logRef, '{"type":"assistant","message":"quota exceeded"}\n{"type":"result","is_error":true}\n');
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(true);
  });

  // Real run logs wrap each provider line as an escaped JSON string in `chunk`; the
  // original raw-text scan never matched there, for any adapter.
  it.each([
    ["claude_local", { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read" }] } }],
    ["codex_local", { type: "acpx.tool_call", name: "ls -la", status: "completed" }],
    ["antigravity_local", { event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command" } }],
  ])("is unsafe when a %s tool call sits inside a wrapped log chunk", async (_adapter, event) => {
    const { issueId, actionId, runId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
    await db.update(heartbeatRuns).set({ logRef }).where(eq(heartbeatRuns.id, runId));
    const line = (chunk: string) => JSON.stringify({ ts: new Date().toISOString(), stream: "stdout", chunk });
    await writeRunLog(logRef, `${line('{"type":"system","subtype":"init"}\n')}\n${line(`${JSON.stringify(event)}\n`)}\n`);
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/tool-call marker/);
  });

  it("is safe when a wrapped log has only a provider quota refusal", async () => {
    const { issueId, actionId, runId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
    await db.update(heartbeatRuns).set({ logRef }).where(eq(heartbeatRuns.id, runId));
    await writeRunLog(logRef, `${JSON.stringify({ ts: new Date().toISOString(), stream: "stderr",
      chunk: "error: Individual quota reached. Resets in 33m38s.\n" })}\n`);
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(true);
  });

  it("is unsafe for a cause that isn't reconciliation-required (getExecutionBlocker never surfaces it as the blocker)", async () => {
    const { issueId, actionId } = await makeIssue("workspace_validation_failed", "active");
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
  });

  it("is unsafe once the recovery action is already resolved", async () => {
    const { issueId, actionId } = await makeIssue("legacy_execution_requires_reconciliation", "resolved");
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
  });

  // bu-fork: execution-blocker.ts's own predicate keeps surfacing a *resolved* action as
  // the current blocker when its evidence carries automaticRecovery.replay === "blocked"
  // (its own comment calls this an "effective no-replay hold") -- and the native
  // POST /issues/:id/recovery-actions/resolve handler already knows how to reopen exactly
  // that action by id (routes/issues.ts). Hit live on BUD-80 and SPL-29, 2026-10-03: the
  // diagnosis bailed out on any non-"active" status, so this provably-safe, system-marked-
  // reopenable case had no automated path at all -- a human had to resolve it by hand.
  it("is safe for a resolved action held open for replay, and still runs the normal safety checks", async () => {
    const { issueId, actionId } = await makeIssue(
      "legacy_execution_requires_reconciliation", "resolved", { logRef: null },
      { automaticRecovery: { replay: "blocked" } },
    );
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(true);
    expect(result.reconciliation?.actionId).toBe(actionId);
    expect(result.reconciliation?.executionReconciliation.actionOutcome).toBe("not_performed");
  });

  it("is still unsafe for a resolved+replay-blocked action whose run has unverified side effects", async () => {
    const { issueId, actionId, runId } = await makeIssue(
      "legacy_execution_requires_reconciliation", "resolved", {},
      { automaticRecovery: { replay: "blocked" } },
    );
    const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
    await db.update(heartbeatRuns).set({ logRef }).where(eq(heartbeatRuns.id, runId));
    await writeRunLog(logRef, '{"type":"assistant"}\n{"type":"tool_use","name":"Bash"}\n');
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/tool-call marker/);
  });

  it("is unsafe for a resolved action with no replay hold (the ordinary already-done case)", async () => {
    const { issueId, actionId } = await makeIssue(
      "legacy_execution_requires_reconciliation", "resolved", { logRef: null },
      { automaticRecovery: { replay: "allowed" } },
    );
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
  });

  it("is unsafe when the action id doesn't match the issue's current blocker", async () => {
    const { issueId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId: randomUUID() });
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/doesn't match/);
  });

  it("is unsafe when the workspace has a commit ahead of base or is dirty, and safe when clean", async () => {
    const { issueId, actionId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    const repo = await mkdtemp(path.join(os.tmpdir(), "bu-recovery-diag-repo-"));
    const git = (args: string[]) => execFile("git", ["-C", repo, ...args]);
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@test"]);
    await git(["config", "user.name", "test"]);
    await writeFile(path.join(repo, "a.txt"), "a");
    await git(["add", "a.txt"]);
    await git(["commit", "-q", "-m", "base"]);
    const baseSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: "w", cwd: repo, baseRef: baseSha, branchName: "work",
    }).returning({ id: executionWorkspaces.id });
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, issueId));

    // Dirty: an untracked-but-uncommitted change.
    await writeFile(path.join(repo, "b.txt"), "b");
    const dirty = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(dirty.safe).toBe(false);
    expect(dirty.reason).toMatch(/side effects/);

    // Committed ahead of base.
    await git(["add", "b.txt"]);
    await git(["commit", "-q", "-m", "wip"]);
    const ahead = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(ahead.safe).toBe(false);

    // Reset back to a clean checkout at base: safe again.
    await git(["reset", "-q", "--hard", baseSha]);
    const clean = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(clean.safe).toBe(true);
    expect(clean.reason).toMatch(/0 commits ahead/);
  });

  it("is safe when the recorded run log file no longer exists (nothing to scan)", async () => {
    const { issueId, actionId, runId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    await db.update(heartbeatRuns).set({ logRef: `${companyId}/${agentId}/${runId}-missing.ndjson` }).where(eq(heartbeatRuns.id, runId));
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(true);
    expect(result.reason).toMatch(/not found/);
  });

  it("finds a tool-call marker past the first log page", async () => {
    const { issueId, actionId, runId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    const logRef = `${companyId}/${agentId}/${runId}.ndjson`;
    await db.update(heartbeatRuns).set({ logRef }).where(eq(heartbeatRuns.id, runId));
    const filler = `${JSON.stringify({ stream: "stdout", chunk: "x".repeat(900) })}\n`.repeat(1_500);
    await writeRunLog(logRef, `${filler}${JSON.stringify({ stream: "stdout", chunk: '{"type":"tool_use","name":"Read"}' })}\n`);
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/tool-call marker/);
  });

  it("treats a compressed log as unverified", async () => {
    const { issueId, actionId, runId } = await makeIssue("legacy_execution_requires_reconciliation", "active");
    await db.update(heartbeatRuns).set({ logRef: `${companyId}/${agentId}/${runId}.ndjson.gz`, logCompressed: true })
      .where(eq(heartbeatRuns.id, runId));
    const result = await diagnoseRecoveryAction(db, { companyId, issueId, actionId });
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/compressed/);
  });
});
