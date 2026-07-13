// Typed shapes for the dashboard's mock data layer.
//
// These mirror the real Drizzle model in `lib/db/schema.ts` closely enough that
// swapping the mock adapter (`lib/mock/adapter.ts`) for a real one backed by
// `lib/db` + `lib/google` should only require changing that one file — every
// component in `app/(dashboard)` and `components/` is written against these
// types and the `DataAdapter` interface, never against the mock data directly.

/** Semantic color tokens — see the `--member-*` CSS variables in globals.css.
 * Storing a token (not a raw hex/oklch value) keeps color rendering consistent
 * across light/dark mode and lets the palette be redefined in one place. */
export type MemberColor =
  | "blue"
  | "violet"
  | "rose"
  | "teal"
  | "amber"
  | "green"
  | "slate";

export interface FamilyMember {
  id: string;
  name: string;
  /** BlueBubbles / iMessage handle — phone number or email. May be unset for
   * members who don't text the group directly (e.g. young kids). */
  imessageHandle: string | null;
  phone: string | null;
  color: MemberColor;
  /** Alternate names the agent should recognize in free-text messages
   * ("Dad", "MJ", "the boy") when matching a member. */
  aliases: string[];
  createdAt: string;
}

export type EventSource = "imessage" | "dashboard" | "calendar_app";

export interface LuthEvent {
  id: string;
  title: string;
  /** ISO 8601, always in UTC on the wire — render in FAMILY_TZ at the edges. */
  start: string;
  end: string;
  allDay: boolean;
  memberIds: string[];
  notes?: string;
  location?: string;
  createdVia?: EventSource;
}

export type DigestKind = "daily" | "weekly" | "announcement";

export interface DigestEntry {
  id: string;
  kind: DigestKind;
  /** ISO 8601 timestamp of when the agent sent this to the group chat. */
  sentAt: string;
  text: string;
  relatedEventIds?: string[];
}

export type ActivityDirection = "inbound" | "outbound";

export type ActivityActionType =
  | "create_event"
  | "update_event"
  | "delete_event"
  | "flag_conflict"
  | "send_digest"
  | "send_reminder"
  | "needs_clarification"
  | "no_action";

export interface ActivityAction {
  type: ActivityActionType;
  summary: string;
  eventId?: string;
}

export interface ActivityEntry {
  id: string;
  direction: ActivityDirection;
  /** Display name of the sender — a family member's name, or "Agent" for
   * outbound messages the agent sent back to the chat. */
  sender: string;
  text: string;
  action?: ActivityAction;
  createdAt: string;
}

export type WeekdayName =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export interface Settings {
  dailyDigestEnabled: boolean;
  /** 24h "HH:mm" local to `timezone`. */
  dailyDigestTime: string;
  weeklyDigestEnabled: boolean;
  weeklyDigestDay: WeekdayName;
  weeklyDigestTime: string;
  /** How many hours before an event start the agent sends a reminder text. */
  reminderLeadHours: number;
  /** IANA timezone, e.g. "America/Chicago" — mirrors env var FAMILY_TZ. */
  timezone: string;
}
