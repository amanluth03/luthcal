import { timingSafeEqual } from "node:crypto";

// Shared, fail-closed constant-time secret checks for backend-dev's two auth
// surfaces: the BlueBubbles inbound webhook (BLUEBUBBLES_WEBHOOK_SECRET, via
// a `?secret=` query param — BlueBubbles' webhook sender can't set custom
// headers) and every /api/cron/* endpoint (CRON_SECRET, via the
// `Authorization: Bearer` header Vercel Cron sends, or `?secret=` for manual
// testing). Mirrors the pattern already established by
// lib/google/watch.ts's `isValidChannelToken` (constant-time, fails closed
// when the secret env var itself is unset) without importing from that
// module, which is senior-backend's territory.

/**
 * Constant-time string comparison. `timingSafeEqual` requires equal-length
 * buffers, so a length mismatch is checked (and fails closed) first — that
 * check is not itself timing-sensitive, since string length isn't secret.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * True if `provided` matches the BlueBubbles webhook shared secret
 * (BLUEBUBBLES_WEBHOOK_SECRET). Fails closed if the env var isn't set.
 */
export function isValidBlueBubblesWebhookSecret(provided: string | null): boolean {
  if (!provided) return false;
  const expected = process.env.BLUEBUBBLES_WEBHOOK_SECRET;
  if (!expected) return false;
  return constantTimeEqual(provided, expected);
}

/**
 * True if `request` carries the cron shared secret (CRON_SECRET), either as
 * `Authorization: Bearer <secret>` (what Vercel Cron sends) or `?secret=`
 * (for manual/local testing, e.g. `curl .../api/cron/outbound?secret=...`).
 * Fails closed if CRON_SECRET isn't set.
 */
export function isValidCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const authHeader = request.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
  const queryToken = new URL(request.url).searchParams.get("secret") ?? undefined;
  const provided = bearerToken ?? queryToken;
  if (!provided) return false;

  return constantTimeEqual(provided, secret);
}
