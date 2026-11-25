import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "./server-utils.js";
import { createPromptContextFixture } from "./test-fixtures/prompt-context.js";

// bu-fork: the prompt explains a history truncated by the server's size budget.
describe("truncated_task_history prompt", () => {
  it("tells the agent the oldest messages were left out", () => {
    const { paperclipWake } = createPromptContextFixture();
    const { resumeDelta: _delta, ...continuation } = paperclipWake.executionContinuation;
    const prompt = renderPaperclipWakePrompt({
      ...paperclipWake,
      executionContinuation: {
        ...continuation,
        coverage: { ...continuation.coverage, kind: "truncated_task_history", omittedMessageCount: 7 },
      },
    });
    expect(prompt).toContain("except for the 7 oldest messages, left out by the context budget");
    expect(prompt).not.toContain("History is complete through the coverage cursor. Prefer");
  });

  it("keeps the upstream wording for full history", () => {
    const { paperclipWake } = createPromptContextFixture();
    const prompt = renderPaperclipWakePrompt(paperclipWake);
    expect(prompt).toContain("History is complete through the coverage cursor. Prefer source messages over summaries.");
  });
});
