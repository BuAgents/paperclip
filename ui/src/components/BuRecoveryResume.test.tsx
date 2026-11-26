// @vitest-environment jsdom
// bu-fork: Resume (diagnose, then resolve through the normal endpoint only if safe).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionBlocker } from "@paperclipai/shared";
import { BuRecoveryResume } from "./BuRecoveryResume";
import { buRecoveryApi } from "../api/bu-recovery";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

vi.mock("../api/bu-recovery", () => ({ buRecoveryApi: { diagnose: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { resolveRecoveryAction: vi.fn() } }));

const blocker: ExecutionBlocker = {
  recoveryActionId: "recovery", runId: "failed-run", agentId: "agent",
  cause: "legacy_execution_requires_reconciliation", nextAction: "Reconcile the previous execution.",
};
const button = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Resume");

describe("BuRecoveryResume", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(() => {
    vi.mocked(buRecoveryApi.diagnose).mockReset();
    vi.mocked(issuesApi.resolveRecoveryAction).mockReset();
    client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = async (props: Partial<Parameters<typeof BuRecoveryResume>[0]> = {}) => {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <BuRecoveryResume issueId="task" blocker={blocker} canResolve {...props} />
    </QueryClientProvider>));
  };
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

  it("offers Resume for a reconciliation-required blocker", async () => {
    await render();
    expect(button(container)).toBeDefined();
  });
  it.each([
    ["no recovery action", { blocker: { ...blocker, recoveryActionId: null } }],
    ["a non-reconciliation cause", { blocker: { ...blocker, cause: "workspace_validation_failed" } }],
    ["a viewer who cannot resolve", { canResolve: false }],
    ["no blocker", { blocker: null }],
  ])("renders nothing for %s", async (_label, props) => {
    await render(props as never);
    expect(container.textContent).toBe("");
  });
  it("resolves with the diagnosis evidence and refreshes every cached ref when safe", async () => {
    const reconciliation = {
      actionId: "recovery", outcome: "restored" as const, sourceIssueStatus: "todo" as const, resolutionNote: "note",
      executionReconciliation: { runId: "failed-run", providerStopped: true as const, actionOutcome: "not_performed" as const, outcomeEvidence: "note" },
    };
    vi.mocked(buRecoveryApi.diagnose).mockResolvedValue({ safe: true, reason: "clean", reconciliation });
    vi.mocked(issuesApi.resolveRecoveryAction).mockResolvedValue({ issue: { status: "todo" } } as never);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await render({ cacheRefs: ["task", "BUD-1"] });
    await act(async () => button(container)!.click());
    await flush();
    expect(buRecoveryApi.diagnose).toHaveBeenCalledWith("task", "recovery");
    expect(issuesApi.resolveRecoveryAction).toHaveBeenCalledWith("task", reconciliation);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.detail("BUD-1") });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("shows the reason and never resolves when unsafe", async () => {
    vi.mocked(buRecoveryApi.diagnose).mockResolvedValue({ safe: false, reason: "the workspace has uncommitted changes" });
    await render();
    await act(async () => button(container)!.click());
    await flush();
    expect(issuesApi.resolveRecoveryAction).not.toHaveBeenCalled();
    expect(container.textContent).toContain("the workspace has uncommitted changes");
    expect(button(container)!.disabled).toBe(false);
  });
  it("shows a failed resolve as an alert", async () => {
    vi.mocked(buRecoveryApi.diagnose).mockRejectedValue(new Error("Board access required"));
    await render();
    await act(async () => button(container)!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
