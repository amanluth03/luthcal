import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { checkConflicts as gCheckConflicts } from "@/lib/google/conflicts";
import { findNearDuplicateEvent } from "@/lib/google/duplicates";
import {
  createEvent as gCreateEvent,
  deleteEvent as gDeleteEvent,
  listEvents as gListEvents,
  updateEvent as gUpdateEvent,
} from "@/lib/google/events";
import { matchMember, type RosterMember } from "./match-member";
import { forgetMemory, rememberMemory, searchHistory as searchFamilyHistory } from "./memory";
import { enqueueOutbound } from "./outbound";
import { isAgentSilent } from "./silent";

/** Where this agent run originated. Determines event_meta.created_via and the announcement path — see docs/agent-core.md. */
export type AgentSource = "imessage" | "dashboard";

export interface AgentToolContext {
  source: AgentSource;
  /** The iMessage group chat this run is attached to. Required for source "imessage"; sendGroupMessage falls back to FAMILY_CHAT_GUID otherwise. */
  chatGuid?: string;
  /** The family roster this run resolved at prompt-build time — reused here (rather than re-fetched) so createEvent/updateEvent can deterministically resolve memberNames -> ids against the exact same roster the model was shown. */
  roster: RosterMember[];
  /**
   * Passive-listener engagement mode (see lib/agent/index.ts's
   * RunAgentParams.engagementMode and docs/agent-core.md's passive-listener
   * section). Defaults to "act" — the current, unrestricted tool set —
   * when omitted, so every existing caller (dashboard, and any test that
   * doesn't pass this) is unaffected. "suggest" is the deterministic half
   * of the passive-suggestion contract: buildAgentTools below physically
   * removes createEvent/updateEvent/deleteEvent from the returned tool set
   * rather than relying solely on the system-prompt instruction (which
   * accompanies this for the human-readable "why") — the same
   * belt-and-suspenders shape as the other deterministic backstops in this
   * file (member-matching, duplicate-detection): a prompt instruction alone
   * is never trusted as the sole guard against a mutating action.
   */
  mode?: "act" | "suggest";
  /**
   * The run's resolved sender — `resolveSenderMemberId(senderHandle, roster)`
   * (see lib/agent/resolve-sender.ts), hoisted in lib/agent/index.ts's
   * `runAgent` so it can be reused here as the `remember` tool's
   * `created_by_member_id` (who told the agent to remember something),
   * without a second lookup. `undefined` when the sender didn't resolve to
   * a roster member — `remember` just saves the memory without a creator.
   */
  senderMemberId?: string;
}

/**
 * Resolves each of `names` against `roster` via `matchMember` (see
 * lib/agent/match-member.ts). This is the deterministic member-matching
 * backstop documented in docs/agent-core.md §2: the model never emits a
 * `family_members.id` directly for createEvent/updateEvent — it emits the
 * name/alias text it read in the conversation, and *this* function, not the
 * model, decides what id that resolves to. A name that matches more than
 * one roster member short-circuits the whole batch and reports back which
 * one, so a wrong-person event can't be created just because the model
 * would have guessed.
 *
 * A name that matches nobody on the roster (`kind: "none"`) is not treated
 * as an error — it's dropped (contributes no id) and reported back in
 * `unresolved`, since it's just as likely to be a real non-family person
 * (a friend's name in "playdate with Emma") as a typo.
 */
function resolveMemberNames(
  names: string[],
  roster: RosterMember[],
): { memberIds: string[]; unresolved: string[] } | { ambiguousName: string; candidates: RosterMember[] } {
  const memberIds: string[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const result = matchMember(name, roster);
    if (result.kind === "ambiguous") {
      return { ambiguousName: name, candidates: result.candidates };
    }
    if (result.kind === "unique") {
      if (!memberIds.includes(result.member.id)) memberIds.push(result.member.id);
    } else {
      unresolved.push(name);
    }
  }
  return { memberIds, unresolved };
}

const memberNamesDescription =
  "Family member name(s)/alias(es) this event is for, exactly as referenced in the conversation and matching the roster above (e.g. 'Maya', 'mom') — NOT a family_members.id. Resolved deterministically server-side; if a name matches more than one roster member, the call returns an ambiguousMember result instead of a created/updated event and you must ask the user which person they meant rather than guessing, then call this tool again once they've clarified.";

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
 *
 * In `mode: "suggest"` (passive-listener event-detection, not an explicit
 * mention — see AgentToolContext.mode and docs/agent-core.md), the
 * mutating tools are omitted from the returned object entirely: the model
 * has no way to call createEvent/updateEvent/deleteEvent this turn even if
 * it tried, regardless of what the system prompt says or how the model
 * chooses to (mis)read it.
 */
export function buildAgentTools(ctx: AgentToolContext): ToolSet {
  const allTools = {
    createEvent: tool({
      description:
        "Create a new event on the shared family calendar. First checks for a near-identical event that already exists (same title, overlapping time, same family member(s)) — if one is found, NOTHING is created and the result includes duplicateFound instead of event; ask the user to confirm before calling this again with confirmDuplicate: true. After actually creating an event with assigned members, call checkConflicts for the same time range and members, and mention any conflicts in your reply.",
      inputSchema: z.object({
        title: z.string().describe("Short event title, e.g. 'Maya - dentist'."),
        startISO: isoDateTime,
        endISO: endISOWithAllDayNote,
        allDay: z.boolean().optional().describe("True for all-day events. Defaults to false."),
        memberNames: z.array(z.string()).describe(memberNamesDescription),
        notes: z.string().optional(),
        location: z.string().optional(),
        confirmDuplicate: z
          .boolean()
          .optional()
          .describe(
            "Only set true after the user has explicitly confirmed they want to add this event even though an identical-looking one already exists (i.e. you already asked and they said yes to a second one). Omit/false on a normal call — the tool checks for a near-duplicate itself and will tell you via duplicateFound if it finds one, rather than silently creating a copy.",
          ),
      }),
      execute: async ({ title, startISO, endISO, allDay, memberNames, notes, location, confirmDuplicate }) => {
        const resolved = resolveMemberNames(memberNames, ctx.roster);
        if ("ambiguousName" in resolved) {
          return {
            ambiguousMember: {
              name: resolved.ambiguousName,
              candidates: resolved.candidates.map((c) => ({ id: c.id, name: c.name })),
            },
          };
        }

        if (!confirmDuplicate) {
          const duplicate = await findNearDuplicateEvent({
            title,
            startISO,
            endISO,
            allDay,
            memberIds: resolved.memberIds,
          });
          if (duplicate) {
            return {
              duplicateFound: {
                googleEventId: duplicate.id,
                title: duplicate.title,
                start: duplicate.start,
                end: duplicate.end,
                allDay: duplicate.allDay,
              },
            };
          }
        }

        const event = await gCreateEvent({
          title,
          startISO,
          endISO,
          allDay,
          memberIds: resolved.memberIds,
          notes,
          location,
          createdVia: ctx.source,
        });
        return { event, unresolvedMemberNames: resolved.unresolved.length > 0 ? resolved.unresolved : undefined };
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
        memberNames: z.array(z.string()).optional().describe(`${memberNamesDescription} Omit entirely to leave the event's current members unchanged.`),
        notes: z.string().optional(),
        location: z.string().optional(),
      }),
      execute: async ({ googleEventId, title, startISO, endISO, allDay, memberNames, notes, location }) => {
        let memberIds: string[] | undefined;
        if (memberNames) {
          const resolved = resolveMemberNames(memberNames, ctx.roster);
          if ("ambiguousName" in resolved) {
            return {
              ambiguousMember: {
                name: resolved.ambiguousName,
                candidates: resolved.candidates.map((c) => ({ id: c.id, name: c.name })),
              },
            };
          }
          memberIds = resolved.memberIds;
        }

        const event = await gUpdateEvent({ googleEventId, title, startISO, endISO, allDay, memberIds, notes, location });
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

    // Durable memory (docs/superpowers/specs/2026-09-07-shared-memory-design.md
    // §2/§3) — separate from the recent-conversation-turns history in
    // lib/agent/history.ts. remember/forget are act-mode only (see the
    // suggest-mode allowlist below): the passive-listener path shouldn't be
    // writing durable facts off an ambient message nobody actually asked it
    // to save.
    remember: tool({
      description:
        "Save a durable fact, preference, standing pattern, or decision the family wants you to remember across future conversations — NOT a one-off calendar event (use createEvent for that instead). Only call this when someone explicitly asks you to remember something, or states a durable scheduling preference/pattern/decision in a message addressed to you.",
      inputSchema: z.object({
        content: z.string().describe("One sentence, human-readable summary of the thing to remember, e.g. 'Yash has soccer every Tuesday 5-6pm.'"),
        kind: z.enum(["preference", "pattern", "fact", "decision"]).optional().describe("Defaults to 'fact' if omitted."),
        memberName: z
          .string()
          .optional()
          .describe(
            "Family member name/alias this memory is about, exactly as referenced in the conversation and matching the roster above (e.g. 'Maya') — NOT a family_members.id. Resolved the same deterministic way as an event's memberNames; if it matches more than one roster member, this returns an ambiguousMember result instead of saving, and you should ask which person they meant. Omit if the memory isn't about one specific family member.",
          ),
      }),
      execute: async ({ content, kind, memberName }) => {
        let memberId: string | undefined;
        if (memberName) {
          const resolved = resolveMemberNames([memberName], ctx.roster);
          if ("ambiguousName" in resolved) {
            return {
              ambiguousMember: {
                name: resolved.ambiguousName,
                candidates: resolved.candidates.map((c) => ({ id: c.id, name: c.name })),
              },
            };
          }
          memberId = resolved.memberIds[0];
        }
        const remembered = await rememberMemory({ content, kind, memberId, createdByMemberId: ctx.senderMemberId, source: ctx.source });
        return { remembered };
      },
    }),

    forget: tool({
      description:
        "Archive a previously saved memory (soft-delete, never a hard delete) by its id. Use when the family says something like 'forget that' or a saved memory turns out wrong or outdated.",
      inputSchema: z.object({ memoryId: z.string().describe("The memory's id, shown as [id: …] next to each entry under 'Things the family has asked you to remember' in your instructions.") }),
      execute: async ({ memoryId }) => {
        await forgetMemory(memoryId);
        return { forgotten: true };
      },
    }),

    searchHistory: tool({
      description:
        "Search older family conversation beyond what's shown in the recent turns above (up to 90 days back by default, across both the group chat and the dashboard). Use when someone refers to an earlier conversation that isn't in front of you.",
      inputSchema: z.object({
        query: z.string().describe("Search text — every whitespace-separated word must appear (case-insensitively) in a matching message."),
        sinceDays: z.number().optional().describe("How many days back to search. Defaults to 90."),
      }),
      execute: async ({ query, sinceDays }) => {
        const results = await searchFamilyHistory({ query, sinceDays }, ctx.roster);
        return { results };
      },
    }),
  };

  if (ctx.mode === "suggest") {
    // Deterministically expose only the non-mutating tools — see this
    // function's doc comment and AgentToolContext.mode. Built as an
    // explicit allowlist (rather than destructure-and-omit) so there's no
    // risk of a newly-added mutating tool silently staying available here
    // by default. listEvents/checkConflicts/searchHistory stay available
    // (read-only, useful context for phrasing the suggestion);
    // sendGroupMessage stays available too (it's an extra message, not a
    // calendar mutation). remember/forget are deliberately excluded — see
    // this function's doc comment above.
    const { listEvents, checkConflicts, sendGroupMessage, searchHistory } = allTools;
    return isAgentSilent() ? { listEvents, checkConflicts, searchHistory } : { listEvents, checkConflicts, sendGroupMessage, searchHistory };
  }

  if (isAgentSilent()) {
    // Silent mode (./silent.ts): nothing the agent says reaches the chat, so
    // the one tool whose only job is sending a text is withheld. Explicit
    // allowlist, same reason as the suggest-mode one above.
    const { createEvent, updateEvent, deleteEvent, listEvents, checkConflicts, remember, forget, searchHistory } = allTools;
    return { createEvent, updateEvent, deleteEvent, listEvents, checkConflicts, remember, forget, searchHistory };
  }

  return allTools;
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
