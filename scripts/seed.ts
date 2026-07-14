import { eq } from "drizzle-orm";
import { getDb } from "../lib/db";
import { familyMembers } from "../lib/db/schema";

// The Luthra family roster. iMessage handles (phone/Apple email) are still
// TODO for most members — fill them in before go-live so outbound texts and
// inbound sender→member matching work. Note: "son" is intentionally NOT an
// alias of either Aman or Yash — it's ambiguous between them, so the agent
// should ask which son rather than guess.
const members = [
  {
    name: "Aman",
    imessageHandle: "amanluth03@gmail.com",
    phone: null,
    color: "#3b82f6", // blue
    aliases: ["Aman"],
  },
  {
    name: "Yash",
    imessageHandle: null,
    phone: null,
    color: "#14b8a6", // teal
    aliases: ["Yash"],
  },
  {
    name: "Vijay",
    imessageHandle: null,
    phone: null,
    color: "#8b5cf6", // violet
    aliases: ["Vijay", "Papa", "Dad"],
  },
  {
    name: "Ekta",
    imessageHandle: null,
    phone: null,
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
