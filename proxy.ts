import { NextResponse } from "next/server";
import { auth } from "@/auth";

// -----------------------------------------------------------------------------
// NOTE ON FILENAME: this is `proxy.ts`, not `middleware.ts`.
//
// In this Next.js version, the `middleware` file convention is deprecated
// and renamed to `proxy` — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
// ("Migration to Proxy" / version history: "v16.0.0 | Middleware is
// deprecated and renamed to Proxy"). A `middleware.ts` file still works
// (Next warns once via `_log.warnOnce`, confirmed in
// node_modules/next/dist/build/index.js), but a `middleware.ts` AND a
// `proxy.ts` coexisting is a hard build error, and AGENTS.md says to heed
// deprecation notices in this codebase. So this file — not middleware.ts —
// is what Next actually loads for every matched request below. The
// exported function's *name* doesn't matter to Next (default export or a
// function literally named `proxy` both satisfy the file convention);
// only the *file's* name does.
//
// Auth.js's `auth()` higher-order function wraps a request handler exactly
// like the old `middleware()` export took one — see
// node_modules/next-auth/lib/index.d.ts's `NextAuthMiddleware` type. It
// verifies the session cookie and populates `req.auth` before the wrapped
// function runs. Proxy defaults to the Node.js runtime in this Next
// version (see proxy.md "Runtime"), so there's no edge-runtime JWT/crypto
// caveat to worry about here.
// -----------------------------------------------------------------------------
export default auth((req) => {
  if (req.auth) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // API callers (today: the dashboard's own fetch to /api/chat) get a 401
  // JSON body they can branch on, instead of being redirected into HTML.
  // app/api/chat/route.ts also re-checks the session itself as defense in
  // depth, in case this file's matcher is ever loosened by a future edit.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const signInUrl = new URL("/signin", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", pathname);
  return NextResponse.redirect(signInUrl);
});

export const config = {
  /**
   * Protect-by-default: every request runs through the check above EXCEPT
   * the paths explicitly carved out by the negative lookahead. This fails
   * safe — a dashboard page or API route added later that forgets to
   * update this file is protected automatically rather than silently
   * public, which matters more here than the opposite failure mode (a
   * route that *should* be public but is accidentally gated fails loudly,
   * as a 401/redirect, not by leaking data).
   *
   * Traced against every current route (see `find app -name "page.tsx" -o
   * -name "route.ts"` from the repo root) as of this writing:
   *
   *   GATED (session required):
   *     "/", "/activity", "/digests", "/family", "/settings"  — dashboard pages
   *     "/api/chat"                                            — drives the agent
   *
   *   NOT gated (excluded below):
   *     "/api/auth/*"                    — the sign-in flow itself; gating
   *                                         it would make signing in impossible
   *     "/api/webhooks/bluebubbles"      — inbound iMessage webhook, authenticated
   *     "/api/webhooks/google"           — by its own shared secret
   *                                         (BLUEBUBBLES_WEBHOOK_SECRET / channel
   *                                         token) — see lib/webhook-auth.ts,
   *                                         lib/google/watch.ts. Not a browser
   *                                         session; gating it would break the bridge.
   *     "/api/cron/*"                    — Vercel Cron / GitHub Actions pinger,
   *                                         authenticated by CRON_SECRET — see
   *                                         lib/webhook-auth.ts. Gating it would
   *                                         break digests/reminders/outbound retry.
   *     "/signin"                        — must stay reachable while logged out,
   *                                         else redirect loop
   *     "/_next/static", "/_next/image", "favicon.ico" — framework/static assets
   */
  // NOTE: the exclusions are bounded (trailing `/` on the API subtrees,
  // `(?:/|$)` on signin) so the negative lookahead can't accidentally
  // un-gate a *future* route that merely shares a prefix — e.g. an
  // `/api/authorize-*`, `/api/webhooks-admin`, `/api/cron-internal`, or a
  // `/signin-something` page would still be gated. Auth.js, webhook, and
  // cron routes are always subpaths (`/api/auth/<action>`, etc.), so the
  // trailing slash never excludes a real one.
  matcher: [
    "/((?!api/auth/|api/webhooks/|api/cron/|signin(?:/|$)|_next/static|_next/image|favicon\\.ico).*)",
  ],
};
