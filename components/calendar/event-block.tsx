import type { CSSProperties } from "react";
import { TriangleAlert } from "lucide-react";
import type { FamilyMember, LuthEvent } from "@/lib/mock/types";
import { memberSoftStyle } from "@/lib/mock/colors";
import { formatEventTime } from "@/lib/format";
import { cn } from "@/lib/utils";

function resolveMembers(event: LuthEvent, members: FamilyMember[]): FamilyMember[] {
  return event.memberIds
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is FamilyMember => Boolean(m));
}

/** Absolutely-positioned event block for the week view's hour grid. Position
 * (top/height/left/width) is computed by the caller and passed via `style`. */
export function EventBlock({
  event,
  members,
  tz,
  hasConflict,
  onClick,
  style,
}: {
  event: LuthEvent;
  members: FamilyMember[];
  tz: string;
  hasConflict?: boolean;
  onClick?: () => void;
  style: CSSProperties;
}) {
  const involved = resolveMembers(event, members);
  const solo = involved.length === 1 ? involved[0] : null;
  const compact = typeof style.height === "number" && style.height < 40;

  return (
    <button
      type="button"
      onClick={onClick}
      title={event.title}
      style={{ ...style, position: "absolute", ...(solo ? memberSoftStyle(solo.color) : undefined) }}
      className={cn(
        "flex flex-col overflow-hidden rounded-md border-l-2 px-1.5 py-1 text-left leading-tight transition-colors",
        "hover:brightness-[0.97] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:brightness-110",
        !solo && "border-l-primary/50 bg-muted"
      )}
    >
      <span className="flex items-center gap-1">
        {!solo && (
          <span className="flex -space-x-0.5">
            {involved.slice(0, 3).map((m) => (
              <span
                key={m.id}
                aria-hidden
                className="size-1.5 shrink-0 rounded-full ring-1 ring-card"
                style={{ backgroundColor: `var(--member-${m.color})` }}
              />
            ))}
          </span>
        )}
        <span className="truncate text-xs font-medium">{event.title}</span>
        {hasConflict && <TriangleAlert className="ml-auto size-3 shrink-0 text-warning" />}
      </span>
      {!compact && (
        <span className="truncate text-[10px] text-foreground/70">
          {formatEventTime(event, tz)}
        </span>
      )}
    </button>
  );
}
