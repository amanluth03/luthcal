import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function buildOAuth2Client() {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN");

  const oauth2Client = new google.auth.OAuth2({ clientId, clientSecret });
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

let calendarClient: calendar_v3.Calendar | undefined;

/**
 * Lazy singleton, mirroring the getDb() pattern in lib/db/index.ts: reads
 * GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN and constructs the OAuth2 client only
 * on first use, so `next build` (which imports this module transitively with
 * no Google env vars configured) never throws. Safe to cache across calls —
 * the underlying OAuth2Client refreshes its access token from the refresh
 * token automatically as needed.
 */
export function getCalendarClient(): calendar_v3.Calendar {
  if (!calendarClient) {
    calendarClient = google.calendar({ version: "v3", auth: buildOAuth2Client() });
  }
  return calendarClient;
}

/** The shared "Luthra Family" calendar's id — the single source of truth for all LuthCal event math. */
export function getFamilyCalendarId(): string {
  return requireEnv("FAMILY_CALENDAR_ID");
}
