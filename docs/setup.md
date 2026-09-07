# LuthCal — Go-Live Setup

Everything you need to take LuthCal from a passing build to a running system.
Work top to bottom; each section fills in one group of `.env.local` variables
(the manifest is `.env.example`). Nothing here costs money except Claude API
usage, which is billed by Anthropic at a few cents/day for a
family's message volume.

```
cp .env.example .env.local   # then fill in as you go
```

---

## 1. Database — Neon Postgres

The app stores family members, event metadata, the outbound-message queue, the
message log, and settings in Postgres (via Drizzle). Neon has a free tier.

**Option A — Vercel Marketplace (recommended, auto-wires env):**
```
vercel install neon          # or: Vercel dashboard → Storage → Neon
vercel env pull .env.local   # pulls DATABASE_URL into your local env
```

**Option B — direct:** create a project at neon.tech, copy the pooled
connection string into `DATABASE_URL`.

Then create the tables and seed placeholder family members:
```
npm run db:push     # creates tables from lib/db/schema.ts
npm run db:seed     # inserts family members (edit scripts/seed.ts first — see §6)
```

Fills: `DATABASE_URL`

---

## 2. Anthropic API key — the agent's brain

The agent talks to Claude directly through the Anthropic API (the AI SDK's
`@ai-sdk/anthropic` provider). Two models are used: Claude Sonnet 5 for the
tool-loop agent and Claude Haiku 4.5 for the passive-listener classifier.

1. At [console.anthropic.com](https://console.anthropic.com) → **API Keys → Create Key**.
2. Put the key in `ANTHROPIC_API_KEY`.

That's the only agent credential. To change a model, edit `lib/agent/model.ts`.

Fills: `ANTHROPIC_API_KEY`

---

## 3. Google Calendar — the source of truth

One shared calendar the agent reads and writes; every family iPhone subscribes
to it and syncs natively.

### 3a. OAuth client
1. [console.cloud.google.com](https://console.cloud.google.com) → new project (e.g. "LuthCal").
2. **APIs & Services → Enable APIs → Google Calendar API.**
3. **OAuth consent screen:** External, add yourself as a test user.
4. **Credentials → Create Credentials → OAuth client ID → Desktop app.**
5. Copy the client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### 3b. Mint a refresh token
```
npm run google:auth      # scripts/google-auth.ts — prints a consent URL,
                         # you paste back the code, it prints the refresh token
```
Put the printed token in `GOOGLE_REFRESH_TOKEN`.

### 3c. Create & identify the shared calendar
In Google Calendar (as the account you just authorized): **＋ → Create new
calendar**, name it **"Luthra Family"**. Then **Settings → that calendar →
Integrate calendar → Calendar ID** (looks like `...@group.calendar.google.com`).
Put it in `FAMILY_CALENDAR_ID`.

Finally, share it to the family: each member opens the calendar's public/invite
link on their iPhone once, and it syncs into Apple Calendar automatically.

Fills: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `FAMILY_CALENDAR_ID`

---

## 4. App secrets

Generate random values (`openssl rand -hex 32`) for:
- `CRON_SECRET` — guards `/api/cron/*` and the webhook auth. Vercel Cron sends
  it as `Authorization: Bearer <CRON_SECRET>`.
- `BLUEBUBBLES_WEBHOOK_SECRET` — the `?secret=` on the inbound BlueBubbles
  webhook URL (see §5).

And set:
- `FAMILY_TZ` — your family's IANA timezone (default `America/Chicago`). **All**
  event/time math uses this, so get it right.
- `APP_BASE_URL` — your deployed https URL (used to register the Google
  watch-channel callback); on Vercel this can usually be left unset.

---

## 5. iMessage bridge — BlueBubbles

The agent lives in your real family iMessage group chat via a BlueBubbles
server on an always-on Mac. Full walkthrough: **`docs/bluebubbles-setup.md`**.
That guide fills `BLUEBUBBLES_URL`, `BLUEBUBBLES_PASSWORD`, and
`FAMILY_CHAT_GUID`, and covers the dedicated Apple ID, the Cloudflare tunnel,
and registering the inbound webhook (`/api/webhooks/bluebubbles?secret=...`).

Until the bridge is up, the whole system still works through the **web
dashboard** — the agent, calendar, and digests all function; outbound texts
just queue until a bridge exists.

---

## 6. Your family roster

Edit `scripts/seed.ts` (DB seed) — for each member set name, iMessage handle
(phone/email), a color, and aliases the agent should recognize ("Mom", "MJ",
"the boy"). Re-run `npm run db:seed`. You can also manage members later from the
dashboard's **Family** page.

---

## 7. Run it

**Locally:**
```
npm run dev          # http://localhost:3000
```
Open the dashboard, use the chat panel to try: "add dentist for Maya Tuesday
3pm" → the event should appear in the shared Google Calendar, and a conflict
warning should fire if it overlaps something.

**Deploy to Vercel:**
```
vercel                       # link/deploy a preview
vercel env add ...           # push each var above to Production
vercel --prod
```
After the first production deploy, the Vercel Cron entries in `vercel.json`
(digests, reminders, announce sweep, outbound retry) begin firing on schedule,
and the Google watch channel + BlueBubbles webhook deliver real-time updates.

---

## Environment variable checklist

| Variable | Section | Purpose |
|---|---|---|
| `DATABASE_URL` | §1 | Neon Postgres |
| `ANTHROPIC_API_KEY` | §2 | Claude via the Anthropic API |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | §3a | OAuth client |
| `GOOGLE_REFRESH_TOKEN` | §3b | long-lived Google auth |
| `FAMILY_CALENDAR_ID` | §3c | the shared calendar |
| `CRON_SECRET` | §4 | cron/webhook auth |
| `BLUEBUBBLES_WEBHOOK_SECRET` | §4/§5 | inbound webhook auth |
| `FAMILY_TZ` | §4 | family timezone (all time math) |
| `APP_BASE_URL` | §4 | watch-channel callback base |
| `BLUEBUBBLES_URL` / `BLUEBUBBLES_PASSWORD` | §5 | bridge REST API |
| `FAMILY_CHAT_GUID` | §5 | the family group chat |
