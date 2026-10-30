# Bu Digital fork: backlog

Open items for `splitpierre/paperclip` (`bu/main`). Plans for larger items live next to this file.

## Requested features (from the fork kickoff, 2026-09-26)

- [ ] Mobile experience needs careful review and testing, some input fields make things unusable in some places
- [ ] **Trello connector.** Boards/lists/cards as a connection agents can use (read cards, create/move
      cards, comment). Decide: app definition + tool connection vs. plugin.

## Planned

- [ ] **Cross-thread awareness for agent conversations**: see `cross-thread-awareness-plan.md`
      (conversations only; ~500 lines, no migration).

## Context compaction: remaining (see `context-compaction-plan.md`)

- [ ] Context meter in task/chat headers (size, message count, "summarized through").
- [ ] Thread divider at the compaction cursor with "view summary / download archive".
- [ ] Company settings for compaction: compactor agent (today `PAPERCLIP_BU_COMPACTION_AGENT` in the
      systemd drop-in), soft threshold (48 KB), hard cap (96 KB).

## WhatsApp channel: small follow-ups

- [ ] Mark messages from **linked** people as read (blue ticks); never for unlinked senders.
- [ ] Title WhatsApp conversations "WhatsApp · <name>" instead of the first message.
- [ ] Optionally hide channel conversations from task lists (show them under the channel / agent chats).
- [x] Images reach the agent as attachments; voice notes are transcribed locally (faster-whisper,
      `scripts/bu/setup-whisper.sh`). Video/documents/stickers still arrive as a placeholder.
- [x] Composer mic button (web chat + task threads): dictate, transcribe locally, review, send.

## Platform fixes found along the way

- [ ] **Claude sign-in stores only the ~8 h access token** (`server/src/services/local-ai-credentials.ts`
      reads `claudeAiOauth.accessToken`, drops the refresh token), so shared Claude connections expire.
      Workaround in use: long-lived token from `claude setup-token` (`/data/tools/claude-long-token.sh`).
      Fix: use `setup-token` in the local sign-in flow, or store and refresh the full OAuth credential.
- [ ] Stranded-task recovery wakes an agent every minute on any assigned task left `in_progress`
      (`recovery/service.ts`, `issue_continuation_needed`). Consider a longer, backed-off interval.
- [ ] **`DELETE /projects/:id` 500s once the project has cost history.** `routes/projects.js:689` deletes
      the `projects` row directly; Postgres rejects it with `cost_events_project_id_projects_id_fk` because
      nothing deletes/reassigns that project's `cost_events` rows first. Hit 2026-09-28 migrating
      `micro-zombies` from Bu Digital to Split Systems (issues deleted fine; the project delete itself
      failed). Worked around by archiving the project instead of deleting it. Fix: either cascade/null out
      `cost_events.project_id` on project delete, or have the route pre-check and return a clear 409
      instead of a raw FK 500.
- [x] 2026-09-28: **Resume button for "Automatic recovery stopped".** `GET /issues/:id/recovery-actions/:actionId/diagnose`
      (`bu-recovery-diagnosis.ts`) proves "this run touched nothing" from its execution workspace (git:
      clean, 0 ahead, no matching remote branch, or no workspace at all) and its log (no tool-call
      markers); safe only when both hold. The UI's "Resume" button (`ExecutionBlockerNotice.tsx`) diagnoses,
      then submits through Paperclip's own `recovery-actions/resolve` — never bypasses it. Unsafe cases show
      the reason and change nothing, same as before.
      - [x] 2026-10-03: **Fixed a dead end found live on BUD-80 and SPL-29.** The diagnosis bailed out
            on any recovery action whose `status !== "active"` — but `execution-blocker.ts`'s own
            predicate (its "effective no-replay hold" comment) keeps surfacing a *resolved/cancelled*
            action as the current blocker when its evidence carries `automaticRecovery.replay ===
            "blocked"`, and the native `recovery-actions/resolve` handler already knows how to reopen
            exactly that action by id. Every such case had no automated path at all — had to resolve
            both by hand through the raw API. `diagnoseRecoveryAction` now recognizes that case and
            runs the normal safety checks on it instead of refusing outright; 3 new tests added
            (reopenable-and-safe, reopenable-but-unverified-side-effects, resolved-with-no-replay-hold).
- [x] 2026-10-12: **Plugin-adapter failures left tasks permanently unresumable (BUD-357; also BUD-365,
      BUD-392, BUD-92, BUD-103).** A Quinn Gemini run hit an Antigravity 429 quota error. Because
      `antigravity_local`/`zai_local` weren't in `CONVERSATION_ADAPTER_TYPES`
      (`conversation-continuation.ts`), the failure wasn't stamped `continue_conversation_v1` and became a
      `legacy_execution_requires_reconciliation` no-replay hold. Every way out failed:
      - Commenting on Quinn: explicit continuation only admits conversation adapters.
      - Reassigning, then commenting: the hold named the old owner's run, so the wait was "source_unavailable".
      - The Resume button: the task shares the dirty BUD-301 release worktree with 44 other tasks.

      Fixes:
      - Both plugin adapters are now conversation adapters.
      - `admitExplicitNativeContinuation` lets a board message hand a legacy hold to a reassigned
        conversation agent. That agent starts a fresh session, and the stop proofs still apply.
      - The Resume diagnosis's tool-call scan never matched any adapter: logs wrap events as escaped
        `chunk` strings, and the Codex and agy markers were missing. It now decodes chunks and knows
        `acpx.tool_call` and `"step_type":"tool"`.

      Existing stuck tasks resume with a fresh board comment after deploy.
- [x] 2026-10-30: **Filesystem sandbox never started on merged-/usr hosts.** `filesystemScope: "workspace"`
      always created `/bin`, `/sbin`, `/lib` and `/lib64` as symlinks, then bind-mounted the same paths over
      them before `/usr` existed, so bwrap died with `Can't bind mount /oldroot/usr/bin on /newroot/bin`
      (found on Harvey's first run, BUD-641). `local-process-sandbox.ts` now mirrors the host: a symlink stays
      a symlink, a real directory gets bound. Host setup, not tracked in this repo: Ubuntu 24.04 also needs
      `/etc/apparmor.d/bwrap` allowing `userns` for `/usr/bin/bwrap`, or bwrap fails on the uid map.
      Run the real-sandbox tests with `PAPERCLIP_TEST_BWRAP=/usr/bin/bwrap` (a path, not a flag).
- [x] 2026-10-30: **Managed Claude agents could not load any skill.** Managed AI connections run with
      `--setting-sources user` (keeps a repo's project settings away from managed credentials), which also
      makes Claude ignore `.claude/skills` under `--add-dir`, so the `Skill` tool answered "Unknown skill" for
      everything. `prepareClaudePromptBundle` now makes the bundle a plugin and managed runs pass `--plugin-dir`;
      that loads skills without enabling project settings. Skills appear as `paperclip:<runtime-name>`.
      Sandboxed runs also mount each skill's source read-only, since the bundle's skills are symlinks.
      Not covered: the ACP engine, which no BUD agent uses (all `engine: "cli"`).
- [ ] **DB connection leak: `listPendingFinalizeBlockerIssueIds` (`server/src/services/issues.ts:2367`).**
      2026-09-27: 10 connections stuck `idle in transaction` for 38+ min, all mid the exact same
      `workspace_operations` query (Postgres state `ClientRead` — it already answered; the app just never
      sent COMMIT), all opened within ~1s of each other. Exhausted the whole pool and took the server down
      (even `/api/health` hung). Called from `listIssueDependencyReadinessMap`, used on ~every agent wake
      (`heartbeat.ts:19933`) and issue-listing endpoints — the simultaneous cluster of 10 points at a batch
      wake/recovery sweep where something *after* this query, inside the same transaction, hangs forever.
      Not yet caught live (cleared it by killing the connections before catching the exact hang point).
      Mitigation proposed, not yet applied: set `idle_in_transaction_session_timeout` (e.g. 5 min) on the
      Paperclip DB role so this can't repeat as a full outage. Still open: reproduce with query logging and
      find the actual hung step.

## Housekeeping

- [ ] Retire the old WhatsApp plugin: uninstall `budigital.whatsapp-channel`, remove worktree
      `/data/projects/_worktrees/whatsapp-channel-v2`, close BUD-51/BUD-59, archive the plugin package in
      `bu-paperclip-adapters`.
- [ ] Remove unused AI connections ("My Claude subscription", "Bu Digital Anthropic Acc" personal,
      "My OpenAI subscription") once nothing references them.
- [ ] Turn sign-up off again after member testing (`auth.disableSignUp: true` in the instance config).
- [x] 2026-10-03: **Rebased `bu/main` onto `v2026.1001.0`** (from `v2026.916.1`). 11 real conflicts
      across 6 files hand-resolved (migration numbering, `app-definitions.generated.ts`, `pnpm-lock.yaml`,
      `server-utils.ts` prompt wording, `execution-continuation.ts` imports, `ExecutionBlockerNotice`
      Resume-vs-Inspect-run, `ChatEndpointSetup` identity guidance, `chat-channels.ts` ×3); everything
      else auto-merged. Found and fixed two real upstream bugs hit live during the rollout, both now
      part of the fork:
      - `setup-token-session.ts`: `toCleanupRecord` maps a null `providerLeaseId` to `""`; the reaper
        then called `releaseById("")` every sweep forever, throwing `invalid input syntax for type
        uuid` on `environment_leases` every heartbeat tick and leaving 21 orphaned login sessions
        stuck. Now skips the release call when there's no real lease to release.
      - `cli/src/commands/service.ts`: `waitForHealth` required `/api/health`'s `serverVersion` to
        match post-restart, but that field is redacted from any unauthenticated caller — including
        this CLI's own loopback probe — once `deploymentMode` is `"authenticated"`. Every
        `paperclipai update` on this (private) instance timed out at 60s and rolled back no matter
        how healthy the new version was. Now accepts a withheld (null) version as healthy; still
        rejects an explicit mismatch.
      - Also found (systemd-config, not a code fix): `KillMode=control-group` sent the stop signal to
        the embedded Postgres child at the same instant as the app, racing the app's own ordered
        shutdown (which stops Postgres last) now that `v2026.1001.0` added more shutdown-time sweeps.
        Fixed locally via a `KillMode=mixed` drop-in; not yet decided whether to document this as a
        required local setup step or report it upstream.
      - One pre-existing stale migration-tracking row needed a manual `INSERT` into
        `drizzle.__drizzle_migrations` to mark the fork's renumbered `0284` migration as applied
        without re-running it (its effects — `issue_context_compactions`, the whatsapp provider-check
        entries — already existed on this DB from before the renumbering; verified byte-for-byte
        structural match first).
- [x] 2026-10-05: **`claude_local`'s model picker was missing Claude Opus 5.5 / Sonnet 5.5.** The
      adapter ships a hardcoded model catalog (`packages/adapters/claude-local/src/index.ts`) with no
      live-discovery hook (`listModels`/`refreshModels` unimplemented), so the UI's "refresh" button is
      a no-op for this adapter — new Anthropic releases only show up after a source update + redeploy.
      Used Paperclip's own sanctioned override instead of waiting on that: `PAPERCLIP_ADAPTER_MODELS`
      (JSON map of adapter type → model list, read on every request, no restart-order dependency) set
      via a new systemd drop-in, `~/.config/systemd/user/paperclipai.service.d/adapter-models.conf` —
      carries the full existing `claude_local` list plus `claude-opus-5-5`/`claude-sonnet-5-5`. **Not
      tracked in this repo or the overlay** — it's a host-local env var drop-in, so it survives
      `paperclipai update`/a reinstall of the npm payload but would need re-creating on a fresh host.
      If a future upstream release adds a live model-discovery hook for `claude_local`, this drop-in
      should be removed rather than left to silently override a now-good default list.
- [ ] Track upstream: rebase `bu/main` onto new release tags; re-run `scripts/bu/overlay-deploy.sh`
      after any `paperclipai update` (the update replaces the overlay).
