# Cross-thread awareness for agent conversations (Bu Digital fork)

Status: **planned, not implemented** (2026-09-26). Fork: `splitpierre/paperclip`, branch `bu/main`.
Estimated effort: ~500 lines (mostly new files), about half a day including tests and deploy. Low risk: additive only, no DB migration.

## Goal

A person can talk to the same agent in several separate conversations: the web Agent Chat
(`/BUD/chats/<agent>`), a WhatsApp DM, other channel DMs, groups. Each stays its own session
(`/new` and `/compact` are per thread), but the agent should **know the other threads exist** and
**look one up when the current message needs it** ("like I said on WhatsApp…"), cheaply.

Scope: **conversations only** (web Agent Chat + native channel conversations). Ordinary work tasks
are out of scope; the agent can still list tasks through the normal API when asked.

## How conversations exist today (verified in code)

- **Web Agent Chat**: one conversation issue per (agent, user): `issues.conversationAgentId` +
  `issues.conversationUserId`, created by `GET|POST /companies/:companyId/chats/:agentRef`
  (`server/src/routes/issues.ts`). `/new` bumps `conversationSessionGeneration` inside the same issue.
- **Native channels** (Slack, Telegram, iMessage, WhatsApp): `chat_conversations` rows, each bound to
  an ordinary issue (`issues.originKind = "chat_channel"`), one per external conversation (DM or
  group). Inbound messages are added as comments **authored by the linked Paperclip user**
  (`taskUserId` in `chat-channels.ts`), so the person behind a channel turn is the comment author.
  Groups are `chat_conversations.isDirectMessage = false`.
- Chat turns reach the agent through the wake payload built in `buildPaperclipWakePayload`
  (`server/src/services/heartbeat.ts`) and rendered by `renderPaperclipWakePrompt`
  (`packages/adapter-utils/src/server-utils.ts`).
- Compaction summaries (`issue_context_compactions`, `bu-context-compaction.ts`) give a cheap
  digest of long threads.

## Design

### 1. Thread directory on every chat turn

When a chat turn is built for agent **A** and the human **U** of that turn, add a
`conversationDirectory` to the wake payload: U's *other* active conversations with A.

- **Who is U**: web Agent Chat → `issue.conversationUserId`; channel conversation → `authorUserId`
  of the wake's triggering comment (the linked user). No U (unlinked guest, system) → no directory.
- **Which threads**: issues where either
  - `conversationAgentId = A and conversationUserId = U` (web chat), or
  - bound by `chat_conversations` with `isDirectMessage = true` to an endpoint whose
    `assignedAgentId = A`, and whose latest human comment is by U;
  excluding the current issue, excluding `done`/`cancelled`, most recent 8 by last activity.
- **Entry**: `{ issueId, identifier, channel ("web" | provider), title, lastActivityAt,
  gist }` where `gist` is the first line of the latest ready compaction summary (≤ 160 chars) or null.
- **Privacy**: if the current turn is a **group** conversation, send **no directory** (another group
  member must never be able to steer the agent into private threads). Group threads themselves are
  never listed (they are not 1:1 with U).
- Size budget: ≤ ~600 bytes rendered.

Prompt section (rendered only when the directory is non-empty):

```
## Other conversations with this person
You also talk with this person in other threads. They are separate sessions; do not assume
they share memory with this one. Use them only when the current message needs it.
- WhatsApp · BUD-60 "hey" · active 2h ago · Gist: …
- Web chat · BUD-58 "Chat with Ária Opus" · active yesterday
To read one: GET /api/agents/me/conversations/{issueId}/context (summary first, then recent
messages). Never replay a whole thread; never quote another thread into a group chat.
```

### 2. Read endpoint (enforced same-person rule)

`GET /api/agents/me/conversations/:issueId/context?limit=12` (agent auth, run-scoped JWT).

- Allowed only if the target issue is a conversation (web chat or channel DM) of the **same agent**
  and the **same human** as the caller's current run's conversation (resolved server-side from the
  run's `contextSnapshot.issueId`, never from request parameters). Group runs → 403.
- Returns `{ identifier, channel, title, summary (latest ready compaction or null),
  messages: last N comments after the summary cursor (author label, time, body ≤ 2 000 chars each) }`.
- Read-only; logs an activity row (`conversation.cross_thread_read`) for auditability.

### 3. Agent guidance

Lives in the prompt section above (no agent instruction files change): when to look, summary first,
small `limit`, never cross-post into groups.

## Implementation

| Piece | Where | Size |
|---|---|---|
| Directory query + person resolution + group rule | new `server/src/services/bu-thread-directory.ts` | ~120 lines |
| Add `conversationDirectory` to the wake payload (chat turns only) | `heartbeat.ts` `buildPaperclipWakePayload`, marked `bu-fork` hunk | ~20 lines |
| Normalize + render the section | `packages/adapter-utils/src/server-utils.ts` (payload type, normalizer, renderer), marked hunks | ~40 lines |
| Read endpoint | new `server/src/routes/bu-conversations.ts`, mounted in `app.ts` next to `buCompactionRoutes` | ~100 lines |
| Tests | `bu-thread-directory.test.ts` (embedded Postgres: web + WhatsApp DM + group, other user, done threads excluded, group turn → none), route test (same person allowed; other person, other agent, group → 403), renderer test | ~200 lines |

Deploy with `scripts/bu/overlay-deploy.sh` (server + adapter-utils dist files only; no migration, no UI).

## Acceptance

1. In a WhatsApp DM with Ária, "what did I ask you on the web today?" → she lists/uses the web chat
   via the endpoint, reading the summary or a few recent messages, and answers briefly.
2. In a WhatsApp group, the prompt has no directory, and the endpoint refuses cross-thread reads.
3. Another person's threads never appear in the directory, and the endpoint refuses them.
4. A normal chat turn grows by ≤ ~600 bytes; no extra runs or wakes.

## Later (not in scope)

- UI: show "also talking on WhatsApp · BUD-60" in the web chat header.
- Optional task list in the directory ("recent tasks with this person"), off by default.
