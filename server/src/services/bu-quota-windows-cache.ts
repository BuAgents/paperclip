// bu-fork: agent-readable, cached provider quota windows
// (GET /companies/:companyId/costs/quota-windows/cached). fetchAllQuotaWindows()
// spawns `claude`/`codex` probes and calls live provider usage APIs (up to
// 20s per adapter), which is why the live route stays board-only. This cache
// lets an orchestrator agent check quota before delegating without paying that
// cost on every heartbeat.
//
// Refreshed on read, never on a timer: a read of a stale snapshot returns it
// immediately and starts at most one background refresh, so an idle server
// makes no provider calls (rules/sleep-aware-background-work.mdc).
//
// Caveat for reviewers: these are the control-plane host's own CLI logins
// (instance-wide, not per company), unlike upstream's per-user managed
// connection quotas on the board route.
import type { CachedQuotaWindows } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { fetchAllQuotaWindows } from "./quota-windows.js";
import { trackIdleWork } from "./task-admission.js";

export const QUOTA_WINDOWS_CACHE_TTL_MS = 3 * 60_000;

let snapshot: CachedQuotaWindows | null = null;
let snapshotAt = 0;
let inFlight: Promise<CachedQuotaWindows | null> | null = null;

function refresh(fetchWindows: typeof fetchAllQuotaWindows): Promise<CachedQuotaWindows | null> {
  inFlight ??= trackIdleWork(fetchWindows().then((results) => {
    snapshot = { asOf: new Date().toISOString(), results };
    snapshotAt = Date.now();
    return snapshot;
  }).catch((err) => {
    logger.error({ err }, "quota windows cache refresh failed");
    return null;
  }).finally(() => {
    inFlight = null;
  }));
  return inFlight;
}

/**
 * Returns the last snapshot without waiting on providers, and starts a single
 * background refresh when it is missing or older than the TTL. Null only until
 * the first refresh completes.
 */
export function readCachedQuotaWindows(
  options: { now?: number; fetchWindows?: typeof fetchAllQuotaWindows } = {},
): CachedQuotaWindows | null {
  const now = options.now ?? Date.now();
  if (!snapshot || now - snapshotAt >= QUOTA_WINDOWS_CACHE_TTL_MS) {
    void refresh(options.fetchWindows ?? fetchAllQuotaWindows);
  }
  return snapshot;
}

export function resetCachedQuotaWindowsForTests() {
  snapshot = null;
  snapshotAt = 0;
  inFlight = null;
}

/** Test hook: the in-flight refresh, if any. */
export function pendingQuotaWindowsRefreshForTests() {
  return inFlight;
}
