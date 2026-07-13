/**
 * One-time OAuth2 consent flow to mint a long-lived GOOGLE_REFRESH_TOKEN for
 * the shared "Luthra Family" Google Calendar.
 *
 * Run with:
 *   npx tsx scripts/google-auth.ts
 *
 * Before running:
 *   1. In Google Cloud Console, create (or reuse) a project and enable the
 *      "Google Calendar API".
 *   2. Create an OAuth 2.0 Client ID (APIs & Services > Credentials > Create
 *      Credentials > OAuth client ID). Application type "Desktop app" works,
 *      but you must still add the redirect URI below to "Authorized redirect
 *      URIs" (Desktop-app clients otherwise default to the deprecated
 *      out-of-band flow, which Google no longer allows for new clients):
 *        http://localhost:8945/oauth2callback
 *   3. Put the client id/secret in .env.local:
 *        GOOGLE_CLIENT_ID=...
 *        GOOGLE_CLIENT_SECRET=...
 *   4. Make sure the Google account you authorize with has at least "Make
 *      changes to events" access on the shared family calendar (Settings and
 *      sharing > Share with specific people), and that FAMILY_CALENDAR_ID in
 *      .env.local is set to that calendar's id.
 *
 * This script will:
 *   - print a consent URL to open in a browser,
 *   - start a temporary local server to catch the OAuth redirect,
 *   - exchange the returned code for tokens, and
 *   - print the refresh_token to paste into .env.local as GOOGLE_REFRESH_TOKEN.
 *
 * It never writes .env.local itself — real secrets are never auto-written to
 * disk by this repo's tooling; you copy the value in by hand.
 */
import { createServer } from "node:http";
import { google } from "googleapis";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const PORT = 8945;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\nMissing ${name}. Set it in .env.local first (see the header of this script for setup steps).\n`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");

  const oauth2Client = new google.auth.OAuth2({ clientId, clientSecret, redirectUri: REDIRECT_URI });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // required to receive a refresh_token
    prompt: "consent", // force the consent screen so a refresh_token is issued even on repeat runs
    scope: SCOPES,
  });

  console.log("\n1. Open this URL in a browser signed into the Google account that shares the family calendar:\n");
  console.log(`   ${authUrl}\n`);
  console.log(`2. Approve access. You'll be redirected to ${REDIRECT_URI} — this script is listening there.\n`);
  console.log("Waiting for the redirect...\n");

  const code = await waitForAuthorizationCode();

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      "\nGoogle did not return a refresh_token. This usually means this Google account already granted consent " +
        "without `prompt=consent` sticking — revoke LuthCal's access at https://myaccount.google.com/permissions " +
        "and re-run this script.\n",
    );
    process.exit(1);
  }

  console.log("\nSuccess! Add this to .env.local (and to Vercel's project env for production):\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  process.exit(0);
}

function waitForAuthorizationCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<html><body><h1>Authorization failed: ${error}</h1>You can close this tab.</body></html>`);
        server.close();
        reject(new Error(`Google returned an error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body>No authorization code in the redirect.</body></html>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Got it — you can close this tab.</h1></body></html>");
      server.close();
      resolve(code);
    });

    server.listen(PORT);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
