import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { familyMembers } from "../lib/db/schema";

// The Luthra family roster.
//
// `identifiers` holds each member's known Google/dashboard sign-in email —
// this is what lib/agent/resolve-sender.ts's resolveSenderMemberId matches
// a dashboard session's email against (see docs/agent-core.md "Identifier
// consolidation"). Previously only Aman's row had an email at all, and it
// was crammed into `imessageHandle` (a field meant for the iMessage/Apple-ID
// handle) as a one-off workaround — that's why Yash/Vijay/Ekta never
// resolved to a family_members row on the dashboard. All four now carry
// their email the same, uniform way.
//
// `imessageHandle`/`phone` are still TODO for every member — fill them in
// during BlueBubbles bridge setup (docs/bluebubbles-setup.md) once each
// person's iMessage-registered phone number / Apple ID is known, so outbound
// texts and inbound sender→member matching work over iMessage too. Note:
// "son" is intentionally NOT an alias of either Aman or Yash — it's
// ambiguous between them, so the agent should ask which son rather than
// guess.
const members = [
  {
    name: "Aman",
    imessageHandle: null, // TODO(bridge-setup): Aman's iMessage phone/Apple ID
    phone: null,
    identifiers: ["amanluth03@gmail.com"],
    color: "#3b82f6", // blue
    aliases: ["Aman"],
  },
  {
    name: "Yash",
    imessageHandle: null, // TODO(bridge-setup): Yash's iMessage phone/Apple ID
    phone: null,
    identifiers: ["yashluth27@gmail.com"],
    color: "#14b8a6", // teal
    aliases: ["Yash"],
  },
  {
    name: "Vijay",
    imessageHandle: null, // TODO(bridge-setup): Vijay's iMessage phone/Apple ID
    phone: null,
    identifiers: ["vijay.luthra@gmail.com"],
    color: "#8b5cf6", // violet
    aliases: ["Vijay", "Papa", "Dad"],
  },
  {
    name: "Ekta",
    imessageHandle: null, // TODO(bridge-setup): Ekta's iMessage phone/Apple ID
    phone: null,
    identifiers: ["eluthra@gmail.com"],
    color: "#f43f5e", // rose
    aliases: ["Ekta", "Mai", "Mom"],
  },
];

async function seed() {
  const db = getDb();

  // `name` has no unique constraint, so upsert manually: skip members that
  // already exist by name, insert the rest.
  let inserted = 0;
  for (const member of members) {
    const existing = await db
      .select({ id: familyMembers.id })
      .from(familyMembers)
      .where(eq(familyMembers.name, member.name))
      .limit(1);

    if (existing.length === 0) {
      await db.insert(familyMembers).values(member);
      inserted++;
    }
  }

  console.log(`Seeded ${inserted} new family member(s) (${members.length} total in roster).`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
