import { dataAdapter } from "@/lib/mock";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Activity" };

export default async function ActivityPage() {
  const [activity, members, settings] = await Promise.all([
    dataAdapter.getActivity(),
    dataAdapter.getFamilyMembers(),
    dataAdapter.getSettings(),
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
