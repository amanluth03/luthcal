"use client";

import { useEffect, useRef } from "react";
import { addDays, eachDayOfInterval, format, startOfWeek } from "date-fns";
import type { FamilyMember, LuthEvent } from "@/lib/mock/types";
import { eventOccursOnDay, todayKey, zoned } from "@/lib/format";
import { layoutDayEvents } from "@/components/calendar/layout";
import { EventChip } from "@/components/calendar/event-chip";
import { EventBlock } from "@/components/calendar/event-block";
import { cn } from "@/lib/utils";

const GRID_START_HOUR = 6;
const GRID_END_HOUR = 22;
const HOUR_HEIGHT = 64; // px
const GRID_HEIGHT = (GRID_END_HOUR - GRID_START_HOUR) * HOUR_HEIGHT;

const HOUR_LABELS = Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) =>
  format(new Date(2000, 0, 1, GRID_START_HOUR + i), "h a")
);

export function WeekGrid({
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
  const weekStart = startOfWeek(cursor, { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: weekStart, end: addDays(weekStart, 6) });
  const today = todayKey(tz);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Extracted so the dependency is a statically-checkable value, not a call
  // expression (react-hooks/exhaustive-deps).
  const weekStartMs = weekStart.getTime();
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: (8 - GRID_START_HOUR) * HOUR_HEIGHT });
  }, [weekStartMs]);

  const dayKeys = days.map((d) => format(d, "yyyy-MM-dd"));
  const allDayEvents = dayKeys.map((k) =>
    events.filter((e) => e.allDay && eventOccursOnDay(e, k, tz))
  );
  const timedEvents = dayKeys.map((k) =>
    events.filter((e) => !e.allDay && eventOccursOnDay(e, k, tz))
  );
  const hasAnyAllDay = allDayEvents.some((list) => list.length > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          {/* Day headers */}
          <div className="flex border-b border-border">
            <div className="w-14 shrink-0" />
            {days.map((day, i) => {
              const isToday = dayKeys[i] === today;
              return (
                <div key={dayKeys[i]} className="flex-1 min-w-0 py-2 text-center">
                  <div className="text-xs text-muted-foreground">{format(day, "EEE")}</div>
                  <div
                    className={cn(
                      "mx-auto mt-0.5 flex size-6 items-center justify-center rounded-full text-sm tabular-nums",
                      isToday && "bg-primary font-medium text-primary-foreground"
                    )}
                  >
                    {format(day, "d")}
                  </div>
                </div>
              );
            })}
          </div>

          {/* All-day strip */}
          {hasAnyAllDay && (
            <div className="flex border-b border-border">
              <div className="flex w-14 shrink-0 items-start justify-end pt-1 pr-1.5 text-[10px] text-muted-foreground">
                All day
              </div>
              {days.map((_, i) => (
                <div key={dayKeys[i]} className="flex-1 min-w-0 space-y-0.5 p-1">
                  {allDayEvents[i].map((event) => (
                    <EventChip
                      key={event.id}
                      event={event}
                      members={members}
                      tz={tz}
                      hasConflict={conflictIds.has(event.id)}
                      onClick={() => onSelectEvent(event)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Hour grid */}
          <div ref={bodyRef} className="max-h-[65vh] overflow-y-auto">
            <div className="flex">
              <div className="relative w-14 shrink-0 border-r border-border">
                {HOUR_LABELS.map((label, i) => (
                  <span
                    key={label}
                    style={{ top: i * HOUR_HEIGHT }}
                    className="absolute right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
                <div style={{ height: GRID_HEIGHT }} />
              </div>
              {days.map((_, i) => (
                <div
                  key={dayKeys[i]}
                  className="relative min-w-0 flex-1 border-r border-border last:border-r-0"
                  style={{
                    height: GRID_HEIGHT,
                    backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${HOUR_HEIGHT}px)`,
                  }}
                >
                  {layoutDayEvents(timedEvents[i]).map(({ event, col, cols }) => {
                    const startZoned = zoned(event.start, tz);
                    const endZoned = zoned(event.end, tz);
                    const startMin = startZoned.getHours() * 60 + startZoned.getMinutes();
                    const endMin = endZoned.getHours() * 60 + endZoned.getMinutes();
                    const gridStartMin = GRID_START_HOUR * 60;
                    const top = Math.max(0, ((startMin - gridStartMin) / 60) * HOUR_HEIGHT);
                    const bottom = Math.min(
                      GRID_HEIGHT,
                      ((endMin - gridStartMin) / 60) * HOUR_HEIGHT
                    );
                    const height = Math.max(20, bottom - top);
                    const widthPct = 100 / cols;

                    return (
                      <EventBlock
                        key={event.id}
                        event={event}
                        members={members}
                        tz={tz}
                        hasConflict={conflictIds.has(event.id)}
                        onClick={() => onSelectEvent(event)}
                        style={{
                          top,
                          height,
                          left: `${col * widthPct}%`,
                          width: `calc(${widthPct}% - 3px)`,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
