import { tool } from "ai";
import { z } from "zod";

import { checkConflicts as gCheckConflicts } from "@/lib/google/conflicts";
import {
  createEvent as gCreateEvent,
  deleteEvent as gDeleteEvent,
  listEvents as gListEvents,
  updateEvent as gUpdateEvent,
} from "@/lib/google/events";
import { enqueueOutbound } from "./outbound";

/** Where this agent run originated. Determines event_meta.created_via and the announcement path — see docs/agent-core.md. */
export type AgentSource = "imessage" | "dashboard";

export interface AgentToolContext {
  source: AgentSource;
  /** The iMessage group chat this run is attached to. Required for source "imessage"; sendGroupMessage falls back to FAMILY_CHAT_GUID otherwise. */
  chatGuid?: string;
}

// Dates: tools accept ISO 8601. The agent resolves natural language ("next
// Tuesday at 3", "tomorrow morning") into ISO using the current date/time
// given in the system prompt. A bare (no offset) date-time like
// "2026-07-14T15:00:00" is accepted too and is interpreted as that wall-clock
// time in the family's timezone — see lib/google/time.ts `parseFlexibleISO`.
const isoDateTime = z
  .string()
  .describe(
    "ISO 8601 date-time, e.g. 2026-07-14T15:00:00-05:00 or 2026-07-14T15:00:00 (bare local time, interpreted in the family timezone). For all-day events, any time on the intended calendar day is fine.",
  );

// All-day events use Google's own *exclusive* end-boundary convention (see
// lib/google/types.ts): endISO is one calendar day past the last day the
// event covers, so a single-day all-day event has endISO exactly one day
// after startISO. This has to be spelled out to the model explicitly since
// it's the opposite of how people naturally phrase "an all-day event on
// Tuesday" (inclusive).
const endISOWithAllDayNote = isoDateTime.describe(
  "ISO 8601 date-time, e.g. 2026-07-14T15:00:00-05:00 or 2026-07-14T15:00:00 (bare local time, interpreted in the family timezone). If allDay is true, this is the *exclusive* end boundary: one calendar day past the last day the event covers. A single-day all-day event therefore has endISO exactly one calendar day after startISO (e.g. an all-day event on July 14th has startISO on the 14th and endISO on the 15th).",
);

function requireFamilyChatGuid(): string {
  const guid = process.env.FAMILY_CHAT_GUID;
  if (!guid) throw new Error("FAMILY_CHAT_GUID is not set; cannot send a group message.");
  return guid;
}

/**
 * Builds the agent's tool set, closing over the run's context so the model
 * itself never chooses `createdVia` or the destination chat — those are
 * derived from how this run was invoked (iMessage webhook vs. dashboard
 * chat), not from anything the LLM outputs.
 */
export function buildAgentTools(ctx: AgentToolContext) {
  return {
    createEvent: tool({
      description:
        "Create a new event on the shared family calendar. After calling this for an event with assigned members, call checkConflicts for the same time range and members, and mention any conflicts in your reply.",
      inputSchema: z.object({
        title: z.string().describe("Short event title, e.g. 'Maya - dentist'."),
        startISO: isoDateTime,
        endISO: endISOWithAllDayNote,
        allDay: z.boolean().optional().describe("True for all-day events. Defaults to false."),
        memberIds: z.array(z.string()).describe("family_members.id values this event is for."),
        notes: z.string().optional(),
        location: z.string().optional(),
      }),
      execute: async ({ title, startISO, endISO, allDay, memberIds, notes, location }) => {
        const event = await gCreateEvent({
          title,
          startISO,
          endISO,
          allDay,
          memberIds,
          notes,
          location,
          createdVia: ctx.source,
        });
        return { event };
      },
    }),

    updateEvent: tool({
      description:
        "Update an existing event's title, time, members, or notes. Only pass the fields that are changing. After changing the time or members, call checkConflicts and mention any conflicts.",
      inputSchema: z.object({
        googleEventId: z.string(),
        title: z.string().optional(),
        startISO: isoDateTime.optional(),
        endISO: endISOWithAllDayNote.optional(),
        allDay: z.boolean().optional(),
        memberIds: z.array(z.string()).optional(),
        notes: z.string().optional(),
        location: z.string().optional(),
      }),
      execute: async (input) => {
        const event = await gUpdateEvent(input);
        return { event };
      },
    }),

    deleteEvent: tool({
      description: "Cancel/delete an event from the shared family calendar.",
      inputSchema: z.object({ googleEventId: z.string() }),
      execute: async ({ googleEventId }) => {
        await gDeleteEvent(googleEventId);
        return { deleted: true, googleEventId };
      },
    }),

    listEvents: tool({
      description:
        "List events on the shared family calendar within a time range, optionally filtered to one family member. Use this to answer schedule questions, and to find an event's googleEventId before calling updateEvent/deleteEvent.",
      inputSchema: z.object({
        startISO: isoDateTime,
        endISO: isoDateTime,
        memberId: z.string().optional(),
      }),
      execute: async ({ startISO, endISO, memberId }) => {
        const events = await gListEvents({ startISO, endISO, memberId });
        return { events };
      },
    }),

    checkConflicts: tool({
      description:
        "Check whether a time range overlaps with any existing calendar events for the given members. Always call this right after creating or moving an event that has members assigned, and surface any conflicts to the user with a warning.",
      inputSchema: z.object({
        startISO: isoDateTime,
        endISO: isoDateTime,
        memberIds: z.array(z.string()),
        allDay: z.boolean().optional(),
        excludeGoogleEventId: z
          .string()
          .optional()
          .describe("Pass the event's own id when checking conflicts for an update, so it doesn't conflict with itself."),
      }),
      execute: async (input) => {
        const conflicts = await gCheckConflicts(input);
        return { conflicts };
      },
    }),

    sendGroupMessage: tool({
      description:
        "Send an extra, standalone message to the family group chat. Your normal reply already reaches the chat — only use this for a follow-up message outside the normal reply/response flow.",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        const chatGuid = ctx.chatGuid ?? requireFamilyChatGuid();
        await enqueueOutbound(chatGuid, text);
        return { queued: true };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
