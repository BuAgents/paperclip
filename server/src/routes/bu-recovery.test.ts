// bu-fork: authz of the recovery-stopped diagnosis route.
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const decide = vi.hoisted(() => vi.fn());
const diagnose = vi.hoisted(() => vi.fn());
vi.mock("../services/access.js", () => ({ accessService: () => ({ decide }) }));
vi.mock("../services/bu-recovery-diagnosis.js", () => ({ diagnoseRecoveryAction: diagnose }));

const issueId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const issue = { id: issueId, companyId: "company-1", projectId: null, parentId: null,
  assigneeAgentId: null, assigneeUserId: null, status: "blocked" };

let modules: [typeof import("../middleware/index.js"), typeof import("./bu-recovery.js")];
async function createApp(actor: Record<string, unknown>, rows: unknown[] = [issue]) {
  const [{ errorHandler }, { buRecoveryRoutes }] = modules;
  const db = { select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }) };
  const app = express();
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", buRecoveryRoutes(db as never));
  app.use(errorHandler);
  return app;
}
const board = { type: "board", userId: "user-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false };
const path = `/api/issues/${issueId}/recovery-actions/${actionId}/diagnose`;

describe("bu recovery diagnosis route", () => {
  beforeAll(async () => {
    modules = await Promise.all([import("../middleware/index.js"), import("./bu-recovery.js")]);
  }, 120_000);
  beforeEach(() => {
    decide.mockReset().mockResolvedValue({ allowed: true });
    diagnose.mockReset().mockResolvedValue({ safe: false, reason: "r" });
  });
  it("diagnoses for a board member of the issue's company with issue read access", async () => {
    const res = await request(await createApp(board)).get(path);
    expect(res.status).toBe(200);
    expect(diagnose).toHaveBeenCalledWith(expect.anything(), { companyId: "company-1", issueId, actionId });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
  });
  it("refuses agents", async () => {
    const res = await request(await createApp({ type: "agent", agentId: "a", companyId: "company-1" })).get(path);
    expect(res.status).toBe(403);
    expect(diagnose).not.toHaveBeenCalled();
  });
  it("answers 404 for another company's issue, without an existence oracle", async () => {
    const res = await request(await createApp({ ...board, companyIds: ["company-2"] })).get(path);
    expect(res.status).toBe(404);
    expect(diagnose).not.toHaveBeenCalled();
  });
  it("refuses when issue read access is denied", async () => {
    decide.mockResolvedValue({ allowed: false, explanation: "private", reason: "deny_issue_private" });
    const res = await request(await createApp(board)).get(path);
    expect(res.status).toBe(403);
    expect(diagnose).not.toHaveBeenCalled();
  });
  it("answers 404 for non-UUID ids", async () => {
    const res = await request(await createApp(board)).get(`/api/issues/BUD-1/recovery-actions/${actionId}/diagnose`);
    expect(res.status).toBe(404);
    expect(diagnose).not.toHaveBeenCalled();
  });
});
