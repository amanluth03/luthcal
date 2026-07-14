# agent-core design note

Owner: senior-backend. Covers `lib/agent/`, `lib/google/`, `app/api/chat/`, `app/api/webhooks/google/`.

## 1. NLU approach

There is no separate NLU step — the tool-calling LLM (Claude, via the AI SDK v6
tool loop) *is* the parser. `lib/agent/index.ts`'s `runAgent()` builds a system
prompt containing:

- the current date/time, pre-formatted in `FAMILY_TZ` (`formatNowForPrompt`),
  so the model resolves "next Friday" / "tomorrow at 3" against the right
  "now" without ever touching server-local time;
- the family roster (`family_members.name` + `.aliases`, fetched via
  `getDb()`), so the model maps "Maya" / "the dentist for Kai" to a
  `family_members.id` instead of inventing one;
- a short operating policy (ask instead of guessing on genuine ambiguity;
  always re-check conflicts after a create/move; keep replies short).

The model then free-form calls the six tools in `lib/agent/tools.ts`
(`createEvent`, `updateEvent`, `deleteEvent`, `listEvents`, `checkConflicts`,
`sendGroupMessage`) with zod-validated, already-resolved ISO 8601 arguments.
`lib/google` never sees natural language — by the time a tool executes, "next
Tuesday at 3pm" is already `"2026-07-14T15:00:00-05:00"` (or the bare
wall-clock form below).

**Accepted ISO shapes** (`lib/google/time.ts` `parseFlexibleISO`): a string
with an explicit offset/`Z` is parsed as an absolute instant; a bare
`"2026-07-14T15:00:00"` (no offset) is treated as *that wall-clock time in
`FAMILY_TZ`* via `date-fns-tz`'s `fromZonedTime`. Both are supported because
requiring the model to always compute a correct UTC offset is an easy place
for it to make an off-by-one mistake; letting it emit a bare local time when
unsure is strictly safer.

**All-day exclusive-end convention.** All-day `startISO`/`endISO` follow
Google Calendar's own convention exactly: `endISO` is the *exclusive* end
boundary — one calendar day past the last day the event covers. A one-day
all-day event therefore has `endISO` exactly one day after `startISO`. This
is called out explicitly in the `endISO` tool-parameter description (see
`lib/agent/tools.ts`) because it's the opposite of how people phrase "an
all-day event on Tuesday" (inclusive) — without the explicit instruction the
model would reliably get this wrong.

Model: AI Gateway string `"anthropic/claude-sonnet-5"`, resolved by the AI
SDK's built-in global provider (no explicit `gateway(...)` import needed;
`AI_GATEWAY_API_KEY` / Vercel OIDC supplies auth). `generateText` is called
directly (not the `ToolLoopAgent` class) because the system prompt and tool
context (roster, current time, `createdVia`, destination chat) are rebuilt
per-request from the DB/env rather than fixed at agent-definition time.

## 2. Orchestration flow

```
inbound (iMessage webhook or dashboard chat)
  -> runAgent({ messages, source, chatGuid?, senderHandle? })
       -> log inbound to message_log (best-effort; degrades to a no-op if DATABASE_URL isn't set)
       -> build system prompt (roster + now + policy)
       -> generateText({ model, system, messages, tools, stopWhen: stepCountIs(8) })
            tool loop: model calls createEvent/updateEvent/deleteEvent/listEvents/checkConflicts/sendGroupMessage
              as many times as needed (each execute() hits lib/google directly)
       -> deterministic conflict safety net (see below)
       -> log outbound (the reply) to message_log
       -> return { reply, actions }
  -> caller delivers `reply`:
       - app/api/chat/route.ts: returns it as JSON to the dashboard directly.
       - BlueBubbles webhook (backend-dev): enqueues `reply` via lib/agent/outbound.ts
         `enqueueOutbound(chatGuid, reply)` so it lands back in the group chat.
```

8 steps (`stepCountIs(8)`) is enough for parse -> create -> checkConflicts ->
reply, or a two-part request ("move X and add Y"), without letting a
confused model loop indefinitely.

**`source` drives two things, deterministically — never something the model
chooses:**
- `event_meta.created_via` for anything the tools write (`createEvent`'s
  `createdVia: ctx.source`), which in turn feeds the announcement rule below.
- the destination chat for `sendGroupMessage` (`ctx.chatGuid`, falling back to
  `FAMILY_CHAT_GUID`).

**Deterministic conflict safety net.** The system prompt instructs the model
to call `checkConflicts` after every `createEvent`/`updateEvent` with members
assigned, but prompt-following isn't guaranteed, and a missed conflict means a
double-booking nobody found out about. `runAgent` re-runs `checkConflicts`
itself (server-side, read-only, idempotent — cheap even if redundant) for
every create/update action from that turn, and appends a `⚠️`-prefixed
warning to the reply if it finds one. It skips appending only if the reply
already contains a `⚠️` — a best-effort heuristic for "the model already
surfaced this," not a semantic check. **Known limitation:** if a single turn
creates two events and the model only mentioned a conflict for one of them,
this heuristic won't add the second warning (any `⚠️` suppresses all
appending for that reply). Given family-calendar usage patterns (one event
per message, essentially always), this is an acceptable v1 trade-off, but
flagging it for tech-lead: a stricter version would match warnings to
specific events by title rather than gating on emoji presence.

## 3. Announcement / digest / reminder triggers

All three read/write `event_meta` (`announced_at`, `reminded_at`) for
dedup, per CLAUDE.md's convention that a repeated sweep sends nothing.

### Announcements

| Trigger | `announced_at` at creation | Who announces |
|---|---|---|
| `createdVia: "imessage"` (agent, from the group chat) | set to `now()` immediately in `createEvent` | The agent's own reply text, in the same turn — it's *already* in the group chat, so no separate send is needed. |
| `createdVia: "dashboard"` (agent, from the web dashboard) | left `null` | Nobody in the group chat saw the dashboard interaction. Async: backend-dev's announce-sweep cron calls `listPendingAnnouncements()`, formats a message per event (via `getEvent`), enqueues it, then calls `markAnnounced(googleEventId)`. |
| `createdVia: "calendar_app"` (a family member added an event directly in a calendar app) | left `null` | Detected by the Google webhook sync (`lib/google/watch.ts` `upsertEventMetaFromGoogleEvent`) the first time it sees a Google event with no `luthcalCreatedVia` tag. Picked up by the same announce-sweep cron as above. |

Dedup: `announced_at IS NULL` is the entire queue; `markAnnounced` sets it,
so a repeated sweep finds nothing left to send.

**v1 limitation:** only *new* calendar-app events trigger an announcement.
Edits/deletes made directly in a calendar app get synced into `event_meta`
(memberIds refreshed, or the row deleted) but don't produce a new
announcement — flagged as a v2 follow-up, not built here.

**v1 limitation:** edits/deletes made via the agent (`updateEvent`/
`deleteEvent`) don't touch `announced_at` at all — the same "the reply *is*
the announcement" logic applies for `imessage`-sourced calls, but a
dashboard-sourced edit currently has no async-announce equivalent. Worth a
decision from tech-lead on whether v1 needs it; not built pending that call.

### Reminders

`lib/google/events.ts` exports `listUpcomingEventsPendingReminder(withinMs)`
(events starting within `withinMs` with `reminded_at IS NULL`, cross-checked
against `event_meta` by `googleEventId`) and `markReminded(googleEventId)`.
Intended use by backend-dev's reminder-sweep cron: run on some cadence (e.g.
every 15–30 min), call with e.g. `withinMs = 2h`, send a message per event,
call `markReminded`. **v1 sends at most one reminder per event, ever** — no
"day before" + "hour before" double reminder. A v2 reminder "stage" column
would be needed for that; not built here.

### Digests

No new dedup column — a digest is idempotent by *schedule*, not by
per-event state (the cron runs once per day/week and summarizes a time
window via `listEvents`, it doesn't track individual events). Recommended
pattern for backend-dev, using the existing `settings` table (key/value,
already used by `lib/google/watch.ts` for the watch-channel state): store
`last_daily_digest_sent` / `last_weekly_digest_sent` as an ISO date string,
and no-op if a retried cron invocation finds it already set for today. Not
implemented here since `app/api/cron/*` is backend-dev's file.

### Two ways to compose cron-triggered messages

`sendGroupMessage` (→ `enqueueOutbound`) means a digest/reminder *could* be
produced by calling `runAgent` with a synthetic instruction and letting the
model call `listEvents` + `sendGroupMessage` itself — reuses the same
plumbing and prompt-driven formatting. Alternatively backend-dev's cron can
bypass the agent entirely: call `lib/google/events.listEvents` /
`listUpcomingEventsPendingReminder` directly and hand-format the text via
`enqueueOutbound`. Recommendation: use the direct path for reminders (cheap,
deterministic, runs frequently) and consider the agent path for digests
(runs once a day, benefits more from natural phrasing) — but this is a
call for tech-lead, not decided in this module.

## 4. Conflict-detection rule (v1)

`lib/google/conflicts.ts` `checkConflicts({ startISO, endISO, memberIds,
allDay?, excludeGoogleEventId? })`:

```
overlap = candidate.start < other.end && candidate.end > other.start
```

- Restricted to events that share **at least one** `family_members.id` with
  the candidate (an overlap between two events for different people isn't a
  conflict).
- **A pair conflicts only when both are timed, or both are all-day** (tech-lead's
  canonical ruling; `if (event.allDay !== candidate.allDay) continue`). An
  all-day "reminder"-style event (e.g. "Kai's spring break") never flags a
  conflict against a timed event that week, in either direction — but two
  overlapping all-day events on the same day *do* conflict with each other.
- `excludeGoogleEventId` lets an update check conflicts without the event
  matching itself.
- The query window is widened by 24h on each side of the candidate range
  before fetching from Google, so all-day events (whose boundaries are
  calendar dates, not instants) are reliably included before the precise
  overlap math above is applied.

**Known limitation — shared-calendar-only.** This only ever sees events on
the single shared "Luthra Family" calendar (`FAMILY_CALENDAR_ID`). If a
family member keeps a personal calendar, it's invisible to this check
entirely. Explicitly out of scope for v1 (CLAUDE.md's calendar model is one
shared calendar as the source of truth); revisit if/when a v2 wants
per-member personal-calendar awareness (would need either calendar
free/busy queries against each member's personal calendar, or a
member-specific OAuth grant — a materially bigger change).

**Cross-team consistency (resolved).** The dashboard's mock conflict logic
(`lib/mock/conflicts.ts`) was brought in line with this same canonical rule
(`if (a.allDay !== b.allDay) return false`), so the mock and the real backend
now agree on every case including all-day-vs-all-day. Swapping the mock adapter
for the real one won't change conflict-highlighting behavior.

## 5. Data model

No schema changes were needed. `event_meta` (already in
`lib/db/schema.ts`) covers everything: `googleEventId`, `memberIds`,
`createdVia`, `announcedAt`, `remindedAt`. The Google watch-channel's
state (channel id, resource id, expiration, sync token) is persisted in the
existing `settings` key/value table under the key `"google_watch_channel"`
rather than a new table.

## 6. Google Calendar integration notes

- **Auth**: `lib/google/client.ts` builds an `OAuth2Client` from
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN`,
  lazily (mirrors `getDb()`'s pattern — safe to import with no env vars set,
  e.g. during `next build`). `scripts/google-auth.ts` is a one-time,
  interactive `tsx` script that runs the OAuth consent flow locally
  (temporary localhost callback server) to mint the refresh token; it never
  writes `.env.local` itself.
- **Tagging**: every event LuthCal writes carries
  `extendedProperties.private.luthcalMemberIds` (JSON array) and
  `.luthcalCreatedVia`. This is how `lib/google/watch.ts` tells "an event we
  wrote" apart from "a family member added this directly in a calendar app"
  on webhook sync, and how `checkConflicts` knows which members an event
  belongs to.
- **Watch channel**: `registerWatchChannel()` / `renewWatchChannelIfNeeded()`
  in `lib/google/watch.ts`. The channel token is `CRON_SECRET` (echoed back
  by Google as `X-Goog-Channel-Token` on every notification) — the webhook
  route validates it before doing anything else. `app/api/webhooks/google/route.ts`
  authenticates synchronously, then defers the actual sync to Next's
  `after()` so the response to Google flushes immediately regardless of how
  long the Calendar API round trip + DB writes take (Google expects a fast
  2xx and retries with backoff otherwise).
- **Sync**: `syncGoogleCalendarChanges()` uses the incremental `syncToken`
  once one exists, falling back to a 30-day `timeMin` lookback the first
  time (or after a `410 Gone` — Google's syncToken-expired signal, handled
  by clearing the stored token and retrying once). Idempotent: re-running it
  redundantly just re-upserts the same rows.

## 7. Deviations from the initial task brief

- Added `location` (optional, pass-through to Google's `location` field) to
  `LuthEvent` / `CreateEventInput` / `UpdateEventInput` and the
  `createEvent`/`updateEvent` tools — not in the original spec, but a
  one-line addition once the type contract needed to match the dashboard's
  mock data shape (`lib/mock/types.ts`) for a no-migration swap from mock to
  real data later.
- `LuthEvent.start`/`end` are always full ISO 8601 UTC instants, including
  for all-day events (midnight in `FAMILY_TZ`) — not a bare `"YYYY-MM-DD"`
  for all-day events as an earlier draft of this module had it. This
  matches what the dashboard's formatting helpers already assume, and
  incidentally fixes a real round-trip bug an earlier draft had: `end` is
  Google's native *exclusive* boundary on the wire in both directions now
  (read via `listEvents`/`getEvent` and write via `createEvent`/
  `updateEvent`), so reading an event and feeding its `end` straight back
  into `updateEvent` no longer shifts it by a day.
- `app/api/webhooks/google/route.ts` uses `next/server`'s `after()` to defer
  the sync off the response path, rather than a plain `await` — a stronger
  fit for "Google expects a fast 200" than the synchronous version.

## 8. Production TODOs (explicitly not built here)

- `app/api/chat/route.ts` has no auth guard (fine for local dashboard use;
  needs the same `FAMILY_PASSCODE` check the rest of the dashboard uses
  before this is reachable in production).
- `app/api/webhooks/google/route.ts` has a TODO to kick the announce sweep
  directly after a successful sync, instead of waiting for backend-dev's
  cron tick — left as a hook, not wired, since the cron doesn't exist yet.
- `message_log.member_id` is never populated by `runAgent` (no
  handle-to-`family_members.id` resolution happens here) — left `null`;
  whichever webhook resolves `senderHandle` to a member (name-matching is
  qa-testing/backend-dev's territory per CLAUDE.md) can pass a resolved
  `memberId` through if that turns out to be worth wiring up.
