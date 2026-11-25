// bu-fork: one-click Resume for "Automatic recovery stopped". Upstream offers
// Retry only when the stopped run's adapter accepts a conversation turn, and
// no UI for the reconciliation the resolve endpoint requires otherwise. This
// asks the server whether the stopped run provably changed nothing and, only
// then, submits that evidence to the normal recovery-actions/resolve endpoint.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { requiresExecutionReconciliation, type ExecutionBlocker } from "@paperclipai/shared";
import { buRecoveryApi } from "../api/bu-recovery";
import { issuesApi } from "../api/issues";
import { describeError } from "../api/errors";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export function BuRecoveryResume({ issueId, cacheRefs = [issueId], blocker, canResolve, className }: {
  /** The issue's UUID (not its identifier). */
  issueId: string;
  /** Every id/identifier the page caches this issue under. */
  cacheRefs?: readonly string[];
  blocker: ExecutionBlocker | null | undefined;
  /** Board users who may resolve recovery actions; the server re-checks. */
  canResolve: boolean;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const actionId = blocker?.recoveryActionId ?? null;
  const resume = useMutation({
    mutationFn: async () => {
      setMessage(null);
      const diagnosis = await buRecoveryApi.diagnose(issueId, actionId!);
      if (!diagnosis.safe || !diagnosis.reconciliation) {
        setMessage(diagnosis.reason);
        return false;
      }
      await issuesApi.resolveRecoveryAction(issueId, diagnosis.reconciliation);
      return true;
    },
    onSettled: (resolved) => {
      if (!resolved) return;
      for (const ref of new Set([issueId, ...cacheRefs])) {
        for (const queryKey of [queryKeys.issues.detail(ref), queryKeys.issues.runs(ref),
          queryKeys.issues.liveRuns(ref), queryKeys.issues.activeRun(ref), queryKeys.issues.activity(ref)]) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }
    },
  });
  if (!canResolve || !actionId || !requiresExecutionReconciliation(blocker?.cause)) return null;
  return (
    <div role="group" aria-label="Resume stopped recovery" className={cn("flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground", className)}>
      <span className="min-w-0 flex-1">Automatic recovery stopped. Resume checks that the stopped run changed nothing first.</span>
      <Button variant="outline" size="sm" className="shrink-0" disabled={resume.isPending}
        title="Check whether the stopped run made any change, and resume automatically if it didn't."
        onClick={() => resume.mutate()}>
        {resume.isPending ? "Checking…" : "Resume"}
      </Button>
      {message && <p role="status" className="w-full">{message}</p>}
      {resume.isError && <p role="alert" className="w-full text-destructive">{describeError(resume.error).body}</p>}
    </div>
  );
}
