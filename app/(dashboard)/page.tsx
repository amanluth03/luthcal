import { addMonths, endOfMonth, startOfMonth, subMonths } from "date-fns";
import { getServerAdapter } from "@/lib/mock/server";
import { CalendarView } from "@/components/calendar/calendar-view";
import { SectionHeader } from "@/components/section-header";

// Live data (DB + Google Calendar) must be fetched fresh per request, never
// baked in at build time — see lib/mock/server.ts.
export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const adapter = getServerAdapter();
  const [members, settings] = await Promise.all([
    adapter.getFamilyMembers(),
    adapter.getSettings(),
  ]);

  const now = new Date();
  const rangeStart = startOfMonth(subMonths(now, 1));
  const rangeEnd = endOfMonth(addMonths(now, 2));
  const events = await adapter.getEvents(rangeStart.toISOString(), rangeEnd.toISOString());

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Calendar"
        description="The shared Luthra family calendar — color-coded by who's involved."
      />
      <CalendarView members={members} events={events} tz={settings.timezone} />
    </div>
  );
}
