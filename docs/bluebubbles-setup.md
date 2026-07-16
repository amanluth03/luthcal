# BlueBubbles bridge setup

Operator guide for standing up the Mac-side iMessage bridge LuthCal talks to.
Owner: backend-dev. Covers `lib/bluebubbles.ts`, `app/api/webhooks/bluebubbles/`,
`app/api/cron/*`, `vercel.json`.

LuthCal's agent doesn't speak iMessage directly — [BlueBubbles](https://bluebubbles.app)
runs on a real Mac signed into iMessage, exposes a REST API + webhooks, and
that's what `lib/bluebubbles.ts` talks to. Everything below is one-time setup
on that Mac plus a handful of Vercel env vars.

## 1. Dedicated Apple ID for the agent

Don't use a family member's personal Apple ID — the agent needs its own
identity so its texts show up as a distinct participant in the group chat
(and so nobody's personal iMessage history/devices are entangled with it).

1. Create a new Apple ID (https://appleid.apple.com) — a plain email works,
   doesn't need to be an @icloud.com address. Something like
   `luthcal.agent@<yourdomain>` or a fresh Gmail address is fine.
2. Give it a real password and enable two-factor auth like any Apple ID.
3. **Do not** sign this Apple ID into iCloud/Messages on anyone's phone. It
   should only ever be signed into Messages.app on the dedicated Mac (§2).
   Signing it into a phone too causes duplicate delivery/read-receipt
   weirdness and defeats the point of it being a bridge-only identity.
4. Add this Apple ID to the family iMessage group chat (have any family
   member add it via "Add Contact" in the group chat, same as adding a new
   person). The agent now receives every message sent to the group and can
   send back.

## 1a. The agent is a passive listener, not a bot that replies to everything

Once wired into the group chat, the agent does **not** respond to every
message it sees — it passively monitors and only engages when one of three
things happens (`lib/agent/engagement.ts` `decideEngagement`, see
docs/agent-core.md §9 for the full design):

1. **It's addressed by name.** The message contains "LuthCal" (or one of the
   names/aliases configured via `AGENT_NAMES`, see §5) as a whole
   word/phrase — "hey LuthCal, add..." or "@LuthCal what's on Tuesday?" both
   count; a bare mention of "the calendar" does **not** (that's deliberately
   excluded — see the ruling in `lib/agent/engagement.ts`
   `DEFAULT_AGENT_NAMES`, it's too common a word in ordinary chatter). An
   explicit mention gets full tool access — the agent can create, move, or
   delete events directly, same as always.
2. **It detects a concrete event with a specific day/time**, with high
   confidence, from an unaddressed message ("Maya has a dentist appt Tuesday
   at 3"). It does **not** create anything on its own in this case — it
   replies with a short question ("Want me to add Maya's dentist for Tue
   3pm?") and waits for confirmation. This is intentionally conservative:
   the agent would rather miss an occasional real event than interrupt
   ordinary family conversation with a wrong or unwanted suggestion.
3. **Someone replies to its own pending question within 15 minutes.** A
   "yes"/"no"/correction sent shortly after the agent asked something is
   treated as answering that question (full tool access for that turn) —
   this is what actually lets case 2's suggestion get confirmed and turned
   into a real event.

Anything else — ordinary conversation, logistics chatter, vague plans with
no day/time — gets **no reply and no database record at all**; that's the
whole point of a passive listener (a bot that chimes in on every message is
the fastest way to get muted or removed from the group chat).

**`AGENT_NAMES` and `AGENT_IMESSAGE_HANDLE` both affect mention detection.**
`AGENT_NAMES` (comma-separated, optional — defaults to just `"LuthCal"`) is
the list of names/aliases that count as "addressing the agent directly" in
case 1 above. `AGENT_IMESSAGE_HANDLE` — the dedicated Apple ID from §1,
already required as the loop-guard belt-and-suspenders check — is
**automatically appended** to that list too, so addressing the agent by its
own handle directly (rare over iMessage, but possible) also counts as a
mention. **Set `AGENT_IMESSAGE_HANDLE` to the agent's actual Apple ID/phone
number during setup** (see §1 and §5) — it does double duty: the loop guard
that stops the agent from replying to itself, and a second way to address it
by name.

## 2. The Mac

BlueBubbles requires a real Mac (Apple's iMessage stack isn't available
anywhere else). This can be an old spare Mac, a Mac mini, or a cloud Mac
(MacStadium, etc.) — it just needs to run macOS and stay reachable.

1. On that Mac, sign into **Messages.app** (not System Settings > iCloud —
   just Messages.app's own "Sign In" prompt) with the dedicated Apple ID
   from §1.
2. Send a test iMessage to the family group chat from Messages.app once, to
   confirm the identity is fully active (Apple sometimes needs a first
   send/receive before an Apple ID is fully provisioned for iMessage).
3. **Always-on caveat**: if this Mac sleeps or loses network, inbound
   webhooks stop arriving and outbound sends fail. LuthCal is built to
   tolerate this — every outbound text goes through `outbound_queue`
   (`lib/agent/outbound.ts` `enqueueOutbound`) rather than being sent
   directly, and `app/api/cron/outbound` (see vercel.json) sweeps and
   retries pending rows every few minutes once the Mac is back. So sleep is
   *survivable*, not silent data loss — but inbound messages sent while
   asleep are simply missed (BlueBubbles has nothing to forward), and
   there's no queue on that side. Practically: set Energy Saver / Battery
   settings to never sleep, disable "Put hard disks to sleep," and keep the
   Mac on a stable network connection (wired ethernet if possible). A Mac
   mini plugged in 24/7 is the easy answer if a spare one is available.

## 3. Install BlueBubbles Server

1. Download and install the BlueBubbles Server app from
   https://bluebubbles.app (macOS app, separate from Messages.app).
2. Launch it, walk through its setup wizard. It will ask for:
   - **Full Disk Access** and **Accessibility** permissions (System Settings
     > Privacy & Security) — required to read the Messages database and
     drive sends.
   - A **server password** — set a strong one; this is `BLUEBUBBLES_PASSWORD`
     below. It authenticates every REST API call (`lib/bluebubbles.ts` sends
     it as a `?password=` query param, per the BlueBubbles REST API).
3. Confirm it's running by visiting `http://localhost:1234` (BlueBubbles'
   default local port) on the Mac itself.

## 4. Expose it publicly — Cloudflare Tunnel

LuthCal (on Vercel) needs to reach the Mac's BlueBubbles server from the
public internet, and BlueBubbles needs to reach LuthCal's webhook. A
Cloudflare Tunnel is the recommended way to do this without opening ports on
the Mac's router:

1. Install `cloudflared` on the Mac (`brew install cloudflared` or the
   Cloudflare-provided installer).
2. If you have a domain on Cloudflare, create a named tunnel and a DNS
   record pointing a subdomain (e.g. `bluebubbles.yourdomain.com`) at it —
   this gives a **stable** URL that doesn't change on restart, which is
   simpler to operate than a quick/ephemeral tunnel:
   ```
   cloudflared tunnel login
   cloudflared tunnel create luthcal-bridge
   cloudflared tunnel route dns luthcal-bridge bluebubbles.yourdomain.com
   cloudflared tunnel run --url http://localhost:1234 luthcal-bridge
   ```
   Run this as a login item / launchd service so it survives reboots
   (`cloudflared service install` sets up a system service).
3. No domain handy? `cloudflared tunnel --url http://localhost:1234` (a
   "quick tunnel") works too, but mints a **new random URL every time it
   restarts**. If you go this route, BlueBubbles Server's webhook settings
   can be configured to POST a "server URL changed" event whenever its
   public address changes — `app/api/webhooks/bluebubbles/route.ts` listens
   for that and updates the bridge URL LuthCal uses automatically (see §6),
   so you don't have to manually update `BLUEBUBBLES_URL` in Vercel every
   time the tunnel restarts. A named tunnel (stable URL) is still less
   operational overhead if a domain is available.
4. Set `BLUEBUBBLES_URL` (Vercel env, see `.env.example`) to that public
   URL, e.g. `https://bluebubbles.yourdomain.com`. This is the fallback
   LuthCal uses whenever no URL has been auto-updated via §6 yet (e.g. right
   after first deploy).

## 5. Configure BlueBubbles' env vars in Vercel

In the LuthCal Vercel project (`vercel env add ...` or the dashboard):

| Var | Value |
|---|---|
| `BLUEBUBBLES_URL` | The tunnel URL from §4 |
| `BLUEBUBBLES_PASSWORD` | The server password from §3 |
| `BLUEBUBBLES_WEBHOOK_SECRET` | A long random string you generate (e.g. `openssl rand -hex 32`) — guards the inbound webhook, see §6 |
| `BLUEBUBBLES_SEND_METHOD` | `apple-script` (default) or `private-api` — see §8 |
| `FAMILY_CHAT_GUID` | The group chat's GUID — see §7 |
| `AGENT_IMESSAGE_HANDLE` | The dedicated Apple ID from §1 (the same email/phone signed into Messages.app on the bridge Mac) — a defense-in-depth loop guard (see §6) AND counts as a mention for the passive-listener gate (see §1a) |
| `AGENT_NAMES` | Optional, comma-separated (e.g. `LuthCal,Cal`) — names/aliases that count as directly addressing the agent, see §1a. Defaults to just `LuthCal` if unset. |
| `CRON_SECRET` | A long random string — guards every `/api/cron/*` endpoint (see vercel.json). Also used by the external GitHub Actions cron pinger — see docs/cron-pinger.md |

## 6. Register the webhook

BlueBubbles pushes events (new messages, its own URL changing, etc.) to a
webhook URL you register in its settings. It can't set custom headers on
that request, so LuthCal's webhook auth travels as a query param instead:

1. In BlueBubbles Server's settings (Settings > API / Webhooks in the
   BlueBubbles Server app), add a webhook pointing at:
   ```
   https://<your-luthcal-deployment>.vercel.app/api/webhooks/bluebubbles?secret=<BLUEBUBBLES_WEBHOOK_SECRET>
   ```
   using the same value you set for `BLUEBUBBLES_WEBHOOK_SECRET` in Vercel.
2. Subscribe to at least the "New Message" event. If BlueBubbles exposes a
   "Server URL Change" (or similarly-named) event toggle, enable that too —
   it's how `lib/bluebubbles.ts` learns about a rotated tunnel URL without a
   redeploy (see §4 step 3). **Note:** the exact event-type string
   BlueBubbles sends for that case wasn't independently confirmed against
   live server output while building this (see the comment in
   `app/api/webhooks/bluebubbles/route.ts`) — if the bridge URL doesn't seem
   to auto-update after a tunnel restart, check the Vercel function logs for
   the raw webhook payload's `type` field and adjust
   `SERVER_URL_CHANGE_TYPES` in that file if it doesn't match.
3. `GET /api/webhooks/bluebubbles` returns `ok` (no auth) — use it to
   confirm the deployment is reachable at all before wiring up the webhook.

The webhook ignores every event except `new-message` (and the URL-change
event above), and ignores `new-message` events where `isFromMe` is true —
that's the agent's own outbound texts echoing back through the bridge, and
replying to those would make the agent talk to itself forever.

**Confirm the `isFromMe` field name during setup.** That field name is
inferred from third-party BlueBubbles integration examples, not
independently verified against a live server's actual webhook payload (see
the comment above `SERVER_URL_CHANGE_TYPES` in
`app/api/webhooks/bluebubbles/route.ts`). If it's wrong, the loop guard
fails *open* — the agent would reply to its own messages forever. Once the
webhook is registered, send one test message to the group chat from a
**real family member's** phone (not the agent's Apple ID) and check the
Vercel function logs (or add a temporary `console.log(JSON.stringify(payload))`
at the top of the `POST` handler) for the raw `new-message` payload shape,
then send one **from the agent's own dedicated Apple ID** (§1) and confirm
`data.isFromMe` is actually `true` on that one. As a second, independent
safety net against exactly this kind of drift, the webhook also checks the
sender handle against `AGENT_IMESSAGE_HANDLE` (case-insensitive) and drops
the message either way — set that env var (see §5) so the loop guard isn't
relying on `isFromMe` alone.

**Bootstrap the Google Calendar watch channel right after first deploy.**
`app/api/cron/renew-watch` only runs once daily on Vercel Cron (~3:30-4:30am
FAMILY_TZ, off-peak — see the schedule table below), so a fresh deployment
with no watch channel registered yet would otherwise wait up to ~24h before
calendar-app-added events start syncing into `event_meta` (and therefore
get announced — see docs/agent-core.md §3). Hit it once manually right
after the first deploy to register the channel immediately instead of
waiting for the first scheduled tick:
```
curl "https://<your-luthcal-deployment>.vercel.app/api/cron/renew-watch?secret=<CRON_SECRET>"
```

## 7. Finding `FAMILY_CHAT_GUID`

The webhook only acts on messages addressed to this specific chat — every
other chat (DMs to the agent's Apple ID, other group chats it might
accidentally be added to) is ignored.

Easiest way: send any message to the family group chat, then check the
Vercel function logs for `/api/webhooks/bluebubbles` — `message_log` (the
Postgres table) also has a row with the inbound `chat_guid` you can query
directly (`select distinct chat_guid from message_log;`). It looks like
`iMessage;+;chat123456789012345678`.

Alternatively, BlueBubbles Server's own web UI (Settings > or its chat
list API, `GET /api/v1/chat/{guid}` style endpoints) lists chats with their
GUIDs directly — see BlueBubbles' own docs
(https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks)
for the chat-list endpoint if you'd rather not wait for an inbound message.

## 8. SIP / Private API note

BlueBubbles can send messages two ways, controlled by `BLUEBUBBLES_SEND_METHOD`:

- **`apple-script`** (default): drives Messages.app via AppleScript. Works
  out of the box on a stock macOS install, no extra configuration. Good
  enough for simple group-chat text sends, which is all LuthCal needs for
  v1. **Use this unless you have a specific reason not to.**
- **`private-api`**: talks to a private, undocumented Messages framework
  BlueBubbles hooks into directly. Gives richer behavior (delivery/read
  receipts, reactions, more reliable group-chat targeting) but **requires
  disabling System Integrity Protection (SIP)** on the Mac — a real security
  reduction for that machine. Follow BlueBubbles' own Private API setup
  guide if you want this
  (https://docs.bluebubbles.app/private-api/imcore-documentation).

**Only disable SIP on the dedicated bridge Mac from §2, never on a Mac
anyone uses as a daily driver.** If the bridge Mac is also someone's regular
laptop, stick with `apple-script` and accept the more basic send behavior —
it's not worth the security trade-off.

## 9. Verifying end to end

1. `vercel env pull` locally (or check the Vercel dashboard) to confirm all
   the vars from §5 are set on the deployment.
2. Text the family group chat something that directly addresses the agent,
   e.g. **"LuthCal, test from setup"** — a bare "test from setup" with no
   mention and no concrete event/time is exactly the kind of ordinary
   chatter the passive-listener gate is designed to ignore (see §1a), so it
   may correctly produce no reply at all and isn't a reliable end-to-end
   check on its own. An explicit "LuthCal, ..." message always engages.
   `app/api/webhooks/bluebubbles` should run the agent and enqueue a reply
   in `outbound_queue`; check the Vercel function logs for a
   `gate: silent` line if a non-addressed test message doesn't produce one.
3. Within a few minutes, `app/api/cron/outbound` (vercel.json's retry sweep)
   should pick that row up and actually deliver it — you should see the
   agent's reply show up in the group chat.
4. If nothing arrives: check Vercel function logs for
   `/api/webhooks/bluebubbles` (did the webhook fire at all — is the
   `?secret=` right?) and `/api/cron/outbound` (is the row stuck `pending`
   with a `last_error` — likely `BLUEBUBBLES_URL`/`BLUEBUBBLES_PASSWORD`
   wrong, or the Mac/tunnel down).

## Cron schedule reference

`vercel.json` holds the authoritative schedules (plain JSON — it can't carry
inline comments, so the FAMILY_TZ intent behind each UTC expression is
documented here instead). All Vercel cron schedules are UTC-only; there's no
per-schedule timezone support.

| Path | UTC schedule | FAMILY_TZ (`America/Chicago`) intent |
|---|---|---|
| `/api/cron/digest?kind=daily` | `0 12 * * *` | 7:00am daily (CDT, Mar–Nov) |
| `/api/cron/digest?kind=weekly` | `0 23 * * 0` | ~6:00pm Sunday (CDT, Mar–Nov) — week-ahead |
| `/api/cron/reminders` | `*/15 * * * *` | every 15 min, all day |
| `/api/cron/announce` | `*/15 * * * *` | every 15 min, all day |
| `/api/cron/outbound` | `*/5 * * * *` | every 5 min, all day (Mac-asleep retry) |
| `/api/cron/renew-watch` | `30 9 * * *` | ~3:30–4:30am, once daily (off-peak) |

**DST drift caveat:** the two digest schedules are picked for CDT (UTC-5,
in effect roughly March–November, including everything from now through
end-of-year 2026). During CST (UTC-6, winter), both fire **one hour earlier**
in `FAMILY_TZ` — 6am instead of 7am for the daily digest, ~5pm instead of
~6pm for the weekly one. This is an inherent limitation of Vercel cron
(fixed UTC, no DST awareness), not a bug. Two reasonable fixes if the drift
matters enough to address: (a) manually flip the UTC hour by one twice a
year at the DST boundaries, or (b) change the cron cadence to something
frequent (e.g. every 15–30 min) and have the route itself check "is it
currently ~7am in FAMILY_TZ and has today's digest not gone out yet" before
acting — trades a fixed schedule for one that's correct year-round.
Deliberately not built here; flagged for tech-lead as a judgment call
between operational simplicity and DST correctness.

**Frequency note:** sub-daily schedules (reminders, announce, outbound retry
— all every 5–15 minutes) require a **Vercel Pro plan or higher**; the
Hobby plan restricts cron jobs to once per day, and silently downgrades
these `vercel.json` entries to that once-daily cadence rather than erroring
at deploy time. The `vercel.json` schedules above are left declared as-is
(they become fully correct with zero changes if the family upgrades to
Pro), but as long as the family stays on Hobby, these three sub-daily jobs
are actually driven by an **external GitHub Actions cron pinger**
(`.github/workflows/cron-pinger.yml`) instead — see **docs/cron-pinger.md**
for the full setup (required repo secrets, chosen cadence, and the
overlap-safety changes that make pinging these endpoints from two clocks at
once — GitHub's and Vercel's — safe). The daily/weekly digest and the
once-daily watch-channel renewal don't need this workaround; Hobby's
native once-a-day cron already covers them.
