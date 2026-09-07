"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BrainCircuit } from "lucide-react";
import type { MemoryEntry } from "@/lib/data/memory";
import { archiveMemoryAction, updateMemoryContentAction } from "@/lib/data/memory-actions";
import { MemoryCard } from "@/components/memory/memory-card";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function MemoryManager({ initialMemories, tz }: { initialMemories: MemoryEntry[]; tz: string }) {
  const [memories, setMemories] = useState(initialMemories);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MemoryEntry | null>(null);
  const [saving, setSaving] = useState(false);

  function startEdit(entry: MemoryEntry) {
    setEditingId(entry.id);
    setDraft(entry.content);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft("");
  }

  async function saveEdit(entry: MemoryEntry) {
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    try {
      await updateMemoryContentAction(entry.id, content);
      const updatedAt = new Date().toISOString();
      setMemories((prev) => prev.map((m) => (m.id === entry.id ? { ...m, content, updatedAt } : m)));
      setEditingId(null);
      setDraft("");
      toast.success("Memory updated");
    } catch (err) {
      console.error("Failed to update memory:", err);
      toast.error("Couldn't save that change");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const entry = pendingDelete;
    setSaving(true);
    try {
      await archiveMemoryAction(entry.id);
      setMemories((prev) => prev.filter((m) => m.id !== entry.id));
      setPendingDelete(null);
      toast("Forgot that", { description: entry.content });
    } catch (err) {
      console.error("Failed to archive memory:", err);
      toast.error("Couldn't forget that memory");
    } finally {
      setSaving(false);
    }
  }

  if (memories.length === 0) {
    return (
      <EmptyState
        icon={BrainCircuit}
        title="Nothing remembered yet"
        description="Preferences, patterns, and decisions the family tells the agent to remember will show up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {memories.map((entry) => (
        <MemoryCard
          key={entry.id}
          entry={entry}
          tz={tz}
          isEditing={editingId === entry.id}
          draft={draft}
          onDraftChange={setDraft}
          onStartEdit={() => startEdit(entry)}
          onCancelEdit={cancelEdit}
          onSaveEdit={() => saveEdit(entry)}
          onRequestDelete={() => setPendingDelete(entry)}
          saving={saving}
        />
      ))}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Forget this memory?</DialogTitle>
            <DialogDescription>
              The agent will stop using this in conversation. “{pendingDelete?.content}”
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={saving}>
              Forget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
