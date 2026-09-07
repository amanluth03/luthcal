@AGENTS.md

# LuthCal

## What LuthCal is

An agentic family calendar. An AI agent lives in the family's iMessage group chat (via a
BlueBubbles bridge running on a Mac) and turns plain-language texts into calendar actions.
Someone texts the group "Maya has dentist Tuesday 3pm" and the agent creates the event,
announces it back to the chat, flags any scheduling conflict, and later sends digests and
reminders.

The **source of truth** is a single shared Google Calendar (the "Luthra Family" calendar).
Every family member's iPhone subscribes to it and syncs natively, so their normal calendar
apps keep working as a fallback view — we build zero custom sync. A web dashboard
(`app/(dashboard)`) is the visual window into the system and the fallback UI for when the
Mac bridge is asleep.

## Architecture

Next.js App Router (Next 16, Turbopack) deployed on Vercel. Key surfaces:

- `app/api/webhooks/bluebubbles` — inbound iMessage texts → agent
- `app/api/webhooks/google` — Google Calendar push notifications (events added via calendar apps)
- `app/api/chat` — dashboard chat with the same agent
- `app/api/cron/*` — daily/weekly digest, reminder sweep, outbound-queue retry (Vercel Cron)
- `lib/agent` — AI SDK v6 tool-loop agent, Claude via the Anthropic API (`@ai-sdk/anthropic`, models in `lib/agent/model.ts`); owns NLU + orchestration
- `lib/google` — Google Calendar client (OAuth refresh token, CRUD, watch channels, conflict queries)
- `lib/bluebubbles.ts` — BlueBubbles send client
- `lib/db` — Neon Postgres via Drizzle (`family_members`, `event_meta`, `outbound_queue`,
  `message_log`, `settings`). Import the client via `getDb()` (lazy — safe during `next build`).

## Conventions

- **Timezones:** all event/time math happens in `FAMILY_TZ` (an IANA zone from env), never
  server-local time. Store timestamps as UTC; convert at the edges with `date-fns-tz`.
- **Outbound iMessages:** always go through the `outbound_queue` table — the Mac bridge may be
  asleep, so sends are queued and a cron retries until delivery.
- **Webhook auth:** every `/api/webhooks/*` and `/api/cron/*` endpoint must authenticate
  (shared secret / `CRON_SECRET`). Ignore the agent's own outbound messages on inbound webhooks
  to avoid loops.
- **Idempotency:** announcements and reminders dedup via `event_meta.announced_at` /
  `reminded_at`; a repeated sweep must send nothing.
- **Secrets:** never commit real secrets. `.env.example` is the manifest; real values live in
  `.env.local` (gitignored) and Vercel env.
- **Commits:** imperative one-line subjects, no emoji, no `Co-Authored-By` trailers.

## Team ownership (subagents in `.claude/agents/`)

- **tech-lead** (opus) — architecture, design-ambiguity calls, reviews every agent's output
  before merge; final say on agent-core NLU/orchestration and conflict-detection rules.
- **senior-backend** (sonnet) — `lib/google`, `lib/agent`, `app/api/chat`,
  `app/api/webhooks/google`, `docs/agent-core.md`.
- **backend-dev** (sonnet) — `lib/bluebubbles.ts`, `app/api/webhooks/bluebubbles`,
  `app/api/cron/*`, `vercel.ts`, `docs/bluebubbles-setup.md`.
- **frontend-design** (sonnet) — `app/(dashboard)`, `components/`, `app/layout.tsx`,
  `app/globals.css`, `lib/mock`.
- **junior-dev** (sonnet) — boilerplate, scaffolding, simple CRUD, utils, docs, as delegated.
- **qa-testing** (sonnet) — `tests/` (timezones, duplicate events, name matching, malformed input).

Only the initial scaffold step installs npm packages. Other agents that need a new dependency
list it in their report instead of installing it.

## Commands

- `npm run dev` — local dev server (Turbopack)
- `npm run build` — production build (must pass with no env vars set)
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint
- `npm test` — Vitest (offline/deterministic; external services mocked)
- `npm run db:generate` / `db:push` — Drizzle migrations against `DATABASE_URL`
- `npm run db:seed` — seed placeholder family members
