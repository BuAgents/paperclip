/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** bu-fork: display name of the author (user from the company directory, or agent); null when unknown. */
    authorName?: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
  }>;
  /** Only direct human resolutions, projected from server-owned resolver columns. */
  humanResponses?: Array<{
    id: string;
    kind: string;
    status: string;
    resolvedByUserId: string;
    /** bu-fork: display name from the company user directory; null when unknown or no longer a member. */
    resolvedByUserName?: string | null;
    resolvedAt: string;
    result: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    /** bu-fork: who resolved it. A user resolver carries a name; an agent resolver never does. */
    resolvedByUserId?: string | null;
    resolvedByUserName?: string | null;
    resolvedByAgentId?: string | null;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  /**
   * bu-fork: digest of the messages up to `throughCommentId`, written by a
   * separate compaction run. Those messages are left out of `messages`
   * (except the ones that triggered this wake); the full thread stays in the API.
   */
  summary?: {
    compactionId: string;
    markdown: string;
    throughCommentId: string;
    summarizedMessageCount: number;
  };
  coverage: {
    kind: "full_task_history" | "task_history_delta" | "summarized_task_history" | "truncated_task_history";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: string | null;
    /** bu-fork: older messages dropped by the size safety net (not covered by a summary). */
    omittedMessageCount?: number;
  };
}
