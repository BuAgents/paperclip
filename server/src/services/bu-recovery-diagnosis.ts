// bu-fork: "Automatic recovery stopped" has no one-click action upstream.
// Paperclip refuses to auto-resume a run once its outcome is unverified, and
// rightly so — but the common case (the run failed before it ever touched
// anything) is provable, not just likely. This computes that proof from the
// run's own execution workspace and log, so a board user can clear it with one
// click instead of the manual database/log inspection we've been doing by
// hand each time (BUD-43, BUD-59, BUD-125, …).
//
// Deliberately read-only: it never writes to the issue or the recovery
// action. The caller (the UI, via routes/bu-recovery.ts) submits the verdict
// to Paperclip's own, already-audited POST /issues/:id/recovery-actions/resolve
// — this file never bypasses it.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import {
  executionWorkspaces,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { requiresExecutionReconciliation } from "@paperclipai/shared";
import { getExecutionBlocker } from "./execution-blocker.js";
import { getRunLogStore, isRunLogStoreType } from "./run-log-store.js";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 15_000;
const LOG_PAGE_BYTES = 1_000_000;
/** A log bigger than this is not scanned to the end; it is treated as unverified. */
const LOG_SCAN_MAX_BYTES = 64_000_000;
/**
 * Adapter-agnostic markers of a real tool call in a run's ndjson log; kept broad on purpose.
 * Matched against each line's decoded `chunk` (run logs wrap provider output as an escaped
 * JSON string), and against the raw line for anything not wrapped that way.
 */
const TOOL_CALL_MARKERS = [
  '"type":"tool_use"', // Claude Code (claude_local, zai_local)
  '"type":"tool_call"',
  '"type":"acpx.tool', // ACP engine (codex_local): acpx.tool_call / acpx.tool_result
  '"tool_use_id"',
  '"step_type":"tool"', // agy stream-json (antigravity_local)
  '"name":"Bash"',
  '"name":"bash"',
];

function findToolCallMarkerInLine(line: string): string | undefined {
  if (!line) return undefined;
  const candidates = [line];
  try {
    const chunk = (JSON.parse(line) as { chunk?: unknown }).chunk;
    if (typeof chunk === "string") candidates.push(chunk);
  } catch {
    // Not JSON: the raw line is all there is to scan.
  }
  for (const candidate of candidates) {
    const hit = TOOL_CALL_MARKERS.find((marker) => candidate.includes(marker));
    if (hit) return hit;
  }
  return undefined;
}

/** Exported for tests: scans complete ndjson text for a tool-call marker. */
export function findToolCallMarker(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const hit = findToolCallMarkerInLine(line);
    if (hit) return hit;
  }
  return undefined;
}

const RESOLVABLE_RUN_STATUSES = new Set(["failed", "cancelled", "timed_out", "interrupted"]);

export interface RecoveryDiagnosis {
  safe: boolean;
  reason: string;
  /** Present only when safe: ready to POST to /issues/:id/recovery-actions/resolve. */
  reconciliation?: {
    actionId: string;
    outcome: "restored";
    sourceIssueStatus: "todo";
    resolutionNote: string;
    executionReconciliation: {
      runId: string;
      providerStopped: true;
      actionOutcome: "not_performed";
      outcomeEvidence: string;
    };
  };
}

async function gitCheck(cwd: string, branchName: string | null, baseRef: string | null): Promise<{ clean: boolean; detail: string }> {
  if (!existsSync(cwd)) return { clean: true, detail: `no workspace directory at ${cwd} (never materialized)` };
  const run = (args: string[]) => execFile("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  try {
    const status = await run(["status", "--porcelain"]);
    if (status.stdout.trim()) return { clean: false, detail: "the workspace has uncommitted changes" };
    if (baseRef) {
      const ahead = await run(["rev-list", "--count", `${baseRef}..HEAD`]).catch(() => null);
      const count = ahead ? Number.parseInt(ahead.stdout.trim(), 10) : NaN;
      if (Number.isFinite(count) && count > 0) return { clean: false, detail: `${count} commit(s) ahead of ${baseRef}` };
    }
    if (branchName) {
      const remote = await run(["ls-remote", "--heads", "origin", branchName]).catch(() => null);
      if (remote && remote.stdout.trim()) return { clean: false, detail: `branch ${branchName} exists on the remote` };
    }
    return { clean: true, detail: `workspace clean, 0 commits ahead${baseRef ? ` of ${baseRef}` : ""}, no matching remote branch` };
  } catch (error) {
    return { clean: false, detail: `could not inspect the workspace (${error instanceof Error ? error.message : String(error)})` };
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404
    || (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Reads the run log through Paperclip's own run-log store, page by page. */
async function logHasToolCalls(run: {
  logStore: string | null;
  logRef: string | null;
  logCompressed: boolean;
}): Promise<{ hasCalls: boolean; detail: string }> {
  if (!run.logRef) return { hasCalls: false, detail: "no run log recorded" };
  if (run.logCompressed) return { hasCalls: true, detail: "the run log is compressed and was not scanned — treating as unverified" };
  const handle = { store: isRunLogStoreType(run.logStore) ? run.logStore : "local_file" as const, logRef: run.logRef };
  const store = getRunLogStore();
  let offset = 0;
  let remainder = "";
  try {
    for (;;) {
      const page = await store.read(handle, { offset, limitBytes: LOG_PAGE_BYTES });
      const lines = (remainder + page.content).split("\n");
      remainder = page.nextOffset === undefined ? "" : lines.pop() ?? "";
      for (const line of lines) {
        const hit = findToolCallMarkerInLine(line);
        if (hit) return { hasCalls: true, detail: `log contains a tool-call marker (${hit})` };
      }
      if (page.nextOffset === undefined || page.nextOffset <= offset) break;
      offset = page.nextOffset;
      if (offset >= LOG_SCAN_MAX_BYTES) {
        return { hasCalls: true, detail: "the run log is too large to scan fully — treating as unverified" };
      }
    }
    const hit = findToolCallMarkerInLine(remainder);
    if (hit) return { hasCalls: true, detail: `log contains a tool-call marker (${hit})` };
    return { hasCalls: false, detail: "log has no tool-call markers" };
  } catch (error) {
    if (offset === 0 && isNotFound(error)) return { hasCalls: false, detail: "run log file not found (nothing to scan)" };
    return { hasCalls: true, detail: `could not read the run log (${error instanceof Error ? error.message : String(error)}) — treating as unverified` };
  }
}

/**
 * Provable "this run did nothing that needs undoing": its execution
 * workspace (if any) has no uncommitted changes, no commits ahead of base,
 * and no matching remote branch; and its log has no tool-call markers.
 * Anything short of that returns `safe: false` — a human decides, same as today.
 */
export async function diagnoseRecoveryAction(
  db: Db,
  input: { companyId: string; issueId: string; actionId: string },
): Promise<RecoveryDiagnosis> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue) return { safe: false, reason: "Issue not found." };
  const blocker = await getExecutionBlocker(db, input.companyId, input.issueId);
  if (!blocker || blocker.recoveryActionId !== input.actionId) {
    return { safe: false, reason: "This issue's current blocker doesn't match the recovery action requested; it may already be resolved." };
  }

  const [action] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.id, input.actionId), eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId),
  ));
  if (!action) return { safe: false, reason: "This recovery action is no longer active." };
  if (action.status !== "active") {
    // execution-blocker.ts's executionBlockerPredicate keeps surfacing a *settled* action
    // as the current blocker when its evidence carries automaticRecovery.replay === "blocked"
    // — and routes/issues.ts's resolve handler reopens exactly that action by id when it
    // receives executionReconciliation. Treat it as reopenable instead of refusing.
    const automaticRecovery = (action.evidence as { automaticRecovery?: { replay?: unknown } } | null)?.automaticRecovery;
    const reopenable = (action.status === "resolved" || action.status === "cancelled") && automaticRecovery?.replay === "blocked";
    if (!reopenable) {
      return {
        safe: false,
        reason: action.status === "resolved" || action.status === "cancelled"
          ? "This recovery action already settled and isn't held open for a replay; nothing further to reconcile."
          : "This recovery action is no longer active.",
      };
    }
  }
  if (!requiresExecutionReconciliation(action.cause)) {
    return { safe: false, reason: `"${action.cause}" isn't a reconciliation-required cause; this needs a human decision through the normal path.` };
  }

  const runId = blocker.runId ?? (action.evidence as { runId?: unknown } | null)?.runId;
  if (typeof runId !== "string") return { safe: false, reason: "No source run is recorded on this blocker." };
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, input.companyId)));
  if (!run) return { safe: false, reason: "The source run could not be found." };
  if (!RESOLVABLE_RUN_STATUSES.has(run.status)) {
    return { safe: false, reason: `The source run's status is "${run.status}", not a terminal failure — needs a human decision.` };
  }

  let workspaceDetail = "no execution workspace on this issue";
  let workspaceClean = true;
  if (issue.executionWorkspaceId) {
    const [workspace] = await db.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, issue.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId),
    ));
    if (workspace?.cwd) {
      const result = await gitCheck(workspace.cwd, workspace.branchName, workspace.baseRef);
      workspaceClean = result.clean;
      workspaceDetail = result.detail;
    } else {
      workspaceDetail = "execution workspace has no local path (nothing to check)";
    }
  }

  const { hasCalls, detail: logDetail } = await logHasToolCalls(run);

  if (!workspaceClean || hasCalls) {
    return {
      safe: false,
      reason: `Cannot confirm this run had no side effects — ${workspaceClean ? logDetail : workspaceDetail}. Inspect it manually before resuming.`,
    };
  }

  const evidence = `Automatic diagnosis (bu-fork): run ${run.id} status "${run.status}"; ${workspaceDetail}; ${logDetail}.`;
  return {
    safe: true,
    reason: `No side effects found: ${workspaceDetail}; ${logDetail}.`,
    reconciliation: {
      actionId: action.id,
      outcome: "restored",
      sourceIssueStatus: "todo",
      resolutionNote: evidence,
      executionReconciliation: {
        runId: run.id,
        providerStopped: true,
        actionOutcome: "not_performed",
        outcomeEvidence: evidence,
      },
    },
  };
}
