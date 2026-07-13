"use client";

import { useState } from "react";
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { FamilyMember, LuthEvent } from "@/lib/mock/types";
import { eventOccursOnDay, todayKey } from "@/lib/format";
import { EventChip } from "@/components/calendar/event-chip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_VISIBLE = 3;

export function MonthGrid({
  cursor,
  members,
  events,
  conflictIds,
  tz,
  onSelectEvent,
}: {
  cursor: Date;
  members: FamilyMember[];
  events: LuthEvent[];
  conflictIds: Set<string>;
  tz: string;
  onSelectEvent: (event: LuthEvent) => void;
}) {
  const [overflowDay, setOverflowDay] = useState<string | null>(null);

  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const today = todayKey(tz);

  const eventsByDay = (dateKeyStr: string) =>
    events
      .filter((e) => eventOccursOnDay(e, dateKeyStr, tz))
      .sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.start.localeCompare(b.start);
      });

  const overflowEvents = overflowDay ? eventsByDay(overflowDay) : [];

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border text-center text-xs font-medium text-muted-foreground">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="py-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const dateKeyStr = format(day, "yyyy-MM-dd");
          const dayEvents = eventsByDay(dateKeyStr);
          const visible = dayEvents.slice(0, MAX_VISIBLE);
          const overflowCount = dayEvents.length - visible.length;
          const inMonth = isSameMonth(day, cursor);
          const isToday = dateKeyStr === today;

          return (
            <div
              key={dateKeyStr}
              className={cn(
                "flex min-h-24 flex-col gap-1 border-r border-b border-border p-1.5 last:border-r-0 sm:min-h-28",
                !inMonth && "bg-muted/30"
              )}
            >
              <span
                className={cn(
                  "self-start text-xs tabular-nums",
                  !inMonth && "text-muted-foreground/50",
                  inMonth && !isToday && "text-muted-foreground",
                  isToday &&
                    "flex size-5 items-center justify-center rounded-full bg-primary font-medium text-primary-foreground"
                )}
              >
                {format(day, "d")}
              </span>
              <div className="flex flex-col gap-0.5">
                {visible.map((event) => (
                  <EventChip
                    key={event.id}
                    event={event}
                    members={members}
                    tz={tz}
                    hasConflict={conflictIds.has(event.id)}
                    onClick={() => onSelectEvent(event)}
                  />
                ))}
                {overflowCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setOverflowDay(dateKeyStr)}
                    className="rounded-md px-1.5 py-0.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    +{overflowCount} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={overflowDay !== null} onOpenChange={(open) => !open && setOverflowDay(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {overflowDay && format(new Date(`${overflowDay}T12:00:00`), "EEEE, MMMM d")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            {overflowEvents.map((event) => (
              <EventChip
                key={event.id}
                event={event}
                members={members}
                tz={tz}
                hasConflict={conflictIds.has(event.id)}
                onClick={() => {
                  setOverflowDay(null);
                  onSelectEvent(event);
                }}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
