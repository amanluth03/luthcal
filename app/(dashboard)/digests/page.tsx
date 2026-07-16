import { getServerAdapter } from "@/lib/mock/server";
import { DigestFeed } from "@/components/digests/digest-feed";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Digests" };

// Live data (DB + Google Calendar) must be fetched fresh per request, never
// baked in at build time — see lib/mock/server.ts.
export const dynamic = "force-dynamic";

export default async function DigestsPage() {
  const adapter = getServerAdapter();
  const [digests, settings] = await Promise.all([
    adapter.getDigests(),
    adapter.getSettings(),
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
