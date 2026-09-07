import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  uuid,
  index,
} from "drizzle-orm/pg-core";

export const familyMembers = pgTable("family_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  imessageHandle: text("imessage_handle"),
  phone: text("phone"),
  color: text("color"),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  // Every other identifier this member is known by — Google/dashboard sign-in
  // email, Apple-ID email, additional phone numbers, etc. Added because
  // `imessageHandle`/`phone` are single-value columns, but a real family
  // member is reachable/identifiable by more than one handle at once (their
  // Google email for the dashboard is frequently NOT the same address as
  // their iMessage Apple ID). Before this column, only Aman's seed row had
  // his Gmail crammed into `imessageHandle` — a bespoke, non-scalable fix —
  // so nobody else's inbound sender ever resolved to a family_members row.
  // `identifiers` is the general-purpose home for "every way we might see
  // this person" going forward; `resolveSenderMemberId`
  // (lib/agent/resolve-sender.ts) matches a sender against
  // imessageHandle/phone/identifiers together. See docs/agent-core.md
  // "Identifier consolidation" for the full design note. Migration-safe:
  // NOT NULL with an empty-array default, so existing rows (and drizzle-kit
  // push against the already-seeded prod DB) don't need a manual backfill to
  // stay valid — they just start with no extra identifiers until re-seeded.
  identifiers: jsonb("identifiers").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const eventMeta = pgTable("event_meta", {
  id: uuid("id").primaryKey().defaultRandom(),
  googleEventId: text("google_event_id").notNull().unique(),
  memberIds: jsonb("member_ids").$type<string[]>().notNull().default([]),
  announcedAt: timestamp("announced_at", { withTimezone: true }),
  remindedAt: timestamp("reminded_at", { withTimezone: true }),
  createdVia: text("created_via", {
    enum: ["imessage", "dashboard", "calendar_app"],
  }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const outboundQueue = pgTable("outbound_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatGuid: text("chat_guid").notNull(),
  text: text("text").notNull(),
  // "sending" is a transient claim state (see lib/outbound-processor.ts):
  // a row is atomically moved pending -> sending before a send attempt so
  // two overlapping sweeps (the endpoints are externally pingable — see
  // .github/workflows/cron-pinger.yml) can't both claim and double-send the
  // same row. Migration-safe: existing rows are all 'pending'/'sent'/'failed'
  // already, and the column default is unchanged.
  status: text("status", { enum: ["pending", "sending", "sent", "failed"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  // F1 (tech-lead follow-up): set at the moment a row is atomically claimed
  // pending -> sending (see lib/outbound-processor.ts), cleared back to null
  // whenever a row leaves 'sending' (sent, failed, or reaped back to
  // pending). Lets the reaper distinguish "claimed a moment ago, still being
  // processed by a live sweep" from "claimed by a sweep that crashed/timed
  // out and never came back" without a blanket sending -> pending reset.
  // Nullable, no default: migration-safe the same way the 'sending' enum
  // value was — existing rows are unaffected.
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
});

export const messageLog = pgTable("message_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  chatGuid: text("chat_guid"),
  senderHandle: text("sender_handle"),
  memberId: uuid("member_id"),
  // Positive discriminator for which channel this row came from. Before this
  // column, `lib/agent/history.ts` scoped "dashboard thread" history as
  // "every row with a NULL chat_guid" — an unenforced assumption that
  // iMessage rows always carry a chat_guid, rather than a real, checkable
  // fact. `source` lets scoping assert the actual channel instead of
  // inferring it from another column's null-ness. Nullable (no default):
  // rows written before this column existed have no source and are simply
  // excluded from both scopes going forward rather than being backfilled —
  // there's no reliable way to infer their true channel after the fact, and
  // pre-launch history has no real value to preserve. See
  // docs/agent-core.md "message_log source discriminator" for the full
  // design note and lib/agent/history.ts for the scoping logic.
  source: text("source", { enum: ["imessage", "dashboard"] }),
  // BlueBubbles' own message guid, set on inbound rows written by either the
  // webhook (push delivery) or the inbound-poll cron backstop (REST-API
  // pull, app/api/cron/inbound) — lets processInboundMessage
  // (lib/inbound-processor.ts) tell whether a given iMessage was already run
  // through the agent by the other path, without double-processing it.
  // Nullable: outbound rows, and inbound rows predating this column, have none.
  imessageGuid: text("imessage_guid"),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (table) => [index("message_log_imessage_guid_idx").on(table.imessageGuid)]);

// Durable things the family has told the agent to remember (preferences,
// standing patterns, decisions), shared across the iMessage and dashboard
// channels. Rows are archived rather than deleted so a mistaken "forget"
// from either the agent or the dashboard can be undone.
export const familyMemory = pgTable("family_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  kind: text("kind", { enum: ["preference", "pattern", "fact", "decision"] })
    .notNull()
    .default("fact"),
  memberId: uuid("member_id"),
  createdByMemberId: uuid("created_by_member_id"),
  source: text("source", { enum: ["imessage", "dashboard"] }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
