import "server-only";

import { desc, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { familyMemory } from "@/lib/db/schema";
import { realDataAdapter } from "@/lib/data/server-adapter";
import type { FamilyMember } from "@/lib/mock/types";

export type MemoryKind = "preference" | "pattern" | "fact" | "decision";
export type MemorySource = "imessage" | "dashboard";

export type MemoryMember = Pick<FamilyMember, "id" | "name" | "color">;

export interface MemoryEntry {
  id: string;
  content: string;
  kind: MemoryKind;
  /** Who the memory is about, if it's about one person. */
  about: MemoryMember | null;
  /** Who told the agent to remember this, if known. */
  savedBy: MemoryMember | null;
  /** Channel the memory was saved from — null for pre-launch rows saved
   * before this column existed. */
  source: MemorySource | null;
  createdAt: string;
  updatedAt: string;
}

// Dashboard-only cap — the agent's own prompt-injection reader
// (lib/agent/memory.ts) has its own limit; this is just a sane ceiling for a
// feed nobody is meant to page through at family scale.
const MEMORY_LIST_LIMIT = 200;

/**
 * Active (non-archived) memories, newest first, with member_id/
 * created_by_member_id resolved to display name + color via the same
 * family_members mapping `realDataAdapter.getFamilyMembers()` already does
 * (hex color -> MemberColor token) — reused rather than duplicated.
 *
 * Degrades to `[]` on any failure (DB unavailable, no DATABASE_URL in local
 * dev) rather than throwing, matching lib/agent/memory.ts's own graceful
 * degradation and the dashboard layout's roster fallback.
 */
export async function getActiveMemories(): Promise<MemoryEntry[]> {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(familyMemory)
      .where(isNull(familyMemory.archivedAt))
      .orderBy(desc(familyMemory.createdAt))
      .limit(MEMORY_LIST_LIMIT);

    if (rows.length === 0) return [];

    const members = await realDataAdapter.getFamilyMembers();
    const memberById = new Map(members.map((m) => [m.id, m]));
    const toMemoryMember = (id: string | null): MemoryMember | null => {
      if (!id) return null;
      const member = memberById.get(id);
      return member ? { id: member.id, name: member.name, color: member.color } : null;
    };

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      kind: row.kind,
      about: toMemoryMember(row.memberId),
      savedBy: toMemoryMember(row.createdByMemberId),
      source: row.source,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  } catch (err) {
    console.error("getActiveMemories: failed to load memories:", err);
    return [];
  }
}
