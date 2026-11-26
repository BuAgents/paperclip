import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// bu-fork: the live fork database (v2026.1001.0 + fork migration) already holds
// chat rows with provider = 'whatsapp' and provider checks that include it.
// Upstream 0324 drops and recreates those checks; it must keep 'whatsapp' or
// the upgrade fails half-way. This rebuilds that pre-upgrade state, re-runs
// the migrations that touch those checks, and checks the rows survive.
const FORK_ERA_PROVIDERS = "'slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon', 'whatsapp'";

// 0324-0330 are the upstream chat/voice stage that upstream itself re-runs in
// speko-voice-migration.test.ts; only 0324 and the fork migration touch the
// provider checks. Later upstream migrations are not all re-runnable, and do
// not touch these tables' provider checks.
async function providerCheckMigrations(): Promise<string[]> {
  const files = await readdir(new URL("./migrations/", import.meta.url));
  return files.filter((name) =>
    name.endsWith(".sql") && ((Number(name.slice(0, 4)) >= 324 && Number(name.slice(0, 4)) <= 330) || /^\d{4}_bu_/.test(name)));
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("bu-fork WhatsApp chat provider upgrade", () => {
  it("migrates a database that already has whatsapp chat endpoints and principals", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-bu-whatsapp-upgrade-");
    const sql = postgres(database.connectionString, { max: 1 });
    try {
      for (const table of ["chat_endpoints", "chat_external_principals"]) {
        await sql.unsafe(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_provider_check`);
        await sql.unsafe(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_provider_check CHECK (provider in (${FORK_ERA_PROVIDERS}))`);
      }
      await sql`DROP INDEX IF EXISTS chat_endpoints_whatsapp_number_uq`;
      await sql`CREATE UNIQUE INDEX chat_endpoints_whatsapp_number_uq ON chat_endpoints (bot_external_id) WHERE provider = 'whatsapp' and status <> 'archived' and bot_external_id is not null`;

      const company = randomUUID(), agent = randomUUID(), application = randomUUID(), connection = randomUUID();
      const endpoint = randomUUID(), principal = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Existing company', 'OLD')`;
      await sql`INSERT INTO agents (id, company_id, name, role, status, adapter_type) VALUES (${agent}, ${company}, 'Existing agent', 'general', 'idle', 'process')`;
      await sql`INSERT INTO tool_applications (id, company_id, application_key, name, type, status) VALUES (${application}, ${company}, 'whatsapp', 'WhatsApp', 'chat', 'active')`;
      await sql`INSERT INTO tool_connections (id, company_id, application_id, name, uid, connection_purpose, transport, status, enabled) VALUES (${connection}, ${company}, ${application}, 'Existing WhatsApp', 'whatsapp/existing', 'channel', 'chat_sdk', 'active', true)`;
      await sql`INSERT INTO chat_endpoints (id, company_id, connection_id, provider, public_id, assigned_agent_id, status, bot_external_id) VALUES (${endpoint}, ${company}, ${connection}, 'whatsapp', ${randomUUID()}, ${agent}, 'active', '5511999990000')`;
      await sql`INSERT INTO chat_external_principals (id, company_id, provider, provider_account_id, external_id) VALUES (${principal}, ${company}, 'whatsapp', '5511999990000', '5511988887777@s.whatsapp.net')`;

      // Mark them as not yet applied, as on the live fork DB.
      const pending = await providerCheckMigrations();
      expect(pending).toContain("0324_long_franklin_storm.sql");
      for (const name of pending) {
        const migration = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
        const hash = createHash("sha256").update(migration).digest("hex");
        await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      }

      await applyPendingMigrations(database.connectionString);

      expect(await sql`SELECT provider, bot_external_id FROM chat_endpoints WHERE id = ${endpoint}`)
        .toEqual([{ provider: "whatsapp", bot_external_id: "5511999990000" }]);
      expect(await sql`SELECT provider FROM chat_external_principals WHERE id = ${principal}`)
        .toEqual([{ provider: "whatsapp" }]);
      for (const name of ["chat_endpoints_provider_check", "chat_external_principals_provider_check"]) {
        const [constraint] = await sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ${name}`;
        expect(constraint.definition).toContain("'whatsapp'");
        expect(constraint.definition).toContain("'speko'");
      }
      expect(await sql`SELECT to_regclass('chat_endpoints_whatsapp_number_uq') AS name`)
        .toEqual([{ name: "chat_endpoints_whatsapp_number_uq" }]);
      // Upstream providers added after the fork base still work.
      await sql`UPDATE chat_endpoints SET provider = 'speko' WHERE id = ${endpoint}`;
      await sql`UPDATE chat_endpoints SET provider = 'whatsapp' WHERE id = ${endpoint}`;
      await expect(sql`UPDATE chat_endpoints SET provider = 'not-a-provider' WHERE id = ${endpoint}`)
        .rejects.toMatchObject({ code: "23514" });

      // Re-running the same migrations (renumbered hashes, retries) stays clean.
      await applyPendingMigrations(database.connectionString);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 180_000);
});
