import { addMonths, endOfMonth, startOfMonth, subMonths } from "date-fns";
import { dataAdapter } from "@/lib/mock";
import { CalendarView } from "@/components/calendar/calendar-view";
import { SectionHeader } from "@/components/section-header";

export default async function CalendarPage() {
  const [members, settings] = await Promise.all([
    dataAdapter.getFamilyMembers(),
    dataAdapter.getSettings(),
  ]);

  const now = new Date();
  const rangeStart = startOfMonth(subMonths(now, 1));
  const rangeEnd = endOfMonth(addMonths(now, 2));
  const events = await dataAdapter.getEvents(rangeStart.toISOString(), rangeEnd.toISOString());

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
