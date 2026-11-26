// bu-fork: "Automatic recovery stopped" — diagnose, then resolve through
// Paperclip's own recovery-actions/resolve endpoint (issuesApi.resolveRecoveryAction).
import { api } from "./client";

export interface RecoveryDiagnosis {
  safe: boolean;
  reason: string;
  reconciliation?: {
    actionId: string;
    outcome: "restored";
    sourceIssueStatus: "todo";
    resolutionNote: string;
    executionReconciliation: {
      runId: string;
      providerStopped: true;
      actionOutcome: "not_performed";
      outcomeEvidence: string;
    };
  };
}

export const buRecoveryApi = {
  diagnose: (issueId: string, actionId: string) =>
    api.get<RecoveryDiagnosis>(`/issues/${issueId}/recovery-actions/${actionId}/diagnose`),
};
