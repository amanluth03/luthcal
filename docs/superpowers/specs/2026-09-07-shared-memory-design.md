# Shared memory across channels

Status: approved 2026-09-07 (Aman). Implementation split: senior-backend
(agent side), frontend-design (dashboard page).

## Problem

Two kinds of forgetting, both reported by the family:

1. **Mid-task.** Someone answers the agent's follow-up question and it has
   lost the thread. Level-1 history (`lib/agent/history.ts`) fixed this
   *within* one channel, but the dashboard thread and the iMessage chat are
   separate histories by design, so a conversation started on one is
   invisible on the other.
2. **Across sessions.** Nothing durable survives beyond the calendar itself.
   "Dad means Vijay," "Yash has soccer Tuesdays," "we decided the beach trip
   is the 20th" have to be re-explained every time.

## Goals

- One conversation per family, regardless of channel.
- A small, inspectable store of durable facts the agent reads every turn and
  can write when told to.
- Recall of older conversation on demand.
- Everything visible and editable from the dashboard — memory is a trust
  surface, not a black box.

## Non-goals

- No vector database / embeddings. At four-person scale, recency plus
  keyword search covers recall; pgvector on Neon is available later if it
  ever doesn't.
- No rolling summaries (lossy, invisible).
- No per-person private memory — the family shares one calendar and one
  memory.

## Design

### 1. One family thread (`lib/agent/history.ts`)

`loadRecentThreadHistory` scopes to the family instead of the channel:

```
source = 'dashboard'
OR (source = 'imessage' AND chat_guid = <family chat guid>)
```

where the family chat guid is the run's own `chatGuid` for iMessage runs and
`process.env.FAMILY_CHAT_GUID` for dashboard runs (dashboard-only scope if
that env var is unset). Window: last **30** rows within **7 days**
(`HISTORY_MESSAGE_LIMIT`, `HISTORY_MAX_AGE_MS`).

Attribution: every inbound row is prefixed with the sender's roster name
(falling back to the raw handle), and rows from the *other* channel carry a
tag — `Vijay (via iMessage): …` in a dashboard run, `Aman (via dashboard): …`
in an iMessage run. Outbound rows are plain `assistant` messages.

Dedup against the dashboard's resent history happens on **raw text, before
prefixes are applied**: `loadRecentThreadHistory` returns rows with metadata
(`direction`, `text`, `senderLabel`, `source`); `dedupeHistory` filters by raw
text; a separate `formatHistory(rows, currentSource)` produces the
`ModelMessage[]`. This lets all inbound rows be attributed uniformly without
breaking the exact-match dedup the dashboard relies on.

`loadLastOutboundMessage` (engagement gate) is unchanged.

### 2. Durable memory (`lib/db/schema.ts` `family_memory`, `lib/agent/memory.ts`)

Table (already added to the schema):

| column | type | notes |
|---|---|---|
| id | uuid | |
| content | text | one sentence, human-readable |
| kind | preference \| pattern \| fact \| decision | default fact |
| member_id | uuid? | who it's about, when it's about one person |
| created_by_member_id | uuid? | who told the agent |
| source | imessage \| dashboard? | channel it was saved from |
| created_at, updated_at | timestamptz | |
| archived_at | timestamptz? | soft delete |

`lib/agent/memory.ts`:

- `loadActiveMemories()` → active rows, newest first, capped at 100.
- `formatMemoriesForPrompt(memories, roster)` → the block injected into the
  system prompt, e.g.
  `- [pattern] Yash has soccer every Tuesday 5–6pm (about Yash; from Ekta, Sep 7)`.
  Empty store → a one-line "nothing remembered yet".
- `rememberMemory({ content, kind, memberId, createdByMemberId, source })`
  → inserts; if an active row with identical trimmed, case-folded content
  exists, returns it instead of inserting a duplicate.
- `forgetMemory(id)` → sets `archived_at`.
- `searchHistory({ query, sinceDays = 90 })` → family-thread `message_log`
  rows whose text matches every whitespace-separated term (`ILIKE`), newest
  first, max 20, each with date, sender name, channel, text.

All degrade gracefully (empty / no-op with a console error) when the DB is
unavailable, matching `getFamilyRoster`.

### 3. Agent wiring (`lib/agent/tools.ts`, `lib/agent/index.ts`)

Tools:

- `remember({ content, kind?, memberName? })` — act mode only. `memberName`
  resolves through `matchMember` like event member names; ambiguous →
  `ambiguousMember` result, none → saved without a member.
- `forget({ memoryId })` — act mode only.
- `searchHistory({ query, sinceDays? })` — read-only, available in both modes.

`runAgent` loads memories alongside the roster and injects them into the
system prompt under a "Things the family has asked you to remember" heading.
The `createdByMemberId` for `remember` is the run's resolved sender member.

Prompt guidance (added to "How to operate"):

- Save a memory when someone explicitly asks you to remember something, or
  states a durable scheduling preference, standing pattern, or decision in a
  message addressed to you. Say "I'll remember that" in the reply.
- Don't save one-off events (that's the calendar) or things inferred from
  unaddressed chatter.
- Use `searchHistory` when someone refers to an earlier conversation that
  isn't in the recent turns shown.

### 4. Dashboard (`app/(dashboard)/memory`, `components/memory/*`)

A **Memory** page in the sidebar: a list of active memories showing content,
kind, who it's about, who saved it and when, with inline edit of content and
a delete (archive) action. Follows the Family page's data/mutation pattern.
No create form in the first cut — memories come from conversation; editing
and deleting are the correction surface.

## Tests (`tests/agent/history.test.ts`, `tests/agent/memory.test.ts`)

- History: family scope (both channels, only the family chat's iMessage
  rows), 7-day window, attribution + cross-channel tags, dedup-before-prefix.
- Memory: duplicate `remember` returns the existing row; `forget` archives
  rather than deletes; prompt formatting; `searchHistory` term matching and
  scope.
- Existing tests keep passing; fake-query-builder pattern as in
  `tests/agent/history.test.ts`.

## Rollout

Schema is additive (`npm run db:push`). Small commits per unit: schema,
history, memory module + tools, prompt, dashboard page, docs. `docs/agent-core.md`
gains a "Shared memory" section pointing here.
