"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { FamilyMember } from "@/lib/mock/types";
import { mockDelay } from "@/lib/mock/adapter";
import { MemberAvatar } from "@/components/member/member-avatar";
import { MemberColorDot } from "@/components/member/member-color-dot";
import { MEMBER_COLOR_LABELS } from "@/lib/mock/colors";
import {
  MemberFormDialog,
  type MemberFormValues,
} from "@/components/family/member-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function FamilyManager({ initialMembers }: { initialMembers: FamilyMember[] }) {
  const [members, setMembers] = useState(initialMembers);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FamilyMember | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<FamilyMember | null>(null);
  const [saving, setSaving] = useState(false);

  function openAdd() {
    setEditing(undefined);
    setFormOpen(true);
  }
  function openEdit(member: FamilyMember) {
    setEditing(member);
    setFormOpen(true);
  }

  async function handleSubmit(values: MemberFormValues) {
    setSaving(true);
    await mockDelay();
    const next: FamilyMember = {
      id: values.id,
      name: values.name,
      imessageHandle: values.imessageHandle || null,
      phone: editing?.phone ?? null,
      color: values.color,
      aliases: values.aliases,
      createdAt: editing?.createdAt ?? new Date().toISOString(),
    };
    setMembers((prev) => {
      const exists = prev.some((m) => m.id === next.id);
      return exists ? prev.map((m) => (m.id === next.id ? next : m)) : [...prev, next];
    });
    setSaving(false);
    setFormOpen(false);
    toast.success(editing ? `Updated ${next.name}` : `Added ${next.name} to the family`, {
      description: "This is a dashboard-only preview — nothing is persisted yet.",
    });
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    const name = pendingDelete.name;
    await mockDelay(250);
    setMembers((prev) => prev.filter((m) => m.id !== pendingDelete.id));
    setPendingDelete(null);
    toast(`Removed ${name}`, { description: "This is a dashboard-only preview — nothing is persisted yet." });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openAdd}>
          <Plus />
          Add member
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden sm:table-cell">iMessage handle</TableHead>
              <TableHead className="hidden md:table-cell">Aliases</TableHead>
              <TableHead className="hidden sm:table-cell">Color</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <MemberAvatar member={member} size="sm" />
                    <span className="font-medium">{member.name}</span>
                  </div>
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                  {member.imessageHandle ?? "—"}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {member.aliases.length > 0
                      ? member.aliases.map((alias) => (
                          <Badge key={alias} variant="secondary">
                            {alias}
                          </Badge>
                        ))
                      : "—"}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MemberColorDot color={member.color} />
                    {MEMBER_COLOR_LABELS[member.color]}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(member)} aria-label={`Edit ${member.name}`}>
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPendingDelete(member)}
                      aria-label={`Remove ${member.name}`}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <MemberFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        member={editing}
        usedColors={members.map((m) => m.color)}
        saving={saving}
        onSubmit={handleSubmit}
      />

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {pendingDelete?.name}?</DialogTitle>
            <DialogDescription>
              The agent will stop recognizing this name in texts. This only affects this dashboard preview.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
