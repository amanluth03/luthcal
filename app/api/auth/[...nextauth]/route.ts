import { handlers } from "@/auth";

// Auth.js v5 catch-all route: handles /api/auth/signin, /callback/google,
// /session, /signout, /csrf, etc. Deliberately NOT gated by proxy.ts's
// auth check (see its matcher) — this IS the sign-in flow, so gating it
// would make it impossible to ever sign in.
export const { GET, POST } = handlers;
