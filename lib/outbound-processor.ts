import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { outboundQueue } from "@/lib/db/schema";
import { sendGroupMessage } from "@/lib/bluebubbles";

// Drains `outbound_queue`: the retry sweep that delivers everything queued
// while the Mac/BlueBubbles bridge was asleep or unreachable. Per
// CLAUDE.md's "Outbound iMessages" convention, this is the *only* code path
// that actually calls sendGroupMessage — lib/agent/outbound.ts's
// enqueueOutbound() just writes a pending row.
//
// F2 (tech-lead follow-up): /api/cron/outbound is externally pingable (see
// .github/workflows/cron-pinger.yml), so overlapping invocations are a real
// possibility, not just a theoretical race — a slow send or a retried GH
// Actions ping can easily land two sweeps mid-flight at once. A plain
// `SELECT ... WHERE status='pending'` followed by a later `UPDATE` (the
// previous shape of this function) lets both sweeps select the same row and
// both call sendGroupMessage, delivering a family text twice. Fixed with a
// single atomic claim statement below: one UPDATE ... WHERE id IN (SELECT
// ... FOR UPDATE SKIP LOCKED) moves a batch of rows pending -> sending in
// one round trip, so a row only ever ends up in one sweep's claimed set.
// This is a single SQL statement (one HTTP call over neon-http), so it's
// atomic at the Postgres level without needing an explicit multi-statement
// transaction.
//
// F1 (tech-lead follow-up): the atomic claim above closed the double-send
// race, but opened a message-loss one — if the function running a sweep is
// killed (timeout/crash) after the claim UPDATE commits but before a claimed
// row is resolved to 'sent'/'failed', that row is stuck in 'sending'
// forever; nothing ever moves it back to 'pending', so it's silently never
// delivered. On the one code path whose entire purpose is guaranteed
// delivery while the Mac bridge is often asleep, permanent silent loss is
// worse than the double-send the claim fixed. A blanket `sending -> pending`
// reset isn't acceptable either — it would re-race any sweep that's still
// legitimately mid-flight. Fixed with a time-bounded stale-claim reaper:
// `claimedAt` (lib/db/schema.ts) records when a row was claimed, and
// `reapStaleClaims` (called at the top of every `processOutboundQueue` run,
// before the claim query) returns any row still 'sending' after
// `STALE_CLAIM_MS` back to 'pending' for a future sweep to pick up. The
// threshold just needs to safely exceed the max realistic function runtime
// — 10 minutes is comfortably past any Vercel function timeout in play here.
// **Accepted residual risk:** a bounded double-send window remains if a
// sweep crashes *after* `sendGroupMessage` actually succeeded but *before*
// the row is updated to 'sent' — the reaper will re-claim and re-send that
// row once the threshold passes. This is strictly better than the
// pre-reaper failure mode (permanent loss) and, unlike a naive blanket
// reset, only affects a row that's been stuck for the full threshold, not
// one a live sweep is still legitimately working through.

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_ATTEMPTS = 5;
const STALE_CLAIM_MS = 10 * 60 * 1000; // 10 minutes — see F1 note above.

export interface ProcessOutboundQueueResult {
  sent: number;
  failed: number;
  stillPending: number;
}

/**
 * Returns any row still 'sending' after `STALE_CLAIM_MS` back to 'pending'
 * (clearing `claimedAt`) so a crashed/killed sweep can't strand it forever.
 * One round trip, run before the claim query on every `processOutboundQueue`
 * call — see the F1 note above for why this is time-bounded rather than a
 * blanket reset. `claimedAt IS NULL` is also swept up defensively: it can
 * only happen for a 'sending' row claimed before this column existed, which
 * is by definition stale (every claim since sets it).
 */
async function reapStaleClaims(db: ReturnType<typeof getDb>): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  await db
    .update(outboundQueue)
    .set({ status: "pending", claimedAt: null })
    .where(
      and(
        eq(outboundQueue.status, "sending"),
        or(isNull(outboundQueue.claimedAt), lt(outboundQueue.claimedAt, cutoff)),
      ),
    );
}

/**
 * Atomically claims up to `batchSize` pending rows (oldest first, moving
 * them to 'sending' so no other concurrent sweep can also claim them), then
 * attempts a send for each and updates status accordingly:
 *  - success -> status 'sent', sentAt set.
 *  - failure, under the attempts ceiling -> back to 'pending', attempts++,
 *    lastError recorded, so the next sweep retries it.
 *  - failure, at/past the ceiling (or a non-retryable failure, e.g. a bad
 *    chatGuid that will never succeed) -> status 'failed', attempts++,
 *    lastError recorded. Terminal — no further sweep picks it up.
 *
 * Idempotent and safe to run every few minutes indefinitely (including
 * overlapping with itself): a send failure for one row is caught and
 * recorded, never thrown, so one bad row (or a fully-asleep Mac) can't abort
 * the rest of the batch or the cron invocation itself. A row that's already
 * been claimed by another in-flight sweep simply isn't in this sweep's
 * claimed set, so it's never touched twice.
 */
export async function processOutboundQueue(opts?: {
  batchSize?: number;
  maxAttempts?: number;
}): Promise<ProcessOutboundQueueResult> {
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const db = getDb();

  // F1: reap any claim a previous, now-dead sweep never finished before
  // claiming a fresh batch — see the module-level note above.
  await reapStaleClaims(db);

  // Set-based atomic claim: pick the oldest `batchSize` pending rows,
  // locking them (FOR UPDATE SKIP LOCKED — so a concurrent claim query
  // skips rows already locked by another in-flight sweep rather than
  // blocking on them), and flip them to 'sending' in the same statement.
  // `.returning()` hands back exactly the rows *this* invocation claimed.
  const claimQuery = db
    .select({ id: outboundQueue.id })
    .from(outboundQueue)
    .where(eq(outboundQueue.status, "pending"))
    .orderBy(asc(outboundQueue.createdAt))
    .limit(batchSize)
    .for("update", { skipLocked: true });

  const rows = await db
    .update(outboundQueue)
    .set({ status: "sending", claimedAt: new Date() })
    .where(inArray(outboundQueue.id, claimQuery))
    .returning();

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const result = await sendGroupMessage(row.chatGuid, row.text);

      if (result.ok) {
        await db
          .update(outboundQueue)
          .set({ status: "sent", sentAt: new Date(), claimedAt: null })
          .where(eq(outboundQueue.id, row.id));
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
          // Row is leaving 'sending' either way (back to 'pending' for retry,
          // or terminal 'failed') — clear the claim so it's clean for reuse.
          claimedAt: null,
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
          .set({ attempts, lastError: message.slice(0, 2000), status: giveUp ? "failed" : "pending", claimedAt: null })
          .where(eq(outboundQueue.id, row.id));
      } catch (dbErr) {
        console.error("[lib/outbound-processor] failed to record error for row", row.id, dbErr);
      }
      if (giveUp) failed++;
    }
  }

  return { sent, failed, stillPending: rows.length - sent - failed };
}
