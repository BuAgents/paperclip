-- bu-fork: native WhatsApp chat channel. Idempotent on purpose: the live fork
-- database already has these objects from its renumbered fork migration
-- (0284_bu_fork_whatsapp_and_compaction, whose hash no longer maps to a file),
-- while fresh databases get them here. 0324 is also patched to keep
-- 'whatsapp' when it recreates the checks, so it does not fail on existing rows.
ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp'));--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'whatsapp'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_endpoints_whatsapp_number_uq" ON "chat_endpoints" USING btree ("bot_external_id") WHERE "chat_endpoints"."provider" = 'whatsapp' and "chat_endpoints"."status" <> 'archived' and "chat_endpoints"."bot_external_id" is not null;
