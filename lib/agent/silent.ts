/**
 * Silent mode: the agent listens and acts on the calendar but never sends a
 * text. Used while the bridge Mac can receive iMessages but can't send them
 * (BlueBubbles' AppleScript send path is broken on macOS 26 and the Private
 * API needs SIP disabled) — see docs/bluebubbles-setup.md "Silent mode".
 */
export function isAgentSilent(): boolean {
  return process.env.AGENT_SILENT === "true";
}
