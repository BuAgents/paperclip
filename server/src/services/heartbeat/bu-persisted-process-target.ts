// bu-fork (BUD-796, port of adca1c23f1): stop plugin adapter processes.
//
// External adapter plugins (antigravity_local, zai_local, ...) are imported
// from their own package path and resolve their own copy of
// `@paperclipai/adapter-utils`, so `runChildProcess` registers their child in
// that copy's `runningProcesses` map, never the server's. They do not opt in
// to an adapter execution control either. Stop, pause and graceful shutdown
// only consulted the server map, so they marked the run terminal without
// signalling the provider; the surviving process kept holding the issue.
// Only the PID/process group the adapter reported through `onSpawn` reaches
// the server, so fall back to that.
import type { heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { currentProcessSpaceHash } from "../controller-process-identity.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { isProcessGroupAlive } from "../local-service-supervisor.js";

export type HeartbeatRunProcessTarget = {
  pid: number | null;
  processGroupId: number | null;
  graceSec: number;
};

const DEFAULT_PERSISTED_PROCESS_GRACE_SEC = 20;

type PersistedProcessRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "runtimeMode" | "processPid" | "processGroupId" | "processStartedAt" | "processHostHash"
>;

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

export function persistedProcessGraceSec(agent: { adapterConfig: unknown } | null | undefined) {
  const configured = parseObject(agent?.adapterConfig).graceSec;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PERSISTED_PROCESS_GRACE_SEC;
}

/**
 * The provider process of a legacy run this server is still executing, from
 * the identity persisted at spawn. Use only when no in-memory handle and no
 * adapter execution control own the run.
 *
 * Signalled only while this process still executes the run (`executing`), the
 * identity was recorded in this PID space, and the PID start time matches the
 * one recorded at spawn, so a recycled PID is never targeted. A group whose
 * leader already exited is still ours: Linux does not reuse a PID while a
 * process group with that ID has members.
 */
export async function resolvePersistedRunProcess(
  run: PersistedProcessRun,
  options: { executing: boolean; graceSec: number },
): Promise<HeartbeatRunProcessTarget | null> {
  if (!options.executing || run.runtimeMode === "native") return null;
  if (!run.processHostHash || run.processHostHash !== currentProcessSpaceHash()) return null;
  const pid = typeof run.processPid === "number" && run.processPid > 0 ? run.processPid : null;
  const processGroupId =
    typeof run.processGroupId === "number" && run.processGroupId > 1 ? run.processGroupId : null;
  if (pid === null && processGroupId === null) return null;

  const leaderAlive = pid !== null && pidAlive(pid);
  let pidOwned = false;
  if (leaderAlive && run.processStartedAt) {
    const observed = await readProcessStartedAt(pid).catch(() => null);
    pidOwned = observed !== null && new Date(observed).getTime() === run.processStartedAt.getTime();
  }
  const groupAlive = processGroupId !== null && isProcessGroupAlive(processGroupId);
  // When the group shares the leader's ID, a live leader with a different
  // identity means both numbers were recycled together.
  const groupOwned = groupAlive && (processGroupId !== pid || !leaderAlive || pidOwned);
  if (!pidOwned && !groupOwned) return null;
  return {
    pid: pidOwned ? pid : null,
    processGroupId: groupOwned ? processGroupId : null,
    graceSec: options.graceSec,
  };
}
