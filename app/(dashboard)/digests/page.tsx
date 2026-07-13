import { dataAdapter } from "@/lib/mock";
import { DigestFeed } from "@/components/digests/digest-feed";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Digests" };

export default async function DigestsPage() {
  const [digests, settings] = await Promise.all([
    dataAdapter.getDigests(),
    dataAdapter.getSettings(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Digests"
        description="What the agent has announced to the group chat, and when."
      />
      <DigestFeed digests={digests} tz={settings.timezone} />
    </div>
  );
}
