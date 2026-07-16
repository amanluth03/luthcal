import { getServerAdapter } from "@/lib/mock/server";
import { FamilyManager } from "@/components/family/family-manager";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Family" };

// Live data (DB + Google Calendar) must be fetched fresh per request, never
// baked in at build time — see lib/mock/server.ts.
export const dynamic = "force-dynamic";

export default async function FamilyPage() {
  const members = await getServerAdapter().getFamilyMembers();

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Family"
        description="Names, iMessage handles, and aliases the agent matches in texts."
      />
      <FamilyManager initialMembers={members} />
    </div>
  );
}
