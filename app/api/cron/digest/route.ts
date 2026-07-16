import { formatInTimeZone } from "date-fns-tz";
import { eq } from "drizzle-orm";

import { enqueueOutbound } from "@/lib/agent/outbound";
import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { listEvents } from "@/lib/google/events";
import { addCalendarDays, calendarDateToISO, getFamilyTimeZone, toCalendarDate } from "@/lib/google/time";
import type { LuthEvent } from "@/lib/google/types";
import { formatDayHeading, formatEventLine, getMemberNameMap } from "@/lib/message-format";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Daily 7am digest + Sunday-evening week-ahead. Per docs/agent-core.md §3
// "Digests": no per-event dedup column — idempotent by *schedule*, via a
// `settings` row (`last_daily_digest_sent` / `last_weekly_digest_sent`)
// storing the FAMILY_TZ calendar-date string the digest last went out for.
// A retried/duplicate invocation the same day is a no-op.

type DigestKind = "daily" | "weekly";

const DAILY_SETTINGS_KEY = "last_daily_digest_sent";
const WEEKLY_SETTINGS_KEY = "last_weekly_digest_sent";

// Returns the family chat GUID, or null if the iMessage bridge isn't
// configured yet. The digest treats null as "nowhere to deliver" and skips
// gracefully (200) rather than failing — see the call site.
function getFamilyChatGuid(): string | null {
  return process.env.FAMILY_CHAT_GUID || null;
}

async function getLastSent(key: string): Promise<string | undefined> {
  try {
    const db = getDb();
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    const value = rows[0]?.value;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function setLastSent(key: string, dateKey: string): Promise<void> {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key, value: dateKey, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: dateKey, updatedAt: new Date() } });
}

/**
 * Decides daily vs. weekly. Priority order:
 *  1. An explicit `?kind=daily|weekly` (manual testing, per the task brief).
 *  2. Vercel Cron's `x-vercel-cron-schedule` header — both the daily and
 *     weekly cron entries point at this same route (see vercel.json), and
 *     Vercel's own docs recommend this header as the way to tell which
 *     schedule fired when multiple crons share one path. A day-of-week field
 *     other than `*` (5th field) means "the Sunday-only schedule fired."
 *  3. Fallback for any other manual invocation: is it Sunday right now, in
 *     FAMILY_TZ.
 */
function resolveKind(request: Request): DigestKind {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("kind");
  if (explicit === "daily" || explicit === "weekly") return explicit;

  const schedule = request.headers.get("x-vercel-cron-schedule");
  if (schedule) {
    // A cron header is present — trust which schedule fired rather than the
    // wall-clock day. The weekly entry pins the day-of-week field (5th) to
    // Sunday; the daily entry leaves it "*". Belt-and-suspenders behind the
    // ?kind= query in vercel.json (the primary, header-independent signal):
    // WITHOUT this guard a Sunday-morning *daily* tick (day-of-week "*") would
    // fall through to the Sunday wall-clock check below and be mis-resolved as
    // "weekly", so the daily digest would never fire on Sundays.
    const dayOfWeekField = schedule.trim().split(/\s+/)[4];
    return dayOfWeekField && dayOfWeekField !== "*" ? "weekly" : "daily";
  }

  // No ?kind and no cron header (a bare manual/local hit) — best-effort guess
  // from the current FAMILY_TZ weekday.
  const tz = getFamilyTimeZone();
  return formatInTimeZone(new Date(), tz, "EEEE") === "Sunday" ? "weekly" : "daily";
}

async function buildDailyDigestText(tz: string, names: Map<string, string>): Promise<string> {
  const todayKey = toCalendarDate(new Date().toISOString(), tz);
  const startISO = calendarDateToISO(todayKey, tz);
  const endISO = calendarDateToISO(addCalendarDays(todayKey, 1), tz);
  const events = await listEvents({ startISO, endISO });

  const heading = `Good morning! Here's today (${formatDayHeading(todayKey)}):`;
  if (events.length === 0) return `${heading}\nNothing on the calendar today.`;

  const lines = events.map((e) => `• ${formatEventLine(e, tz, names)}`);
  return [heading, ...lines].join("\n");
}

async function buildWeeklyDigestText(tz: string, names: Map<string, string>): Promise<string> {
  const todayKey = toCalendarDate(new Date().toISOString(), tz);
  const startISO = calendarDateToISO(todayKey, tz);
  const endISO = calendarDateToISO(addCalendarDays(todayKey, 7), tz);
  const events = await listEvents({ startISO, endISO });

  const heading = "Here's the week ahead:";
  if (events.length === 0) return `${heading}\nNothing on the calendar this week.`;

  const byDay = new Map<string, LuthEvent[]>();
  for (const event of events) {
    const key = toCalendarDate(event.start, tz);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(event);
    else byDay.set(key, [event]);
  }

  const sections = Array.from(byDay.keys())
    .sort()
    .map((key) => {
      const lines = byDay.get(key)!.map((e) => `  • ${formatEventLine(e, tz, names)}`);
      return [`${formatDayHeading(key)}:`, ...lines].join("\n");
    });

  return [heading, ...sections].join("\n\n");
}

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const tz = getFamilyTimeZone();
  const kind = resolveKind(request);
  const todayKey = toCalendarDate(new Date().toISOString(), tz);
  const dedupKey = kind === "daily" ? DAILY_SETTINGS_KEY : WEEKLY_SETTINGS_KEY;

  try {
    const chatGuid = getFamilyChatGuid();
    if (!chatGuid) {
      // No iMessage bridge configured yet — nowhere to deliver the digest.
      // Skip successfully (and don't mark it sent) instead of failing.
      return Response.json({ kind, skipped: true, reason: "FAMILY_CHAT_GUID not set" });
    }

    const lastSent = await getLastSent(dedupKey);
    if (lastSent === todayKey) {
      return Response.json({ kind, skipped: true, reason: "already sent for this date" });
    }

    const names = await getMemberNameMap();
    const text = kind === "daily" ? await buildDailyDigestText(tz, names) : await buildWeeklyDigestText(tz, names);

    await enqueueOutbound(chatGuid, text);
    await setLastSent(dedupKey, todayKey);

    return Response.json({ kind, skipped: false });
  } catch (err) {
    console.error("[api/cron/digest] failed", err);
    return Response.json({ error: "digest failed" }, { status: 500 });
  }
}

export const POST = GET;
