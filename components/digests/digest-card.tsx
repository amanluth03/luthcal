import { CalendarRange, Megaphone, Sunrise } from "lucide-react";
import type { DigestEntry, DigestKind } from "@/lib/mock/types";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_META: Record<DigestKind, { label: string; icon: typeof Sunrise; className: string }> = {
  daily: { label: "Daily digest", icon: Sunrise, className: "text-member-amber" },
  weekly: { label: "Weekly digest", icon: CalendarRange, className: "text-member-violet" },
  announcement: { label: "Announcement", icon: Megaphone, className: "text-member-blue" },
};

export function DigestCard({ digest, tz }: { digest: DigestEntry; tz: string }) {
  const meta = KIND_META[digest.kind];
  const Icon = meta.icon;

  return (
    <div className="flex gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted", meta.className)}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={cn("text-xs font-medium", meta.className)}>{meta.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatClock(digest.sentAt, tz)}
          </span>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-foreground">{digest.text}</p>
      </div>
    </div>
  );
}
