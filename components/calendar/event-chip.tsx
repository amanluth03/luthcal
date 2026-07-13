import { TriangleAlert } from "lucide-react";
import type { FamilyMember, LuthEvent } from "@/lib/mock/types";
import { memberSoftStyle } from "@/lib/mock/colors";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";

function resolveMembers(event: LuthEvent, members: FamilyMember[]): FamilyMember[] {
  return event.memberIds
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is FamilyMember => Boolean(m));
}

interface EventChipProps {
  event: LuthEvent;
  members: FamilyMember[];
  tz: string;
  hasConflict?: boolean;
  onClick?: () => void;
  className?: string;
}

/** Compact chip for the month grid — one line, truncates. */
export function EventChip({ event, members, tz, hasConflict, onClick, className }: EventChipProps) {
  const involved = resolveMembers(event, members);
  const solo = involved.length === 1 ? involved[0] : null;

  return (
    <button
      type="button"
      onClick={onClick}
      title={event.title}
      className={cn(
        "group flex w-full items-center gap-1 overflow-hidden rounded-md border-l-2 px-1.5 py-0.5 text-left text-xs leading-tight transition-colors",
        "hover:brightness-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:brightness-110",
        !solo && "border-l-primary/50 bg-muted",
        className
      )}
      style={solo ? memberSoftStyle(solo.color) : undefined}
    >
      {!solo &&
        involved.slice(0, 3).map((m) => (
          <span
            key={m.id}
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: `var(--member-${m.color})` }}
          />
        ))}
      {!event.allDay && <span className="shrink-0 font-medium tabular-nums">{formatClock(event.start, tz)}</span>}
      <span className="truncate">{event.title}</span>
      {hasConflict && <TriangleAlert className="ml-auto size-3 shrink-0 text-warning" />}
    </button>
  );
}
