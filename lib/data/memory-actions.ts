"use server";

import { eq } from "drizzle-orm";

import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { familyMemory } from "@/lib/db/schema";

// Memories are injected into the agent's prompt on every turn, so keep one
// entry from ballooning it.
const MAX_MEMORY_CONTENT_LENGTH = 500;

// proxy.ts already gates these routes; re-checked here like app/api/chat does
// so the actions stay safe if the matcher is ever loosened.
async function requireSession(): Promise<void> {
  if (!(await auth())) throw new Error("Unauthorized");
}

/** Updates a memory's content (and updated_at) — the dashboard's correction
 * surface for what the agent remembers. Never touches archivedAt. */
export async function updateMemoryContentAction(id: string, content: string): Promise<void> {
  await requireSession();
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Memory content can't be empty");
  if (trimmed.length > MAX_MEMORY_CONTENT_LENGTH) {
    throw new Error(`Memory content is too long (max ${MAX_MEMORY_CONTENT_LENGTH} characters)`);
  }
  const db = getDb();
  await db
    .update(familyMemory)
    .set({ content: trimmed, updatedAt: new Date() })
    .where(eq(familyMemory.id, id));
}

/** Soft-deletes a memory by setting archivedAt — per the schema's contract,
 * memories are never hard-deleted. */
export async function archiveMemoryAction(id: string): Promise<void> {
  await requireSession();
  const db = getDb();
  await db
    .update(familyMemory)
    .set({ archivedAt: new Date() })
    .where(eq(familyMemory.id, id));
}
