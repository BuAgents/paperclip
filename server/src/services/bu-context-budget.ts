// bu-fork: hard size budget for the execution continuation (port of a319ee6b15,
// budget part only; the summary/compaction parts were dropped in favour of
// upstream's context-compaction.ts).
//
// Upstream replays the complete task history (`messages`) into every
// fresh-session wake prompt with no bound. Long-running tasks grew that past
// what some adapters can launch (gemini/kimi/hermes pass the prompt as argv,
// where a single string over 128 KiB fails with E2BIG) and past useful model
// context. The full thread stays in the API; the prompt tells the agent to
// fetch it when coverage is `truncated_task_history`.
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/** The continuation handed to a run never exceeds this (best effort, see below). */
export const CONTEXT_HARD_LIMIT_BYTES = 96 * 1024;

const OMITTED = "[omitted: context budget]";

export function envelopeBytes(envelope: ExecutionContinuationEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

/**
 * Drops the oldest messages until the envelope fits. Messages that triggered
 * this wake (`originCommentIds`) and the objective's source comment are always
 * kept. If those alone are still too big, interaction outcome payloads and the
 * completed-work summary are trimmed.
 */
export function enforceBudget(
  envelope: ExecutionContinuationEnvelope,
  limitBytes = CONTEXT_HARD_LIMIT_BYTES,
): ExecutionContinuationEnvelope {
  let total = envelopeBytes(envelope);
  if (total <= limitBytes) return envelope;
  const protectedIds = new Set(envelope.originCommentIds);
  if (envelope.objectiveSource?.kind === "comment") protectedIds.add(envelope.objectiveSource.id);
  const deltaBytes = new Map(
    (envelope.resumeDelta?.messages ?? []).map((m) => [m.id, Buffer.byteLength(JSON.stringify(m), "utf8") + 1]),
  );
  const dropped = new Set<string>();
  // Oldest first. Byte accounting is incremental (each array element costs its
  // JSON plus a separator) so a long thread is not re-serialized per message.
  for (const message of envelope.messages) {
    if (total <= limitBytes) break;
    if (protectedIds.has(message.id)) continue;
    dropped.add(message.id);
    total -= Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    total -= deltaBytes.get(message.id) ?? 0;
  }
  let current: ExecutionContinuationEnvelope = envelope;
  if (dropped.size > 0) {
    const messages = envelope.messages.filter((m) => !dropped.has(m.id));
    current = {
      ...envelope,
      messages,
      ...(envelope.resumeDelta
        ? {
            resumeDelta: {
              ...envelope.resumeDelta,
              messages: envelope.resumeDelta.messages.filter((m) => !dropped.has(m.id)),
            },
          }
        : {}),
      coverage: {
        ...envelope.coverage,
        kind: "truncated_task_history",
        omittedMessageCount: (envelope.coverage.omittedMessageCount ?? 0) + dropped.size,
      },
    };
  }
  // Still too big (huge interaction results or protected messages): trim those payloads.
  if (envelopeBytes(current) > limitBytes) {
    current = {
      ...current,
      interactionOutcomes: current.interactionOutcomes.map((o) => ({ ...o, result: OMITTED })),
      completedWork: current.completedWork ? current.completedWork.slice(0, 4000) : null,
    };
  }
  return current;
}
