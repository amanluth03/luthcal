import { describe, expect, it } from "vitest";

import { extractServerUrlChange } from "@/lib/bluebubbles";

// BlueBubbles reports a rotated tunnel URL as a webhook event of type
// "new-server" whose `data` is the bare URL string (bluebubbles-server
// packages/server/src/server/index.ts: emitMessage(NEW_SERVER,
// nextConfig.server_address)). The inbound webhook must recognise exactly
// that shape so the stored bridge URL self-heals after a quick-tunnel
// restart.

describe("extractServerUrlChange", () => {
  it("returns the URL from a new-server event whose data is the URL string", () => {
    expect(extractServerUrlChange({ type: "new-server", data: "https://abc-def.trycloudflare.com" })).toBe(
      "https://abc-def.trycloudflare.com",
    );
  });

  it("trims surrounding whitespace from the URL", () => {
    expect(extractServerUrlChange({ type: "new-server", data: "  https://abc-def.trycloudflare.com\n" })).toBe(
      "https://abc-def.trycloudflare.com",
    );
  });

  it("ignores a new-server event whose data is not an http(s) URL", () => {
    expect(extractServerUrlChange({ type: "new-server", data: "not a url" })).toBeUndefined();
    expect(extractServerUrlChange({ type: "new-server", data: "ftp://abc.example" })).toBeUndefined();
    expect(extractServerUrlChange({ type: "new-server", data: "" })).toBeUndefined();
  });

  it("ignores a new-server event whose data is not a string", () => {
    expect(extractServerUrlChange({ type: "new-server", data: { url: "https://abc.example" } })).toBeUndefined();
    expect(extractServerUrlChange({ type: "new-server" })).toBeUndefined();
  });

  it("ignores every other event type, including the names the handler used to guess at", () => {
    for (const type of ["new-message", "server-url-change", "server-url-changed", "new-server-url", undefined]) {
      expect(extractServerUrlChange({ type, data: "https://abc.example" })).toBeUndefined();
    }
  });
});
