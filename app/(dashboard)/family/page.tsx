import { dataAdapter } from "@/lib/mock";
import { FamilyManager } from "@/components/family/family-manager";
import { SectionHeader } from "@/components/section-header";

export const metadata = { title: "Family" };

export default async function FamilyPage() {
  const members = await dataAdapter.getFamilyMembers();

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
