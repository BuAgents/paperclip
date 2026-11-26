// bu-fork: "Automatic recovery stopped" has no one-click action upstream.
// Read-only diagnosis; the actual resolve still goes through Paperclip's own
// POST /issues/:id/recovery-actions/resolve (see services/bu-recovery-diagnosis.ts).
import { Router } from "express";
import { issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { diagnoseRecoveryAction } from "../services/bu-recovery-diagnosis.js";
import { assertBoard, getAccessibleResource } from "./authz.js";

export function buRecoveryRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.get("/issues/:id/recovery-actions/:actionId/diagnose", async (req, res) => {
    // Board only: the diagnosis exposes workspace paths and git state, and the
    // resolve it prepares is itself board-only for reopened no-replay holds.
    assertBoard(req);
    const uuid = z.string().guid();
    if (!uuid.safeParse(req.params.id).success || !uuid.safeParse(req.params.actionId).success) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const issue = await getAccessibleResource(req, res, db.select().from(issues)
      .where(eq(issues.id, req.params.id as string)).then(rows => rows[0] ?? null), "Issue not found");
    if (!issue) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue", companyId: issue.companyId, issueId: issue.id, projectId: issue.projectId,
        parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId, status: issue.status,
      },
      scope: {
        issueId: issue.id, projectId: issue.projectId, parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
      },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    const diagnosis = await diagnoseRecoveryAction(db, {
      companyId: issue.companyId,
      issueId: issue.id,
      actionId: req.params.actionId as string,
    });
    res.json(diagnosis);
  });

  return router;
}
