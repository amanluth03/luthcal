import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// -----------------------------------------------------------------------------
// Sign-in page. Deliberately outside app/(dashboard) — it must render (and
// must NOT require a session) even when the dashboard shell/data adapter is
// unhappy, and it's explicitly excluded from proxy.ts's matcher so it never
// participates in the auth redirect loop it exists to break. Minimal by
// design; frontend-design owns visual polish for the rest of the app and
// can restyle this later — see the task boundary in CLAUDE.md.
// -----------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  // Auth.js's AccessDenied — thrown when auth.ts's `signIn` callback
  // returns false, i.e. the Google account isn't in FAMILY_EMAILS.
  AccessDenied: "This Google account isn't on the family list — ask Aman to add you.",
  Configuration: "Sign-in is misconfigured. Ask Aman to check the Google OAuth setup.",
};

/**
 * Only ever redirect to a same-origin, root-relative path. `callbackUrl`
 * arrives as a public query param (either set by proxy.ts from a real
 * pathname, or typed directly into the address bar by anyone), so it must
 * be sanitized before being handed to `signIn(..., { redirectTo })` and to
 * the already-signed-in `redirect(target)` below — otherwise this would be
 * an open redirect.
 *
 * A naive `startsWith("/") && !startsWith("//")` check is NOT enough: a
 * browser normalizes backslashes to forward slashes for http(s), so
 * `"/\\evil.com"` (and `"/\\/evil.com"`) resolve to `https://evil.com`, and
 * `"/..//evil.com"` normalizes to a protocol-relative `//evil.com`. So we
 * resolve against a throwaway origin with the WHATWG URL parser (which
 * applies the same normalization the browser will) and accept the result
 * only if it stayed on that origin AND its path is a single-slash path.
 */
function safeCallbackUrl(raw: string | undefined): string {
  if (!raw) return "/";
  let path: string;
  try {
    const url = new URL(raw, "http://x.invalid");
    if (url.origin !== "http://x.invalid") return "/";
    path = url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
  // Guard the normalized path itself against protocol-relative forms.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/";
  return path;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  const target = safeCallbackUrl(callbackUrl);

  // Already have a valid (allowlisted) session and landed here anyway —
  // e.g. a stale bookmark or a "sign in" link double-tap — just forward
  // into the dashboard instead of showing the button again.
  const session = await auth();
  if (session) {
    redirect(target);
  }

  const errorMessage = error ? (ERROR_MESSAGES[error] ?? "Something went wrong signing in. Please try again.") : null;

  return (
    <div className="flex min-h-dvh w-full flex-1 items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center gap-1 text-center">
          <CardTitle className="font-heading text-xl">LuthCal</CardTitle>
          <CardDescription>Sign in with the Google account on the family list.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errorMessage ? (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: target });
            }}
          >
            <Button type="submit" className="w-full" size="lg">
              Sign in with Google
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
