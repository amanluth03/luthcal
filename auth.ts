import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// -----------------------------------------------------------------------------
// Auth.js v5 (next-auth@beta) config. Google sign-in only, gated by a family
// email allowlist — this is what closes the "dashboard shows real family
// data to anyone with the URL" hole. No DB adapter: sessions are a signed
// JWT cookie, since the only thing a session gates is "can this browser
// drive the dashboard/agent," not per-user ownership of stored data. See
// docs/agent-core.md / CLAUDE.md for the rest of the architecture.
//
// Reuses the existing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET Google Cloud
// OAuth "Web application" client (the same one lib/google's refresh-token
// flow was minted against) instead of requiring separate AUTH_GOOGLE_ID /
// AUTH_GOOGLE_SECRET vars. That OAuth client's "Authorized redirect URIs"
// must include `{origin}/api/auth/callback/google` for every origin this
// runs on — see .env.example for the exact prod + localhost values.
// -----------------------------------------------------------------------------

/**
 * Parses FAMILY_EMAILS ("a@x.com, B@Y.com,, c@z.com") into a trimmed,
 * lowercased, de-duplicated allowlist. Re-parsed on every `signIn` call
 * (not cached at module scope) so a Vercel env var change takes effect on
 * the next deploy without an auth.ts edit — matches "more emails added
 * later" from the task.
 */
function parseFamilyEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  secret: process.env.AUTH_SECRET,
  // Vercel sets `VERCEL=1` at runtime, which @auth/core already treats as a
  // trusted host (see node_modules/@auth/core/lib/utils/env.js
  // setEnvDefaults). Setting this explicitly makes it not depend on that
  // env var being present — LuthCal is Vercel-only per CLAUDE.md, so this
  // is always the correct value, in prod and in `next dev`/tests alike.
  trustHost: true,
  pages: {
    signIn: "/signin",
    // Route the "not on the allowlist" redirect back to the same page
    // (as `?error=AccessDenied`) instead of Auth.js's generic error screen
    // — app/signin/page.tsx reads `error` and shows the family-specific
    // rejection message.
    error: "/signin",
  },
  callbacks: {
    /**
     * The allowlist gate. Returning `false` here makes Auth.js throw
     * AccessDenied and redirect to `pages.error` above — no session cookie
     * is ever issued for a non-family Google account, and since there's no
     * DB adapter, no user/account row exists anywhere for one to leak from
     * either. This runs on every sign-in attempt (not just the first), so
     * removing an email from FAMILY_EMAILS also revokes future sign-ins
     * for it immediately (existing sessions still expire on their own per
     * the JWT's exp claim — this is a login-time gate, not per-request
     * revocation).
     */
    async signIn({ user }) {
      const allowlist = parseFamilyEmails(process.env.FAMILY_EMAILS);
      const email = user.email?.toLowerCase();
      if (!email || allowlist.length === 0) return false;
      return allowlist.includes(email);
    },
  },
});
