import {
  BookOpen,
  Check,
  CheckCircle2,
  Heart,
  LayoutDashboard,
  MessageCircle,
  Pencil,
  Repeat2,
  Trash2,
  X,
} from "lucide-react";
import type { MemoryEntry, MemoryKind, MemorySource } from "@/lib/data/memory";
import { formatRelativeTimestamp } from "@/lib/format";
import { MemberBadge } from "@/components/member/member-badge";
import { MemberColorDot } from "@/components/member/member-color-dot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const KIND_META: Record<MemoryKind, { label: string; icon: typeof Heart; className: string }> = {
  preference: { label: "Preference", icon: Heart, className: "text-member-rose" },
  pattern: { label: "Pattern", icon: Repeat2, className: "text-member-teal" },
  fact: { label: "Fact", icon: BookOpen, className: "text-member-blue" },
  decision: { label: "Decision", icon: CheckCircle2, className: "text-member-violet" },
};

const SOURCE_META: Record<MemorySource, { label: string; icon: typeof MessageCircle }> = {
  imessage: { label: "iMessage", icon: MessageCircle },
  dashboard: { label: "Dashboard", icon: LayoutDashboard },
};

export function MemoryCard({
  entry,
  tz,
  isEditing,
  draft,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRequestDelete,
  saving,
}: {
  entry: MemoryEntry;
  tz: string;
  isEditing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRequestDelete: () => void;
  saving: boolean;
}) {
  const kindMeta = KIND_META[entry.kind];
  const KindIcon = kindMeta.icon;
  const sourceMeta = entry.source ? SOURCE_META[entry.source] : null;
  const SourceIcon = sourceMeta?.icon;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className={cn("flex items-center gap-1.5 text-xs font-medium", kindMeta.className)}>
          <KindIcon className="size-3.5" />
          {kindMeta.label}
        </span>

        {isEditing ? (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onSaveEdit}
              disabled={saving || !draft.trim()}
              aria-label="Save"
            >
              <Check />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onCancelEdit} disabled={saving} aria-label="Cancel">
              <X />
            </Button>
          </div>
        ) : (
          <div className="flex gap-1">
            <Button variant="ghost" size="icon-sm" onClick={onStartEdit} aria-label="Edit memory">
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRequestDelete}
              aria-label="Forget this memory"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>

      {isEditing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSaveEdit();
            if (e.key === "Escape") onCancelEdit();
          }}
          disabled={saving}
        />
      ) : (
        <p className="text-sm leading-relaxed text-foreground">{entry.content}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {entry.about && (
          <span className="flex items-center gap-1.5">
            About
            <MemberBadge member={entry.about} />
          </span>
        )}
        <span className="flex items-center gap-1.5">
          {entry.savedBy ? (
            <>
              <MemberColorDot color={entry.savedBy.color} />
              Saved by {entry.savedBy.name}
            </>
          ) : (
            "Saved by the agent"
          )}
          {" · "}
          {formatRelativeTimestamp(entry.updatedAt, tz)}
        </span>
        {sourceMeta && SourceIcon && (
          <span className="flex items-center gap-1">
            <SourceIcon className="size-3" />
            {sourceMeta.label}
          </span>
        )}
      </div>
    </div>
  );
}
