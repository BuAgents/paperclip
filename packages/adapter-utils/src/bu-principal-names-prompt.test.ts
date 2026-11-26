import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "./server-utils.js";

// bu-fork (BUD-1135): human names next to user IDs.
describe("renderPaperclipWakePrompt comment author names", () => {
  it("labels comment authors with their display name and falls back to the ID", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: { id: "issue-1", status: "in_progress", workMode: "standard" },
      comments: [
        { id: "c1", body: "Ship it.", createdAt: "2026-11-25T10:00:00Z", author: { type: "user", id: "user-1", name: "Pierre Maciel" } },
        { id: "c2", body: "Wait.", createdAt: "2026-11-25T10:01:00Z", author: { type: "user", id: "user-2", name: null } },
        { id: "c3", body: "Done.", createdAt: "2026-11-25T10:02:00Z", author: { type: "agent", id: "agent-1", name: "Builder" } },
      ],
      commentWindow: { requestedCount: 3, includedCount: 3, missingCount: 0 },
      fallbackFetchNeeded: false,
    });
    expect(prompt).toContain("by user Pierre Maciel (user-1)");
    expect(prompt).toContain("by user user-2\n");
    expect(prompt).toContain("by agent Builder (agent-1)");
  });
});
