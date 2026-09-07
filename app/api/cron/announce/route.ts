import { and, eq, isNull } from "drizzle-orm";

import { enqueueOutbound } from "@/lib/agent/outbound";
import { isAgentSilent } from "@/lib/agent/silent";
import { getDb } from "@/lib/db";
import { eventMeta } from "@/lib/db/schema";
import { getEvent, listPendingAnnouncements } from "@/lib/google/events";
import { getFamilyTimeZone } from "@/lib/google/time";
import { formatEventLine, getMemberNameMap } from "@/lib/message-format";
import { isValidCronRequest } from "@/lib/webhook-auth";

// Backup announce sweep: events created via the dashboard or added directly
// in a calendar app never got announced synchronously (the agent's own
// iMessage reply only covers imessage-sourced creates — see
// docs/agent-core.md §3 "Announcements"). This sweep picks up everything
// with event_meta.announced_at still null, formats it, and delivers it.

// Returns the family chat GUID, or null if the iMessage bridge isn't
// configured yet or the agent is in silent mode (lib/agent/silent.ts).
// Sweeps treat null as "nowhere to deliver" and skip gracefully (200)
// rather than failing — see the call site.
function getFamilyChatGuid(): string | null {
  if (isAgentSilent()) return null;
  return process.env.FAMILY_CHAT_GUID || null;
}

// F2 (tech-lead follow-up): this endpoint is externally pingable (see
// .github/workflows/cron-pinger.yml), so two overlapping sweeps are a real
// possibility. `event_meta` has no separate 'sending' status column like
// outbound_queue (announced_at is a nullable timestamp, not a status enum —
// changing that shape is lib/google/events.ts's territory, out of bounds
// here), so the claim is a per-row conditional UPDATE instead of the
// set-based claim used in lib/outbound-processor.ts: flip announced_at from
// NULL to now() *before* enqueuing, and only proceed if this call actually
// won that race (`.returning()` comes back empty if another concurrent
// sweep already claimed the row). If the enqueue itself then fails, the
// claim is rolled back (announced_at reset to NULL) so a later sweep
// retries it instead of silently losing the announcement.
async function tryClaimAnnouncement(googleEventId: string): Promise<boolean> {
  const db = getDb();
  const claimed = await db
    .update(eventMeta)
    .set({ announcedAt: new Date() })
    .where(and(eq(eventMeta.googleEventId, googleEventId), isNull(eventMeta.announcedAt)))
    .returning({ googleEventId: eventMeta.googleEventId });
  return claimed.length > 0;
}

async function releaseAnnouncementClaim(googleEventId: string): Promise<void> {
  const db = getDb();
  await db.update(eventMeta).set({ announcedAt: null }).where(eq(eventMeta.googleEventId, googleEventId));
}

export async function GET(request: Request) {
  if (!isValidCronRequest(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const tz = getFamilyTimeZone();
    const chatGuid = getFamilyChatGuid();
    if (!chatGuid) {
      // No iMessage bridge configured yet — nowhere to deliver announcements.
      // Skip successfully instead of failing the sweep (and the pinger).
      return Response.json({ skipped: isAgentSilent() ? "AGENT_SILENT" : "FAMILY_CHAT_GUID not set", announced: 0 });
    }
    const pending = await listPendingAnnouncements();

    if (pending.length === 0) {
      return Response.json({ announced: 0 });
    }

    const names = await getMemberNameMap();
    let announced = 0;
    for (const item of pending) {
      // Claim-before-send: skip this row entirely if another overlapping
      // sweep already claimed it since listPendingAnnouncements() ran.
      const claimed = await tryClaimAnnouncement(item.googleEventId);
      if (!claimed) continue;

      try {
        const event = await getEvent(item.googleEventId);
        if (!event) {
          // The event was deleted between being flagged pending and now (or
          // the id is stale) — nothing left to announce. The claim above
          // already marks it announced, so a dead id doesn't sit in the
          // pending queue forever.
          continue;
        }

        const verb = event.createdVia === "calendar_app" ? "New on the calendar" : "Added";
        await enqueueOutbound(chatGuid, `${verb}: ${formatEventLine(event, tz, names)}`);
        announced++;
      } catch (err) {
        // The claim succeeded but the fetch/enqueue after it failed — undo
        // the claim so a future sweep retries this event instead of it
        // silently never being announced.
        await releaseAnnouncementClaim(item.googleEventId);
        console.error("[api/cron/announce] failed to announce", item.googleEventId, err);
      }
    }

    return Response.json({ announced });
  } catch (err) {
    console.error("[api/cron/announce] failed", err);
    return Response.json({ error: "announce sweep failed" }, { status: 500 });
  }
}

export const POST = GET;
