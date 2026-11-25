// bu-fork (BUD-743, port of afc2f66c6d F1): same-issue handoff wakes.
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * A same-issue handoff (reassignment from inside the old owner's turn) stops
 * that run, but its provider process can outlive the cancelled status. The
 * new assignee's wake is then parked as `deferred_issue_execution` behind
 * conversation ownership. Post-cleanup only promotes the finishing agent's own
 * deferred wakes, so this one stayed stranded until the periodic sweep.
 *
 * True when another agent's ordinary (non queued-comment-interrupt) wake is
 * parked on the issue. The caller then releases the issue for it now that the
 * finishing run's process is gone; the release drain re-checks ownership,
 * pauses and holds, so this grants no execution authority by itself.
 */
export async function hasDeferredHandoffWake(
  db: Db,
  input: { companyId: string; issueId: string; finishingAgentId: string },
): Promise<boolean> {
  const [handoff] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    sql`${agentWakeupRequests.agentId} <> ${input.finishingAgentId}`,
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
  )).limit(1);
  return Boolean(handoff);
}
