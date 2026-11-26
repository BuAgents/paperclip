// bu-fork: every chat provider must be accepted by the database's provider checks.
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { CHAT_PROVIDERS } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat provider database constraints", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-chat-provider-checks-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => {
    await database?.cleanup();
  });

  it.each(["chat_endpoints_provider_check", "chat_external_principals_provider_check"])("%s allows every provider", async (name) => {
    const rows = await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`);
    const def = String((rows as unknown as Array<{ def: string }>)[0]?.def ?? "");
    for (const provider of CHAT_PROVIDERS) expect(def).toContain(`'${provider}'`);
  });
});
