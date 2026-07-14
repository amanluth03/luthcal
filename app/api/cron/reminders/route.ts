import { eq } from "drizzle-orm";

import { enqueueOutbound } from "@/lib/agent/outbound";
import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { listUpcomingEventsPendingReminder, markReminded } from "@/lib/google/events";
import { getFamilyTimeZone } from "@/lib/google/time";
import { formatEventLine, getMemberNameMap } from "@/lib/message-format";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Reminder sweep: events starting soon that haven't been reminded about yet.
// See docs/agent-core.md §3 "Reminders" — listUpcomingEventsPendingReminder /
// markReminded (lib/google/events.ts, senior-backend's) do all the
// dedup-relevant event_meta.reminded_at bookkeeping; this route just decides
// the lead time, formats, and delivers.

const DEFAULT_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000; // 2h, per the task brief's default
const REMINDER_LEAD_SETTINGS_KEY = "reminder_lead_ms";

function requireFamilyChatGuid(): string {
  const guid = process.env.FAMILY_CHAT_GUID;
  if (!guid) throw new Error("FAMILY_CHAT_GUID is not set");
  return guid;
}

/** Reads the configured reminder lead time (ms) from `settings`, e.g. `{ key: "reminder_lead_ms", value: 7200000 }`. Falls back to the 2h default if unset or the DB isn't configured. */
async function getReminderLeadMs(): Promise<number> {
  try {
    const db = getDb();
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, REMINDER_LEAD_SETTINGS_KEY))
      .limit(1);
    const raw = rows[0]?.value;
    return typeof raw === "number" && raw > 0 ? raw : DEFAULT_REMINDER_LEAD_MS;
  } catch {
    return DEFAULT_REMINDER_LEAD_MS;
  }
}

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const tz = getFamilyTimeZone();
    const chatGuid = requireFamilyChatGuid();
    const leadMs = await getReminderLeadMs();
    const events = await listUpcomingEventsPendingReminder(leadMs);

    if (events.length === 0) {
      return Response.json({ reminded: 0 });
    }

    const names = await getMemberNameMap();
    let reminded = 0;
    for (const event of events) {
      await enqueueOutbound(chatGuid, `Reminder: ${formatEventLine(event, tz, names)}`);
      // Marked immediately after a successful enqueue (not batched at the
      // end) so a mid-sweep crash only risks re-reminding whichever single
      // event was in flight, never the whole batch — consistent with "a
      // repeated sweep sends nothing" for everything already marked.
      await markReminded(event.id);
      reminded++;
    }

    return Response.json({ reminded });
  } catch (err) {
    console.error("[api/cron/reminders] failed", err);
    return Response.json({ error: "reminders sweep failed" }, { status: 500 });
  }
}

export const POST = GET;
