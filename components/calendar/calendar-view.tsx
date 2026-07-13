"use client";

import { useMemo, useState } from "react";
import { addMonths, addWeeks, endOfWeek, format, startOfWeek } from "date-fns";
import type { FamilyMember, LuthEvent } from "@/lib/mock/types";
import { findConflictingEventIds } from "@/lib/mock/conflicts";
import { zoned } from "@/lib/format";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { MonthGrid } from "@/components/calendar/month-grid";
import { WeekGrid } from "@/components/calendar/week-grid";
import { EventDetailDialog } from "@/components/calendar/event-detail-dialog";
import { MemberLegend } from "@/components/member/member-legend";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type ViewMode = "month" | "week";

export function CalendarView({
  members,
  events,
  tz,
}: {
  members: FamilyMember[];
  events: LuthEvent[];
  tz: string;
}) {
  const [view, setView] = useState<ViewMode>("month");
  const [cursor, setCursor] = useState(() => zoned(new Date().toISOString(), tz));
  const [selectedEvent, setSelectedEvent] = useState<LuthEvent | null>(null);

  const conflictIds = useMemo(() => findConflictingEventIds(events), [events]);

  const label = useMemo(() => {
    if (view === "month") return format(cursor, "MMMM yyyy");
    const start = startOfWeek(cursor, { weekStartsOn: 0 });
    const end = endOfWeek(cursor, { weekStartsOn: 0 });
    const sameMonth = format(start, "MMM") === format(end, "MMM");
    return sameMonth
      ? `${format(start, "MMM d")} – ${format(end, "d, yyyy")}`
      : `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
  }, [view, cursor]);

  function goPrev() {
    setCursor((c) => (view === "month" ? addMonths(c, -1) : addWeeks(c, -1)));
  }
  function goNext() {
    setCursor((c) => (view === "month" ? addMonths(c, 1) : addWeeks(c, 1)));
  }
  function goToday() {
    setCursor(zoned(new Date().toISOString(), tz));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CalendarToolbar label={label} onPrev={goPrev} onNext={goNext} onToday={goToday} />
        <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
          <TabsList>
            <TabsTrigger value="month">Month</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <MemberLegend members={members} />

      {view === "month" ? (
        <MonthGrid
          cursor={cursor}
          members={members}
          events={events}
          conflictIds={conflictIds}
          tz={tz}
          onSelectEvent={setSelectedEvent}
        />
      ) : (
        <WeekGrid
          cursor={cursor}
          members={members}
          events={events}
          conflictIds={conflictIds}
          tz={tz}
          onSelectEvent={setSelectedEvent}
        />
      )}

      <EventDetailDialog
        event={selectedEvent}
        members={members}
        allEvents={events}
        tz={tz}
        onClose={() => setSelectedEvent(null)}
      />
    </div>
  );
}
