import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  uuid,
} from "drizzle-orm/pg-core";

export const familyMembers = pgTable("family_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  imessageHandle: text("imessage_handle"),
  phone: text("phone"),
  color: text("color"),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
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
  status: text("status", { enum: ["pending", "sent", "failed"] })
    .notNull()
    .default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const messageLog = pgTable("message_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
  chatGuid: text("chat_guid"),
  senderHandle: text("sender_handle"),
  memberId: uuid("member_id"),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
