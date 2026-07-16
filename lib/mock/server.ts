import "server-only";

import { dataAdapter as mockDataAdapter } from "@/lib/mock/adapter";
import type { DataAdapter } from "@/lib/mock/adapter";
import { realDataAdapter } from "@/lib/data/server-adapter";

/**
 * Server-only selector between the mock adapter and the real one
 * (`lib/data/server-adapter.ts`, DB + Google Calendar). This file — not
 * `lib/mock/index.ts` — is the only place that imports `realDataAdapter`,
 * so only Server Components (which import this module directly, never
 * through the client-safe `@/lib/mock` barrel) ever pull in `getDb()` /
 * `googleapis`. The `import "server-only"` above turns any accidental
 * client-component import of *this* file into a build error, same as
 * `lib/data/server-adapter.ts` itself.
 *
 * Gate: `DATABASE_URL` set == real backend configured. This mirrors
 * `lib/db/index.ts`'s own lazy-init check and keeps two things true at
 * once:
 *   - `next build` with no env vars never touches the DB/Google (pages
 *     that call this are also marked `force-dynamic`, so nothing here runs
 *     at build time regardless — this gate is what makes local dev without
 *     a `.env.local` and the product demo fall back to mock data).
 *   - Once `DATABASE_URL` (and the Google/BlueBubbles env vars it implies
 *     in practice) are configured — i.e. in production — every dashboard
 *     page reads live data with no further code change.
 */
export function getServerAdapter(): DataAdapter {
  return process.env.DATABASE_URL ? realDataAdapter : mockDataAdapter;
}
