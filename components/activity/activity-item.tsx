import {
  Bot,
  BellRing,
  CalendarCog,
  CalendarPlus,
  CalendarX,
  CircleHelp,
  MinusCircle,
  TriangleAlert,
} from "lucide-react";
import type { ActivityActionType, ActivityEntry, FamilyMember } from "@/lib/mock/types";
import { formatRelativeTimestamp } from "@/lib/format";
import { MemberAvatar } from "@/components/member/member-avatar";
import { cn } from "@/lib/utils";

const ACTION_META: Record<ActivityActionType, { label: string; icon: typeof CalendarPlus }> = {
  create_event: { label: "Created event", icon: CalendarPlus },
  update_event: { label: "Updated event", icon: CalendarCog },
  delete_event: { label: "Removed event", icon: CalendarX },
  flag_conflict: { label: "Flagged conflict", icon: TriangleAlert },
  send_digest: { label: "Sent digest", icon: BellRing },
  send_reminder: { label: "Sent reminder", icon: BellRing },
  needs_clarification: { label: "Asked for clarification", icon: CircleHelp },
  no_action: { label: "No action taken", icon: MinusCircle },
};

export function ActivityItem({
  entry,
  member,
  tz,
  isLast,
}: {
  entry: ActivityEntry;
  member?: FamilyMember;
  tz: string;
  isLast?: boolean;
}) {
  const isAgent = entry.sender === "Agent";
  const actionMeta = entry.action ? ACTION_META[entry.action.type] : null;
  const ActionIcon = actionMeta?.icon;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        {isAgent ? (
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            aria-hidden
          >
            <Bot className="size-4" />
          </div>
        ) : member ? (
          <MemberAvatar member={member} size="sm" className="size-8" />
        ) : (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {entry.sender[0]?.toUpperCase()}
          </div>
        )}
        {!isLast && <div className="mt-1 w-px flex-1 bg-border" />}
      </div>

      <div className="min-w-0 flex-1 pb-6">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-foreground">{entry.sender}</span>
          <span className="text-xs text-muted-foreground">
            {entry.direction === "inbound" ? "texted the group" : "replied"}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">
            {formatRelativeTimestamp(entry.createdAt, tz)}
          </span>
        </div>

        <p
          className={cn(
            "mt-1 max-w-xl rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
            entry.direction === "inbound" ? "bg-muted text-foreground" : "bg-accent text-accent-foreground"
          )}
        >
          {entry.text}
        </p>

        {actionMeta && ActionIcon && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
            <ActionIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="font-medium text-foreground/80">{actionMeta.label}</span>
              {" — "}
              {entry.action!.summary}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
