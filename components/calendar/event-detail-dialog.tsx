import { CalendarClock, MapPin, MessageCircle, StickyNote, TriangleAlert } from "lucide-react";
import type { FamilyMember, LuthEvent } from "@/lib/mock/types";
import { conflictsFor } from "@/lib/mock/conflicts";
import { formatEventTime, formatFullDay } from "@/lib/format";
import { MemberBadge } from "@/components/member/member-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SOURCE_LABEL: Record<NonNullable<LuthEvent["createdVia"]>, string> = {
  imessage: "Added from the group chat",
  dashboard: "Added from the dashboard",
  calendar_app: "Added from a calendar app",
};

export function EventDetailDialog({
  event,
  members,
  allEvents,
  tz,
  onClose,
}: {
  event: LuthEvent | null;
  members: FamilyMember[];
  allEvents: LuthEvent[];
  tz: string;
  onClose: () => void;
}) {
  const involved = event
    ? event.memberIds
        .map((id) => members.find((m) => m.id === id))
        .filter((m): m is FamilyMember => Boolean(m))
    : [];
  const conflicts = event ? conflictsFor(event, allEvents) : [];

  return (
    <Dialog open={event !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {event && (
          <>
            <DialogHeader>
              <DialogTitle className="text-lg">{event.title}</DialogTitle>
              <DialogDescription className="flex items-center gap-1.5">
                <CalendarClock className="size-3.5" />
                {formatFullDay(event.start, tz)} · {formatEventTime(event, tz)}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3 text-sm">
              {involved.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {involved.map((m) => (
                    <MemberBadge key={m.id} member={m} />
                  ))}
                </div>
              )}

              {event.location && (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <MapPin className="mt-0.5 size-3.5 shrink-0" />
                  <span>{event.location}</span>
                </div>
              )}

              {event.notes && (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <StickyNote className="mt-0.5 size-3.5 shrink-0" />
                  <span>{event.notes}</span>
                </div>
              )}

              {event.createdVia && (
                <div className="flex items-start gap-2 text-muted-foreground">
                  <MessageCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{SOURCE_LABEL[event.createdVia]}</span>
                </div>
              )}

              {conflicts.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-warning-foreground dark:text-warning">
                  <div className="flex items-center gap-1.5 font-medium">
                    <TriangleAlert className="size-3.5" />
                    Scheduling conflict
                  </div>
                  <ul className="space-y-0.5 pl-5 text-xs text-foreground/80">
                    {conflicts.map((c) => (
                      <li key={c.id} className="list-disc">
                        {c.title} · {formatEventTime(c, tz)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
