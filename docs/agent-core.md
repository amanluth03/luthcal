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
  `getDb()`), so the model can read who "Maya" / "the dentist for Kai"
  refers to. **The model itself never resolves a name to a
  `family_members.id`** — `createEvent`/`updateEvent` take a `memberNames`
  array of the raw name/alias text instead of an id array; a deterministic,
  non-LLM function resolves that text to ids. See "Deterministic
  member-matching backstop" in §2.
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
  -> normalizeInboundText(raw) (lib/agent/normalize-inbound.ts — see below)
       -> reject (400) if isEmpty or isTooLong, BEFORE runAgent and BEFORE any message_log write
  -> runAgent({ messages, source, chatGuid?, senderHandle? })
       -> log inbound to message_log (best-effort; degrades to a no-op if DATABASE_URL isn't set)
       -> fetch family roster once, reused for both the prompt and the tools
       -> build system prompt (roster + now + policy)
       -> generateText({ model, system, messages, tools, stopWhen: stepCountIs(8) })
            tool loop: model calls createEvent/updateEvent/deleteEvent/listEvents/checkConflicts/sendGroupMessage
              as many times as needed (each execute() hits lib/google directly)
              createEvent/updateEvent resolve memberNames -> ids deterministically
              (see "Deterministic member-matching backstop" below) before writing anything
       -> deterministic conflict safety net (see below)
       -> log outbound (the reply) to message_log
       -> return { reply, actions }
  -> caller delivers `reply`:
       - app/api/chat/route.ts: returns it as JSON to the dashboard directly (see §2a for the
         full request/response contract).
       - BlueBubbles webhook (backend-dev): enqueues `reply` via lib/agent/outbound.ts
         `enqueueOutbound(chatGuid, reply)` so it lands back in the group chat. **Must also call
         `normalizeInboundText` first**, the same as app/api/chat/route.ts — the helper is
         adapter-agnostic (no Next.js/DB import) specifically so both entry points can share it.
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

**Deterministic member-matching backstop (F4).** Before this change, the
model read the roster text in the system prompt and emitted an already-
resolved `family_members.id` for `createEvent`/`updateEvent`'s `memberIds`
parameter — so a genuinely ambiguous name (two roster members sharing an
alias) relied entirely on the model choosing to ask instead of guessing one
of the two ids, with no code path to catch a wrong guess. This mirrors the
conflict-detection asymmetry flagged by qa-testing's FINDING notes in
`tests/agent/member-matching.test.ts`.

Fixed by moving id resolution out of the model entirely:

- `lib/agent/match-member.ts` exports `matchMember(text, roster)`, a pure,
  synchronous, non-LLM function returning a discriminated result:
  `{ kind: "unique", member }`, `{ kind: "ambiguous", candidates }`, or
  `{ kind: "none" }`. Never throws.
  - **Matching rule:** case-insensitive **exact** match of a token against a
    roster member's `name` or any `alias`. No substring/prefix/fuzzy
    matching — a confident partial match is exactly the kind of silently-
    wrong guess this exists to prevent.
  - **Tokenization:** the candidates checked are (1) the whole input,
    trimmed, as one string, and (2) each whitespace-delimited token within
    it — both lower-cased, no punctuation stripping. Trying the whole string
    first lets a multi-word alias ("the boss") match as a unit; per-token
    matching then catches a name embedded in a longer sentence ("dentist for
    Maya tuesday"). Chosen for being simple and predictable over maximally
    permissive — see the file's own doc comment for the full rationale.
  - `kind: "ambiguous"` covers both a literal shared alias (two parents both
    aliased "Mom") and a role word ("son", "the kid") in the (unlikely) case
    it was configured as an alias for more than one roster member — there's
    no special-casing for role words; it's the same mechanism.
- **Wiring** (`lib/agent/tools.ts`): `createEvent`/`updateEvent`'s tool
  schemas take `memberNames: string[]` (raw name/alias text, exactly as the
  model read it in the conversation) instead of `memberIds`. Each tool's
  `execute()` calls a small `resolveMemberNames(names, roster)` helper that
  runs `matchMember` per name:
  - any name that resolves `"ambiguous"` short-circuits the whole call —
    **no event is created/updated** — and the tool returns
    `{ ambiguousMember: { name, candidates } }` instead of `{ event }`. The
    system prompt instructs the model: on seeing `ambiguousMember`, ask the
    user which candidate they meant and call the tool again once they
    answer, rather than retrying with a guess.
  - a name that resolves `"none"` (matches nobody on the roster) is not
    treated as an error — it's dropped (contributes no id) and reported back
    as `unresolvedMemberNames`, since it's just as likely to be a real
    non-family person ("playdate with Emma") as a typo.
  - `checkConflicts` still takes `memberIds` directly (unchanged) — it's
    read-only, so a wrong id there produces a wrong conflict check, not a
    wrong-person event; out of scope for this backstop.
  - Both `buildSystemPrompt` and `buildAgentTools` are now called with the
    *same* roster snapshot (fetched once per `runAgent` call), so
    `memberNames` resolution can't race a roster edit made between prompt
    build and tool execution.

This gives member-matching the same shape of deterministic, server-side
safety net conflict-detection already had: the model can still get the
*parsing* wrong (misreading who a message is about), but it can no longer
cause a *silent* wrong-person write when the name it read is genuinely
ambiguous per the roster — that always surfaces a clarifying question
instead. Covered by `tests/agent/member-matching.test.ts` (pure-function
tests against `matchMember`; the `tools.ts` wiring itself is exercised only
indirectly today — an integration test against a mocked model is future
work, not built here).

### 2a. Inbound text normalization (F5)

`lib/agent/normalize-inbound.ts` exports a pure, dependency-free helper so
every entry point that hands raw text to the agent applies the same cheap
pre-checks before a model call (or a `message_log` write) ever happens:

```ts
export const MAX_INBOUND_LENGTH = 4000; // characters
export function normalizeInboundText(raw: string): { text: string; isEmpty: boolean; isTooLong: boolean }
```

- `text` is `raw.trim()`. Not truncated by the helper itself — it reports
  `isTooLong` and leaves the reject-vs-truncate decision to the caller.
- `isEmpty` is true for `""` or a whitespace-only string.
- `isTooLong` is true above `MAX_INBOUND_LENGTH` (4000 chars — generous
  headroom over any real iMessage/dashboard message, while still bounding
  the worst case before it's written to `message_log`'s unbounded `text`
  column and handed to the model).
- Deliberately does **not** filter emoji-only, punctuation-only, or other
  "weird but non-empty" text — deciding whether a message is a real
  calendar request is the model's job (§1); this helper only guards the two
  cases that are cheap and unambiguous to reject before any model call:
  nothing there, and way too much there.

**Wiring:** `app/api/chat/route.ts` calls this on the last (submitted)
message's `content` and returns `400` for `isEmpty`/`isTooLong` *before*
calling `runAgent` and before any `message_log` row is written — see §2b.
**The BlueBubbles webhook must call the same helper** the same way once it
lands (backend-dev's file, not wired here) — that's the whole reason this
lives in its own dependency-free module rather than inline in the chat
route. Covered by `tests/inbound/malformed-text.test.ts`.

### 2b. `/api/chat` request/response contract

`app/api/chat/route.ts` is the dashboard's entry point into the same
`runAgent` the iMessage webhook will use. Full contract (mirrored as a
comment block at the top of the route file itself):

**Request** — `POST /api/chat`
```json
{ "messages": [{ "role": "user" | "assistant", "content": "string" }, ...] }
```
- `messages` must be a non-empty array.
- The **last** message must have `role: "user"` — it's the turn being
  submitted this request.
- Everything before the last message is prior conversation history. There is
  **no server-side session/thread store** — the dashboard client is
  responsible for keeping and resending the full history on every request
  (append the previous response's `reply` as an `assistant` message, then
  the user's next message, and send the whole array again). This is what
  makes the chat multi-turn: `runAgent` already forwards the entire
  `messages` array to the model as-is, so prior turns are in context for
  resolving things like "make it 4 instead" against an event just
  discussed.
- Only the last message's `content` is run through `normalizeInboundText`
  (§2a) — prior history was already validated when it was originally
  submitted as *its* turn's last message.

**Response — 200**
```json
{ "reply": "string", "actions": [{ "tool": "string", "input": "unknown", "output": "unknown" }, ...] }
```
- `reply` — the assistant's reply text for this turn only. The client
  appends it to its own message list to build history for the next request.
- `actions` — every tool call `runAgent` made this turn (`createEvent`,
  `checkConflicts`, etc.), in call order. Not required to render the reply;
  available for an "what the agent did" activity view. This is
  `RunAgentResult` (`lib/agent/index.ts`) returned as-is — the shape was
  already stable before this change, so nothing here should require a
  frontend migration once wired up.

**Errors** — `{ "error": "string" }`
- `400` — invalid/absent JSON body, wrong shape, empty `messages`, last
  message not `role: "user"`, or the last message's content is
  empty/whitespace-only or over `MAX_INBOUND_LENGTH`.
- `500` — `runAgent` threw (upstream model/tool failure).

**Auth:** still `TODO(production)` — no guard today, fine for local
dashboard use against `next dev`; needs the same `FAMILY_PASSCODE` check the
rest of the dashboard uses before this is reachable in production (see §8).

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
  handle-to-`family_members.id` resolution happens here) — left `null`.
  Note this is a different lookup than F4's `matchMember` (that resolves
  *name text mentioned in a message* to a member; this would resolve the
  *iMessage handle that sent it* to a member, e.g. matching
  `family_members.imessageHandle`/`.phone` against `senderHandle`) — not the
  same function, though `family_members` is the same table. Whichever
  webhook resolves `senderHandle` can pass a resolved `memberId` through if
  that turns out to be worth wiring up.
- F4's member-matching backstop (§2) only covers `createEvent`/`updateEvent`.
  `checkConflicts` still takes `memberIds` directly from the model — it's
  read-only, so the failure mode of a bad id there is a wrong/missed
  conflict check, not a wrong-person write; flagged here rather than fixed
  since it's a materially smaller risk and widening the backstop's scope
  further is a judgment call for tech-lead, not assumed.
- F4's `matchMember` treats a name matching nobody on the roster
  (`kind: "none"`) as "not a family member reference" and silently drops it
  from `memberIds` (reported back as `unresolvedMemberNames`, not surfaced
  to the user automatically) rather than blocking the create/update the way
  `"ambiguous"` does. This is a deliberate v1 choice (see §2's backstop
  writeup) but worth tech-lead's sign-off: an alternative design would also
  force a clarifying question on `"none"`, at the cost of blocking
  legitimate non-family-member event references (e.g. "playdate with
  Emma").
