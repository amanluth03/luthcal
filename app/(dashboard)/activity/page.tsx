import { getServerAdapter } from "@/lib/mock/server";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Activity" };

// Live data (DB + Google Calendar) must be fetched fresh per request, never
// baked in at build time — see lib/mock/server.ts.
export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const adapter = getServerAdapter();
  const [activity, members, settings] = await Promise.all([
    adapter.getActivity(),
    adapter.getFamilyMembers(),
    adapter.getSettings(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Activity"
        description="Inbound texts from the family, and what the agent did about them."
      />
      <ActivityFeed activity={activity} members={members} tz={settings.timezone} />
    </div>
  );
}
