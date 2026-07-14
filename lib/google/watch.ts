import { randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { calendar_v3 } from "googleapis";

import { getDb } from "@/lib/db";
import { eventMeta, settings } from "@/lib/db/schema";
import { getCalendarClient, getFamilyCalendarId } from "./client";
import { CREATED_VIA_PROPERTY, MEMBER_IDS_PROPERTY } from "./constants";
import type { CreatedVia } from "./types";

const SETTINGS_KEY = "google_watch_channel";
const WEBHOOK_PATH = "/api/webhooks/google";

// Google will happily grant a shorter expiration than requested; we ask for
// a generous window and let a periodic cron (backend-dev's renew job) call
// renewWatchChannelIfNeeded() well before it's due.
const REQUESTED_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

interface WatchChannelState {
  channelId: string;
  resourceId: string;
  /** Epoch ms. */
  expiration: number;
  /** Google Calendar incremental-sync token; absent until the first successful sync. */
  syncToken?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The shared secret Google echoes back as X-Goog-Channel-Token on every notification. */
function getChannelToken(): string {
  return requireEnv("CRON_SECRET");
}

/** True if a notification's channel-token header matches our shared secret. Exported for the webhook route (and for tests). */
export function isValidChannelToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — an unset secret must never validate

  // Constant-time compare (crypto.timingSafeEqual requires equal-length
  // buffers, so a length mismatch is checked — and fails closed — first;
  // that length check is not itself timing-sensitive, since string length
  // isn't secret).
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(secret);
  if (tokenBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(tokenBuf, secretBuf);
}

function getWebhookAddress(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return `${explicit.replace(/\/$/, "")}${WEBHOOK_PATH}`;
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}${WEBHOOK_PATH}`;
  throw new Error(
    "Set APP_BASE_URL to a public https URL (Vercel deployments can rely on VERCEL_URL instead) before registering a Google watch channel",
  );
}

async function loadWatchState(): Promise<WatchChannelState | undefined> {
  const db = getDb();
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  return rows[0]?.value as WatchChannelState | undefined;
}

async function persistWatchState(state: WatchChannelState): Promise<void> {
  const db = getDb();
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: state, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: new Date() } });
}

async function stopWatchChannel(state: WatchChannelState): Promise<void> {
  const calendar = getCalendarClient();
  await calendar.channels.stop({ requestBody: { id: state.channelId, resourceId: state.resourceId } });
}

/** Registers a fresh Google Calendar watch channel and persists its state. Call once at setup, and again whenever renewWatchChannelIfNeeded() says it's time. */
export async function registerWatchChannel(): Promise<WatchChannelState> {
  const calendar = getCalendarClient();
  const calendarId = getFamilyCalendarId();

  const channelId = randomUUID();
  const requestedExpiration = Date.now() + REQUESTED_TTL_MS;

  const res = await calendar.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: getWebhookAddress(),
      token: getChannelToken(),
      expiration: String(requestedExpiration),
    },
  });

  if (!res.data.resourceId) {
    throw new Error("Google did not return a resourceId for the new watch channel");
  }

  // Preserve any existing syncToken — a new channel doesn't invalidate it.
  const previous = await loadWatchState().catch(() => undefined);
  const state: WatchChannelState = {
    channelId,
    resourceId: res.data.resourceId,
    expiration: Number(res.data.expiration ?? requestedExpiration),
    syncToken: previous?.syncToken,
  };

  await persistWatchState(state);
  return state;
}

/**
 * Renews the watch channel if it's within `thresholdMs` of expiring (or if
 * none is registered yet). Intended to be called from a daily cron
 * (backend-dev's app/api/cron/*) — Google gives no advance-warning webhook,
 * so renewal has to be polled for.
 */
export async function renewWatchChannelIfNeeded(thresholdMs = 1000 * 60 * 60 * 24): Promise<WatchChannelState | null> {
  const state = await loadWatchState().catch(() => undefined);
  if (state && state.expiration - Date.now() > thresholdMs) {
    return null; // still fresh
  }
  if (state) {
    await stopWatchChannel(state).catch((err) => console.error("[lib/google/watch] failed to stop expiring channel (continuing)", err));
  }
  return registerWatchChannel();
}

function isDbConfigured(): boolean {
  try {
    getDb();
    return true;
  } catch {
    return false;
  }
}

function isSyncTokenExpiredError(err: unknown): boolean {
  const status = (err as { code?: number; status?: number; response?: { status?: number } })?.status
    ?? (err as { code?: number })?.code
    ?? (err as { response?: { status?: number } })?.response?.status;
  return status === 410;
}

/**
 * @param isBackfill True when this event was discovered by a seed/backfill
 * sync (no syncToken — either the very first sync after channel
 * registration, or a post-410 resync), as opposed to a genuine incremental
 * syncToken diff. Only matters for the "never seen before" insert path below.
 */
async function upsertEventMetaFromGoogleEvent(event: calendar_v3.Schema$Event, isBackfill: boolean): Promise<void> {
  if (!event.id) return;
  const db = getDb();

  if (event.status === "cancelled") {
    await db.delete(eventMeta).where(eq(eventMeta.googleEventId, event.id));
    return;
  }

  const memberIdsRaw = event.extendedProperties?.private?.[MEMBER_IDS_PROPERTY];
  const createdViaRaw = event.extendedProperties?.private?.[CREATED_VIA_PROPERTY] as CreatedVia | undefined;

  let memberIds: string[] = [];
  try {
    if (memberIdsRaw) memberIds = JSON.parse(memberIdsRaw);
  } catch {
    memberIds = [];
  }

  const existing = await db
    .select({ id: eventMeta.id })
    .from(eventMeta)
    .where(eq(eventMeta.googleEventId, event.id))
    .limit(1);

  if (existing.length > 0) {
    // Already tracked — most likely one of LuthCal's own writes echoing back
    // through the webhook. Refresh memberIds but never touch announced_at /
    // reminded_at here: doing so would re-trigger an announcement/reminder
    // for something already handled synchronously in the agent flow.
    await db.update(eventMeta).set({ memberIds }).where(eq(eventMeta.googleEventId, event.id));
    return;
  }

  // First time we're seeing this Google event.
  //
  // - Genuine incremental diff (isBackfill === false, a real syncToken was
  //   used for this sync): this event is newly created/changed since our
  //   last known state — if it carries no luthcal tag, a family member added
  //   it directly in a calendar app; if it does carry a tag but has no
  //   event_meta row (e.g. the row was lost), back-fill one. Either way,
  //   flag it for announcement (announced_at null).
  // - Seed/backfill sync (isBackfill === true: the first sync after channel
  //   registration, or a post-410 resync — both have no syncToken to diff
  //   against): every pre-existing event on the calendar shows up here, not
  //   just newly-added ones. Treat these as already-known (announced_at
  //   now()) so the announce sweep doesn't flood the chat with the family's
  //   entire recent calendar the first time it runs. See docs/agent-core.md.
  await db.insert(eventMeta).values({
    googleEventId: event.id,
    memberIds,
    createdVia: createdViaRaw ?? "calendar_app",
    announcedAt: isBackfill ? new Date() : null,
  });
}

/**
 * Pulls the calendar's change diff (via syncToken if we have one, otherwise
 * a 30-day lookback window) and reconciles event_meta. Called by the webhook
 * route on every "exists" notification. Safe to call with no DB configured
 * (no-ops) and safe to call redundantly (idempotent upserts).
 */
export async function syncGoogleCalendarChanges(): Promise<{ processed: number }> {
  if (!isDbConfigured()) {
    return { processed: 0 }; // no DB configured — nothing to persist to
  }

  const calendar = getCalendarClient();
  const calendarId = getFamilyCalendarId();
  const state = await loadWatchState().catch(() => undefined);

  try {
    return await runSync(calendar, calendarId, state);
  } catch (err) {
    if (isSyncTokenExpiredError(err) && state?.syncToken) {
      // Google: "if the syncToken expires, the server will respond with a
      // 410 GONE ... client should clear its storage and perform a full
      // synchronization without any syncToken."
      await persistWatchState({ ...state, syncToken: undefined });
      return runSync(calendar, calendarId, { ...state, syncToken: undefined });
    }
    throw err;
  }
}

async function runSync(
  calendar: calendar_v3.Calendar,
  calendarId: string,
  state: WatchChannelState | undefined,
): Promise<{ processed: number }> {
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let processed = 0;

  // Whether this call is a seed/backfill (no syncToken to diff against) as
  // opposed to a genuine incremental sync. Computed once per call, not
  // per-page — a paginated continuation (pageToken) is still part of the
  // same logical sync as its first page.
  const isBackfill = !state?.syncToken;

  do {
    const res = await calendar.events.list({
      calendarId,
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
      pageToken,
      // syncToken/timeMin are mutually exclusive with each other and with
      // pageToken-based continuation; only send one "start" signal, on the
      // first page only.
      syncToken: pageToken ? undefined : state?.syncToken,
      timeMin: pageToken || state?.syncToken ? undefined : new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    });

    for (const event of res.data.items ?? []) {
      await upsertEventMetaFromGoogleEvent(event, isBackfill);
      processed++;
    }

    pageToken = res.data.nextPageToken ?? undefined;
    nextSyncToken = res.data.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  // If no channel is registered yet (state undefined), there's nowhere to
  // attach the syncToken — we just fall back to the timeMin lookback again
  // next time. Harmless (re-scans 30 days instead of the true diff), and
  // only possible before registerWatchChannel() has ever run.
  if (nextSyncToken && state) {
    await persistWatchState({ ...state, syncToken: nextSyncToken });
  }

  return { processed };
}
