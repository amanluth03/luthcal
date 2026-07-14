import { asc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { outboundQueue } from "@/lib/db/schema";
import { sendGroupMessage } from "@/lib/bluebubbles";

// Drains `outbound_queue`: the retry sweep that delivers everything queued
// while the Mac/BlueBubbles bridge was asleep or unreachable. Per
// CLAUDE.md's "Outbound iMessages" convention, this is the *only* code path
// that actually calls sendGroupMessage — lib/agent/outbound.ts's
// enqueueOutbound() just writes a pending row.

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 5;

export interface ProcessOutboundQueueResult {
  sent: number;
  failed: number;
  stillPending: number;
}

/**
 * Selects pending rows (oldest first, capped at `batchSize`), attempts a
 * send for each, and updates status accordingly:
 *  - success -> status 'sent', sentAt set.
 *  - failure, under the attempts ceiling -> stays 'pending', attempts++,
 *    lastError recorded, so the next sweep retries it.
 *  - failure, at/past the ceiling (or a non-retryable failure, e.g. a bad
 *    chatGuid that will never succeed) -> status 'failed', attempts++,
 *    lastError recorded. Terminal — no further sweep picks it up.
 *
 * Idempotent and safe to run every few minutes indefinitely: a send failure
 * for one row is caught and recorded, never thrown, so one bad row (or a
 * fully-asleep Mac) can't abort the rest of the batch or the cron
 * invocation itself.
 */
export async function processOutboundQueue(opts?: {
  batchSize?: number;
  maxAttempts?: number;
}): Promise<ProcessOutboundQueueResult> {
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const db = getDb();
  const rows = await db
    .select()
    .from(outboundQueue)
    .where(eq(outboundQueue.status, "pending"))
    .orderBy(asc(outboundQueue.createdAt))
    .limit(batchSize);

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const result = await sendGroupMessage(row.chatGuid, row.text);

      if (result.ok) {
        await db.update(outboundQueue).set({ status: "sent", sentAt: new Date() }).where(eq(outboundQueue.id, row.id));
        sent++;
        continue;
      }

      const attempts = row.attempts + 1;
      const giveUp = attempts >= maxAttempts || !result.retryable;
      await db
        .update(outboundQueue)
        .set({
          attempts,
          lastError: `[${result.status}] ${result.error}`.slice(0, 2000),
          status: giveUp ? "failed" : "pending",
        })
        .where(eq(outboundQueue.id, row.id));
      if (giveUp) failed++;
    } catch (err) {
      // sendGroupMessage only throws for a genuine misconfiguration
      // (BLUEBUBBLES_URL/PASSWORD unset) — guard anyway so that can't take
      // down the whole sweep either; record it the same way as a send
      // failure would be.
      const attempts = row.attempts + 1;
      const giveUp = attempts >= maxAttempts;
      const message = err instanceof Error ? err.message : String(err);
      try {
        await db
          .update(outboundQueue)
          .set({ attempts, lastError: message.slice(0, 2000), status: giveUp ? "failed" : "pending" })
          .where(eq(outboundQueue.id, row.id));
      } catch (dbErr) {
        console.error("[lib/outbound-processor] failed to record error for row", row.id, dbErr);
      }
      if (giveUp) failed++;
    }
  }

  return { sent, failed, stillPending: rows.length - sent - failed };
}
