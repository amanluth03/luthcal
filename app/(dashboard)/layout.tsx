import { getServerAdapter } from "@/lib/mock/server";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AppTopbar } from "@/components/layout/app-topbar";
import { ChatLauncher } from "@/components/chat/chat-launcher";
import type { FamilyMember } from "@/lib/mock/types";

// Live data (DB + Google Calendar) must be fetched fresh per request, never
// baked in at build time — see lib/mock/server.ts.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The sidebar/topbar roster is chrome, not primary content. A page's own data
  // failure surfaces via app/(dashboard)/error.tsx, but a throw HERE would bubble
  // past that boundary (Next: a segment's error.tsx doesn't wrap its own layout)
  // and white-screen the entire dashboard — the fallback UI CLAUDE.md says must
  // stay usable. So degrade to an empty roster and keep navigation alive.
  let members: FamilyMember[] = [];
  try {
    members = await getServerAdapter().getFamilyMembers();
  } catch (err) {
    console.error("Dashboard layout: failed to load family roster:", err);
  }

  return (
    <div className="flex h-dvh min-h-0 w-full">
      <AppSidebar members={members} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppTopbar members={members} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>
      <ChatLauncher />
    </div>
  );
}
