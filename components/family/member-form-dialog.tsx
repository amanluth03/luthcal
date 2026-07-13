"use client";

import { useEffect, useState } from "react";
import type { FamilyMember, MemberColor } from "@/lib/mock/types";
import { nextAvailableColor } from "@/lib/mock/colors";
import { ColorPicker } from "@/components/family/color-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface MemberFormValues {
  id: string;
  name: string;
  imessageHandle: string;
  color: MemberColor;
  aliases: string[];
}

export function MemberFormDialog({
  open,
  onOpenChange,
  member,
  usedColors,
  saving,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Undefined = "add member" mode. */
  member?: FamilyMember;
  usedColors: MemberColor[];
  saving?: boolean;
  onSubmit: (values: MemberFormValues) => void;
}) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [color, setColor] = useState<MemberColor>("blue");
  const [aliasesText, setAliasesText] = useState("");

  // Re-seed the form whenever the dialog opens, for either mode. This is a
  // deliberate "reset local form state when an external trigger fires" effect:
  // every open (including reopening add-mode after a cancel) must start from
  // the member's values, which a `key`-based remount can't express without
  // extra open-counter plumbing. Batched setStates here run before paint.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setName(member?.name ?? "");
    setHandle(member?.imessageHandle ?? "");
    setColor(member?.color ?? nextAvailableColor(usedColors));
    setAliasesText(member?.aliases.join(", ") ?? "");
  }, [open, member, usedColors]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      id: member?.id ?? crypto.randomUUID(),
      name: name.trim(),
      imessageHandle: handle.trim(),
      color,
      aliases: aliasesText
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{member ? "Edit family member" : "Add family member"}</DialogTitle>
            <DialogDescription>
              {member
                ? "Update how the agent recognizes and displays this person."
                : "The agent will recognize this person by name, handle, and any aliases you add."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-name">Name</Label>
              <Input
                id="member-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Maya"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-handle">iMessage handle</Label>
              <Input
                id="member-handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="+1 (512) 555-0110"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-aliases">Aliases</Label>
              <Input
                id="member-aliases"
                value={aliasesText}
                onChange={(e) => setAliasesText(e.target.value)}
                placeholder="May, Maya L"
              />
              <p className="text-xs text-muted-foreground">Comma-separated. Helps the agent match names in texts.</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Color</Label>
              <ColorPicker value={color} onChange={setColor} />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : member ? "Save changes" : "Add member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
