import { describe, expect, it } from "vitest";
import { parseMessage, type NodeToServer, type BrowserToServer, type ServerToBrowser } from "./protocol.js";

const session = { id: "s1", machineId: "alpha", cwd: "/x", model: "opus", status: "running" as const };

describe("parseMessage — round-trips every wire message", () => {
  const ok: unknown[] = [
    { t: "hello", role: "node", machineId: "alpha", token: "secret" } satisfies NodeToServer,
    { t: "hello", role: "browser", token: "secret" } satisfies BrowserToServer,
    { t: "sessions", sessions: [session] } satisfies NodeToServer,
    { t: "promptRaised", promptId: "p1", sessionId: "s1", tool: "Bash", detail: "rm -rf" } satisfies NodeToServer,
    { t: "artifact", sessionId: "s1", diff: "--- a\n+++ b\n" } satisfies NodeToServer,
    { t: "promptResolved", promptId: "p1", approve: true } satisfies NodeToServer,
    { t: "decision", promptId: "p1", approve: false } satisfies BrowserToServer,
    { t: "snapshot", machines: [] } satisfies ServerToBrowser,
    { t: "patch", ops: [] } satisfies ServerToBrowser,
  ];

  for (const msg of ok) {
    it(`accepts ${(msg as { t: string; role?: string }).t}${(msg as { role?: string }).role ? ":" + (msg as { role?: string }).role : ""}`, () => {
      expect(parseMessage(JSON.stringify(msg))).toEqual(msg);
    });
  }

  it("distinguishes node hello from browser hello by role", () => {
    const n = parseMessage('{"t":"hello","role":"node","machineId":"a","token":"x"}');
    const b = parseMessage('{"t":"hello","role":"browser","token":"x"}');
    expect(n && "machineId" in n).toBe(true);
    expect(b && "machineId" in b).toBe(false);
  });
});

describe("parseMessage — rejects malformed", () => {
  for (const bad of [
    "not json",
    "{}",
    '{"t":"unknown"}',
    '{"t":"hello","role":"martian","token":"x"}',
    '{"t":"decision","promptId":"p1"}', // missing approve
    '{"t":"sessions","sessions":"nope"}',
    '{"t":"promptRaised","promptId":"p1"}', // missing fields
  ]) {
    it(`rejects ${bad.slice(0, 30)}`, () => {
      expect(parseMessage(bad)).toBeNull();
    });
  }
});
