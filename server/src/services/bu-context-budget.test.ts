import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { CONTEXT_HARD_LIMIT_BYTES, enforceBudget, envelopeBytes } from "./bu-context-budget.js";

// bu-fork: hard size budget on the replayed task history.
function envelope(count: number, bodySize = 100, origins: string[] = []): ExecutionContinuationEnvelope {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `c${String(i).padStart(3, "0")}`,
    authorType: i % 2 ? "agent" : "user",
    authorId: "x",
    createdByRunId: null,
    body: "b".repeat(bodySize),
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    deleted: false,
    sourceTrust: null,
  }));
  return {
    version: 1,
    companyId: "co",
    issueId: "is",
    trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
    originCommentIds: origins,
    objective: "do it",
    messages,
    interactionOutcomes: [],
    completedWork: null,
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: messages.at(-1)?.id ?? null, summaryThroughCommentId: null },
  };
}

describe("enforceBudget", () => {
  it("leaves small envelopes untouched", () => {
    const env = envelope(5);
    expect(enforceBudget(env)).toBe(env);
  });

  it("drops the oldest messages to fit and reports how many", () => {
    const env = envelope(60, 3000, ["c010"]);
    expect(envelopeBytes(env)).toBeGreaterThan(CONTEXT_HARD_LIMIT_BYTES);
    const out = enforceBudget(env);
    expect(envelopeBytes(out)).toBeLessThanOrEqual(CONTEXT_HARD_LIMIT_BYTES);
    expect(out.coverage.kind).toBe("truncated_task_history");
    expect(out.coverage.throughCommentId).toBe("c059");
    expect(out.messages.at(-1)!.id).toBe("c059");
    expect(out.messages.some((m) => m.id === "c010")).toBe(true);
    expect(out.messages.some((m) => m.id === "c000")).toBe(false);
    expect(out.coverage.omittedMessageCount).toBe(60 - out.messages.length);
    // Only what is needed is dropped: one more message would not fit.
    expect(envelopeBytes(out) + 3200).toBeGreaterThan(CONTEXT_HARD_LIMIT_BYTES);
  });

  it("keeps the objective's source comment and trims the resume delta too", () => {
    const env = envelope(60, 3000);
    env.objectiveSource = { kind: "comment", id: "c001", revision: env.messages[1].updatedAt };
    env.resumeDelta = { baseRunId: "r0", messages: env.messages.slice(0, 30) };
    const out = enforceBudget(env);
    expect(envelopeBytes(out)).toBeLessThanOrEqual(CONTEXT_HARD_LIMIT_BYTES);
    expect(out.messages.map((m) => m.id)).toContain("c001");
    const kept = new Set(out.messages.map((m) => m.id));
    expect(out.resumeDelta!.messages.every((m) => kept.has(m.id))).toBe(true);
  });

  it("trims oversized interaction results when protected messages alone do not fit", () => {
    const env = envelope(20, 2000, ["c019"]);
    env.interactionOutcomes = [{ id: "i1", kind: "request_confirmation", status: "accepted", result: "x".repeat(200_000) }];
    env.completedWork = "w".repeat(50_000);
    const out = enforceBudget(env, 20 * 1024);
    expect(out.messages.map((m) => m.id)).toEqual(["c019"]);
    expect(out.interactionOutcomes[0].result).toBe("[omitted: context budget]");
    expect(out.completedWork).toHaveLength(4000);
    expect(envelopeBytes(out)).toBeLessThanOrEqual(20 * 1024);
  });
});
