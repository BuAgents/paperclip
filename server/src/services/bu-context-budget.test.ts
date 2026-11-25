import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { applyCompaction, enforceBudget, envelopeBytes } from "./bu-context-budget.js";

// bu-fork: context compaction.
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

describe("applyCompaction", () => {
  it("replaces covered messages with the summary and keeps later ones", () => {
    const env = envelope(10);
    const out = applyCompaction(env, {
      id: "k1",
      summaryMarkdown: "## Summary",
      throughCommentId: "c005",
      throughCreatedAt: new Date(env.messages[5].createdAt),
    });
    expect(out.messages.map((m) => m.id)).toEqual(["c006", "c007", "c008", "c009"]);
    expect(out.summary).toEqual({ compactionId: "k1", markdown: "## Summary", throughCommentId: "c005", summarizedMessageCount: 6 });
    expect(out.coverage.kind).toBe("summarized_task_history");
    expect(out.coverage.summaryThroughCommentId).toBe("c005");
  });

  it("never summarizes away the comments that triggered this wake", () => {
    const env = envelope(10, 100, ["c002"]);
    const out = applyCompaction(env, {
      id: "k1", summaryMarkdown: "s", throughCommentId: "c005", throughCreatedAt: new Date(env.messages[5].createdAt),
    });
    expect(out.messages.map((m) => m.id)).toEqual(["c002", "c006", "c007", "c008", "c009"]);
  });

  it("is a no-op without a compaction", () => {
    const env = envelope(3);
    expect(applyCompaction(env, null)).toBe(env);
  });
});

describe("enforceBudget", () => {
  it("leaves small envelopes untouched", () => {
    const env = envelope(5);
    expect(enforceBudget(env)).toBe(env);
  });

  it("drops the oldest messages to fit and reports how many", () => {
    const env = envelope(60, 3000, ["c010"]);
    expect(envelopeBytes(env)).toBeGreaterThan(96 * 1024);
    const out = enforceBudget(env, 96 * 1024);
    expect(envelopeBytes(out)).toBeLessThanOrEqual(96 * 1024);
    expect(out.coverage.kind).toBe("truncated_task_history");
    expect(out.messages.at(-1)!.id).toBe("c059");
    expect(out.messages.some((m) => m.id === "c010")).toBe(true);
    expect(out.coverage.omittedMessageCount).toBe(60 - out.messages.length);
  });
});

// bu-fork: human names next to user IDs.
describe("name fields survive the context budget", () => {
  it("keeps authorName on messages and the resolver on interaction outcomes", () => {
    const env = envelope(200, 2000, ["c199"]);
    env.messages = env.messages.map((m) => ({ ...m, authorName: "Pierre Maciel" }));
    env.interactionOutcomes = [{
      id: "i1", kind: "request_confirmation", status: "accepted",
      resolvedByUserId: "u1", resolvedByUserName: "Pierre Maciel", resolvedByAgentId: null,
      result: "x".repeat(200_000),
    }];
    const out = enforceBudget(env, 20 * 1024);
    expect(out.coverage.kind).toBe("truncated_task_history");
    expect(out.messages.map((m) => m.id)).toContain("c199");
    expect(out.messages.every((m) => m.authorName === "Pierre Maciel")).toBe(true);
    expect(out.interactionOutcomes[0]).toMatchObject({
      resolvedByUserId: "u1", resolvedByUserName: "Pierre Maciel", resolvedByAgentId: null,
      result: "[omitted: context budget]",
    });
  });
});
