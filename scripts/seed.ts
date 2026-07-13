import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { familyMembers } from "../lib/db/schema";

// PLACEHOLDER family data — replace with the real family roster (names,
// iMessage handles, phone numbers, colors, aliases) before going live.
const members = [
  {
    name: "Aman",
    imessageHandle: "amanluth03@gmail.com",
    phone: null,
    color: "#3b82f6",
    aliases: ["Aman"],
  },
  {
    name: "PLACEHOLDER_MEMBER_2",
    imessageHandle: null,
    phone: null,
    color: "#ef4444",
    aliases: ["PLACEHOLDER_MEMBER_2"],
  },
  {
    name: "PLACEHOLDER_MEMBER_3",
    imessageHandle: null,
    phone: null,
    color: "#22c55e",
    aliases: ["PLACEHOLDER_MEMBER_3"],
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
