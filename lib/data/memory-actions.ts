"use server";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { familyMemory } from "@/lib/db/schema";

/** Updates a memory's content (and updated_at) — the dashboard's correction
 * surface for what the agent remembers. Never touches archivedAt. */
export async function updateMemoryContentAction(id: string, content: string): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Memory content can't be empty");
  const db = getDb();
  await db
    .update(familyMemory)
    .set({ content: trimmed, updatedAt: new Date() })
    .where(eq(familyMemory.id, id));
}

/** Soft-deletes a memory by setting archivedAt — per the schema's contract,
 * memories are never hard-deleted. */
export async function archiveMemoryAction(id: string): Promise<void> {
  const db = getDb();
  await db
    .update(familyMemory)
    .set({ archivedAt: new Date() })
    .where(eq(familyMemory.id, id));
}
