# External cron pinger (Vercel Hobby workaround)

Owner: backend-dev. Covers `.github/workflows/cron-pinger.yml`, and the
sub-daily-cadence half of the cron story that `vercel.json` alone can't
deliver on the Hobby plan. See docs/bluebubbles-setup.md's "Cron schedule
reference" for the full schedule table and the Vercel-cron side of things.

## The problem

`vercel.json` declares six cron jobs, four of which need to run every
5-15 minutes to be useful:

| Path | Needed cadence | Why |
|---|---|---|
| `/api/cron/reminders` | every ~15 min | events starting soon need a timely nudge, not a once-a-day one |
| `/api/cron/announce` | every ~15 min | dashboard/calendar-app-created events should get announced to the group chat promptly |
| `/api/cron/outbound` | every ~5 min | drains `outbound_queue` once the Mac/BlueBubbles bridge wakes back up |
| `/api/cron/inbound` | every ~10 min | REST-API poll backstop — picks up inbound messages BlueBubbles' own webhook poller missed (see "Inbound-poll backstop" below) |

**Vercel Cron on the Hobby plan is capped at 1 invocation/day per job.**
Sub-5/15-minute schedules like the ones in `vercel.json` silently only fire
once a day on Hobby (Vercel doesn't reject the config at deploy time — it
just runs it once daily instead of on the declared schedule). That's a
real, silent behavior change from what `vercel.json` reads, not a config
error — worth remembering if the schedules in `vercel.json` and this doc
ever look inconsistent with what's actually firing in production.

Two ways to fix that:

1. **Upgrade to Vercel Pro** — `vercel.json`'s existing cron entries then
   run at their declared cadence, no other changes needed. This is the
   simpler long-term fix if/when the family is willing to pay for Pro.
2. **External pinger (chosen for now)** — keep Hobby, and have something
   *outside* Vercel hit the sub-daily endpoints on the cadence they need.
   `.github/workflows/cron-pinger.yml` is that something: a GitHub Actions
   scheduled workflow, running in the LuthCal repo, that curls the four
   endpoints above on a 10-minute cadence.

`vercel.json` is left exactly as declared (see its own comment-equivalent
note in docs/bluebubbles-setup.md) — if the family upgrades to Pro later,
the existing cron entries just start running at full cadence with zero
code changes; the GitHub Actions pinger would then be redundant (safe to
disable, or safe to leave running — both crons hitting an idempotent,
now-double-covered endpoint is harmless, see "Overlap safety" below).

## What's pinged, and what isn't

| Path | Pinged by | Cadence |
|---|---|---|
| `/api/cron/reminders` | GitHub Actions | every ~10 min |
| `/api/cron/announce` | GitHub Actions | every ~10 min |
| `/api/cron/outbound` | GitHub Actions | every ~10 min |
| `/api/cron/inbound` | GitHub Actions | every ~10 min |
| `/api/cron/digest?kind=daily` | Vercel Cron only | 1x/day (native Hobby support) |
| `/api/cron/digest?kind=weekly` | Vercel Cron only | 1x/week (native Hobby support) |
| `/api/cron/renew-watch` | Vercel Cron only | 1x/day (native Hobby support) |

The digest and watch-renewal jobs are left to Vercel's own cron rather than
also being added to the GitHub Actions workflow: they only need to fire
once a day, which Hobby already supports natively, so pinging them from
GitHub too would just be a second, redundant trigger for no benefit. (They
run at whatever UTC hour `vercel.json` declares — see
docs/bluebubbles-setup.md for the FAMILY_TZ-intent table and its DST-drift
caveat.)

**Inbound-poll backstop (`/api/cron/inbound`).** BlueBubbles Server runs in a
second macOS user session on the bridge laptop (see docs/bluebubbles-setup.md
§2), and macOS throttles a switched-away session hard enough that its own
message poller can stall for minutes-to-hours — its REST API keeps answering
fine the whole time, though. This endpoint (`lib/inbound-poll.ts`) pulls
recent messages from that REST API on the same 10-minute cadence as a
backstop, and runs anything the webhook hasn't already handled through the
exact same pipeline (`lib/inbound-processor.ts`) the webhook itself uses —
so a stalled webhook costs at most ~10 minutes of delay, not a lost message.

**Why 10 minutes, not 5 or 15:** the four pinged endpoints individually
want 5 min (`outbound`) or 10-15 min (`reminders`, `announce`, `inbound`). A
single shared cadence is simpler to operate than four separate scheduled
workflows (GitHub bills/limits Actions minutes per-workflow-run, and one
workflow with four curl steps is one run, not four). 10 minutes is a
reasonable midpoint: outbound-queue delivery lands within ~10 min of the
Mac waking up instead of ~5, and reminders/announcements land up to ~5 min
earlier than their nominal 15-min cadence. Revisit if the family wants
tighter outbound latency specifically — that would justify splitting
`outbound` into its own 5-minute-cadence workflow.

## Required GitHub repo secrets

Settings > Secrets and variables > Actions > New repository secret:

| Secret | Value |
|---|---|
| `APP_BASE_URL` | The deployed app's public https URL, e.g. `https://luthcal.vercel.app` (no trailing slash — the workflow strips one if present, but keep it clean) |
| `CRON_SECRET` | The **same value** as the `CRON_SECRET` Vercel env var (see `.env.example`) |

Without both set, the workflow fails fast with a clear `::error::` message
rather than silently no-op'ing (see the `set -u` + explicit empty-check at
the top of the job's one step).

## Auth

The workflow sends `Authorization: Bearer <CRON_SECRET>` on every ping —
the exact header Vercel Cron itself sends, and one of the two forms
`lib/webhook-auth.ts`'s `isValidCronRequest` accepts (the other being a
`?secret=` query param, kept for manual `curl` testing). Using the header
form here means the secret never appears in a URL that could end up in
proxy/access logs.

## Fail-loud behavior

Each of the four endpoints is curled independently; a non-2xx response
from any of them is printed via `::error::` (shows up as an annotated
failure in the GitHub Actions UI and, if repo notifications are configured
for failed workflow runs, an email/notification) and the job exits
non-zero. One endpoint failing doesn't stop the others from being pinged in
the same run — they're independent concerns (e.g. `outbound` failing
because the Mac is asleep shouldn't suppress a `reminders` ping). Note that
`/api/cron/inbound` treats a bridge-unreachable condition (Mac asleep,
tunnel down) as a routine 200 (`{ skipped: "bridge unreachable", ... }`),
not a non-2xx failure — same philosophy as `outbound` skipping when there's
nothing to deliver to.

## Overlap safety

GitHub Actions' `schedule:` trigger is explicitly documented by GitHub as
**best-effort, not exact** — ticks can be delayed, especially under high
platform load, and the practical minimum granularity is around 5 minutes
even though cron syntax allows finer. This workflow's own
`concurrency: { group: cron-pinger, cancel-in-progress: false }` prevents
two ticks of *this specific workflow* from running at the same time (a
queued run waits rather than overlapping), but a delayed GitHub tick
landing close to a manual `workflow_dispatch` run, or Vercel's own cron
firing at the same moment as a GitHub Actions ping, is still possible.
That's exactly why the endpoints themselves were hardened to be
overlap-safe (tech-lead follow-up F2): `lib/outbound-processor.ts` and
`app/api/cron/announce/route.ts` both use an atomic claim-before-send
pattern, so two simultaneous hits on the same endpoint can't double-send
the same family text — see the comments in those files for the exact
mechanism (a `FOR UPDATE SKIP LOCKED` set-based claim for the outbound
queue; a per-row conditional `UPDATE ... WHERE announced_at IS NULL` claim
for announcements). `/api/cron/inbound` is overlap-safe by construction
rather than an explicit row claim: its watermark (`settings` key
`inbound_poll_watermark`) only ever advances forward, and
`lib/inbound-processor.ts`'s `imessage_guid` dedup check means a message two
overlapping polls (or a poll racing the webhook) both fetch only runs
through the agent once. The reminder sweep and digest routes were already
idempotent via their existing dedup columns/settings rows (see
docs/agent-core.md §3) before this change.

## Verifying it's working

1. Set both repo secrets (above).
2. From the repo's Actions tab, select "Cron pinger" and click "Run
   workflow" (the `workflow_dispatch` trigger) rather than waiting up to 10
   minutes for the schedule.
3. Confirm all four steps' logs show `ok (200): {...}` (or whatever JSON
   the route returns, e.g. `{"sent":0,"failed":0,"stillPending":0}` for an
   empty outbound queue, or `{"skipped":"bridge unreachable",...}` from
   `/api/cron/inbound` if the Mac/tunnel happens to be down at that moment —
   that's routine, not a failure).
4. If a step fails: the printed `::error::` line includes the HTTP status
   and response body — a 401 means `CRON_SECRET` doesn't match the Vercel
   env var of the same name; a connection failure/5xx means the deployment
   itself is down or `APP_BASE_URL` is wrong.
