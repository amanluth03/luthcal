import { and, eq, isNull } from "drizzle-orm";

import { enqueueOutbound } from "@/lib/agent/outbound";
import { isAgentSilent } from "@/lib/agent/silent";
import { getDb } from "@/lib/db";
import { eventMeta, settings } from "@/lib/db/schema";
import { listUpcomingEventsPendingReminder } from "@/lib/google/events";
import { getFamilyTimeZone } from "@/lib/google/time";
import { formatEventLine, getMemberNameMap } from "@/lib/message-format";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Reminder sweep: events starting soon that haven't been reminded about yet.
// See docs/agent-core.md §3 "Reminders" — listUpcomingEventsPendingReminder
// (lib/google/events.ts, senior-backend's) finds the candidate set; this
// route decides the lead time, formats, delivers, and does its own dedup
// claim (below) rather than calling that file's `markReminded` directly.
//
// F2 (tech-lead follow-up): this endpoint is externally pingable (see
// .github/workflows/cron-pinger.yml) the same as /api/cron/announce, so two
// overlapping sweeps both observing the same event as reminder-pending is a
// real race, not theoretical — the previous shape here
// (listUpcomingEventsPendingReminder -> enqueueOutbound -> unconditional
// markReminded) let both sweeps enqueue the same reminder before either
// marked it done, i.e. a duplicate family text. Fixed by mirroring the
// announce route's claim pattern exactly: tryClaimReminder flips
// event_meta.reminded_at from NULL to now() *before* enqueuing, and only
// proceeds if this call actually won that race (`.returning()` comes back
// empty if another concurrent sweep already claimed the row); if the enqueue
// after a successful claim then fails, releaseReminderClaim resets
// reminded_at back to NULL so a later sweep retries instead of the reminder
// being silently lost. lib/google/events.ts's `markReminded` is left as-is
// (still used directly by tests/google/event-meta-dedup.test.ts) — this
// route just no longer calls it, since an unconditional update can't be the
// basis of a claim.

const DEFAULT_REMINDER_LEAD_MS = 2 * 60 * 60 * 1000; // 2h, per the task brief's default
const REMINDER_LEAD_SETTINGS_KEY = "reminder_lead_ms";

// Returns the family chat GUID, or null if the iMessage bridge isn't
// configured yet or the agent is in silent mode (lib/agent/silent.ts). The
// sweep treats null as "nowhere to deliver" and skips gracefully (200)
// rather than failing — see the call site.
function getFamilyChatGuid(): string | null {
  if (isAgentSilent()) return null;
  return process.env.FAMILY_CHAT_GUID || null;
}

/** Claims a reminder for `googleEventId` by flipping reminded_at NULL -> now() iff it's still NULL. Returns whether this call won the claim (false means another sweep already has it). */
async function tryClaimReminder(googleEventId: string): Promise<boolean> {
  const db = getDb();
  const claimed = await db
    .update(eventMeta)
    .set({ remindedAt: new Date() })
    .where(and(eq(eventMeta.googleEventId, googleEventId), isNull(eventMeta.remindedAt)))
    .returning({ googleEventId: eventMeta.googleEventId });
  return claimed.length > 0;
}

/** Rolls back a claim (reminded_at -> NULL) after a claimed enqueue fails, so a later sweep retries instead of the reminder being silently lost. */
async function releaseReminderClaim(googleEventId: string): Promise<void> {
  const db = getDb();
  await db.update(eventMeta).set({ remindedAt: null }).where(eq(eventMeta.googleEventId, googleEventId));
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
    const chatGuid = getFamilyChatGuid();
    if (!chatGuid) {
      // No iMessage bridge configured yet — nowhere to deliver reminders.
      // Skip successfully instead of failing the sweep (and the pinger).
      return Response.json({ skipped: isAgentSilent() ? "AGENT_SILENT" : "FAMILY_CHAT_GUID not set", reminded: 0 });
    }
    const leadMs = await getReminderLeadMs();
    const events = await listUpcomingEventsPendingReminder(leadMs);

    if (events.length === 0) {
      return Response.json({ reminded: 0 });
    }

    const names = await getMemberNameMap();
    let reminded = 0;
    for (const event of events) {
      // Claim-before-send: skip this event entirely if another overlapping
      // sweep already claimed it since listUpcomingEventsPendingReminder()
      // ran.
      const claimed = await tryClaimReminder(event.id);
      if (!claimed) continue;

      try {
        await enqueueOutbound(chatGuid, `Reminder: ${formatEventLine(event, tz, names)}`);
        reminded++;
      } catch (err) {
        // The claim succeeded but the enqueue after it failed — undo the
        // claim so a future sweep retries this event instead of it silently
        // never being reminded.
        await releaseReminderClaim(event.id);
        console.error("[api/cron/reminders] failed to remind", event.id, err);
      }
    }

    return Response.json({ reminded });
  } catch (err) {
    console.error("[api/cron/reminders] failed", err);
    return Response.json({ error: "reminders sweep failed" }, { status: 500 });
  }
}

export const POST = GET;
