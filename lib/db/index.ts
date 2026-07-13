import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let db: Db | undefined;

// Lazy singleton: reads DATABASE_URL on first use rather than at import time,
// so `next build` (and any other code path that imports this module without
// a database configured) doesn't throw.
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    const sql = neon(url);
    db = drizzle(sql, { schema });
  }
  return db;
}
