import type {
  ActivityEntry,
  DigestEntry,
  FamilyMember,
  LuthEvent,
  Settings,
} from "./types";
import { ACTIVITY, DIGESTS, EVENTS, FAMILY_MEMBERS, SETTINGS } from "./seed";

/**
 * The one interface every dashboard page/component talks to. Swapping mock
 * data for the real backend (lib/db + lib/google) later should mean
 * reimplementing `DataAdapter` in one new file and changing the single
 * `export const dataAdapter = ...` line at the bottom of this file — nothing
 * upstream should need to change.
 */
export interface DataAdapter {
  getFamilyMembers(): Promise<FamilyMember[]>;
  /** rangeStart/rangeEnd are ISO 8601 date-time strings (inclusive/exclusive
   * per the real Google Calendar API convention). */
  getEvents(rangeStart: string, rangeEnd: string): Promise<LuthEvent[]>;
  getDigests(): Promise<DigestEntry[]>;
  getActivity(): Promise<ActivityEntry[]>;
  getSettings(): Promise<Settings>;
}

class MockDataAdapter implements DataAdapter {
  // SWAP POINT: replace with `lib/db` query (familyMembers table) via getDb().
  async getFamilyMembers(): Promise<FamilyMember[]> {
    return FAMILY_MEMBERS;
  }

  // SWAP POINT: replace with a `lib/google` Calendar Events.list call scoped
  // to FAMILY_CALENDAR_ID, joined with `event_meta` for memberIds/createdVia.
  async getEvents(rangeStart: string, rangeEnd: string): Promise<LuthEvent[]> {
    const start = Date.parse(rangeStart);
    const end = Date.parse(rangeEnd);
    return EVENTS.filter((e) => {
      const eStart = Date.parse(e.start);
      const eEnd = Date.parse(e.end);
      return eStart < end && eEnd > start;
    });
  }

  // SWAP POINT: replace with a query over outbound_queue / a dedicated
  // digest log, filtered to kind and ordered by sentAt desc.
  async getDigests(): Promise<DigestEntry[]> {
    return [...DIGESTS].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }

  // SWAP POINT: replace with a `lib/db` query (message_log table), joined to
  // family_members for display names, ordered by createdAt desc.
  async getActivity(): Promise<ActivityEntry[]> {
    return [...ACTIVITY].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // SWAP POINT: replace with a `lib/db` query (settings table), unpacked
  // from its key/value rows into a single Settings object.
  async getSettings(): Promise<Settings> {
    return SETTINGS;
  }
}

export const dataAdapter: DataAdapter = new MockDataAdapter();

/**
 * The Family and Settings pages need "mock mutations — optimistic UI +
 * toast, no real persistence yet" (per spec). Real writes belong in Server
 * Actions or route handlers once a backend exists, so on purpose there is no
 * write path here: those pages hold their own client-side React state
 * (seeded from the functions above) and simulate a save with `mockDelay`.
 * Nothing is mutated in this module — reloading the page always resets to
 * the seed data.
 */
export function mockDelay(ms = 450): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
