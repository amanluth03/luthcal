import { getActiveMemories } from "@/lib/data/memory";
import { getServerAdapter } from "@/lib/mock/server";
import { MemoryManager } from "@/components/memory/memory-manager";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Memory" };

// Live data (DB) must be fetched fresh per request, never baked in at build
// time — see lib/mock/server.ts.
export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const [memories, settings] = await Promise.all([
    getActiveMemories(),
    getServerAdapter().getSettings(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Memory"
        description="Durable facts, preferences, and decisions the agent has been told to remember."
      />
      <MemoryManager initialMemories={memories} tz={settings.timezone} />
    </div>
  );
}
