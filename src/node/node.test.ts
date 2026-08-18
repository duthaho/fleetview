import { describe, it, expect } from "vitest";
import { FleetNode } from "./node.js";
import { SimulatedSource } from "./sources/simulated.js";
import { parseMessage, encode, type SessionEvent, type WireMessage } from "../protocol.js";
import type { SessionSource } from "./source.js";

// A fake ws connection: captures outbound frames, lets the test push inbound.
function fakeConn() {
  const sent: WireMessage[] = [];
  const handlers: Record<string, ((data: unknown) => void)[]> = {};
  return {
    conn: {
      send(data: string) {
        const m = parseMessage(data);
        if (m) sent.push(m);
      },
      on(event: string, cb: (data: unknown) => void) {
        (handlers[event] ??= []).push(cb);
      },
    },
    sent,
    inbound(msg: WireMessage) {
      for (const cb of handlers["message"] ?? []) cb(encode(msg));
    },
    fire(event: string) {
      for (const cb of handlers[event] ?? []) cb(undefined);
    },
  };
}

describe("FleetNode", () => {
  it("sends a node hello with machineId + token on start", () => {
    const { conn, sent } = fakeConn();
    const source = new SimulatedSource("alpha", "sim-1");
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    const hello = sent.find((m) => m.t === "hello");
    expect(hello).toEqual({ t: "hello", role: "node", machineId: "alpha", token: "secret" });
  });

  it("announces sessions from the source", () => {
    const { conn, sent } = fakeConn();
    const source = new SimulatedSource("alpha", "sim-1");
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    const sessionsMsg = sent.filter((m) => m.t === "sessions").at(-1);
    expect(sessionsMsg).toBeTruthy();
    if (sessionsMsg?.t === "sessions") {
      expect(sessionsMsg.sessions[0].id).toBe("sim-1");
      expect(sessionsMsg.sessions[0].status).toBe("starting");
    }
  });

  it("forwards a raised prompt as promptRaised", () => {
    const { conn, sent } = fakeConn();
    const source = new SimulatedSource("alpha", "sim-1");
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    source.tick(); // running
    source.tick(); // awaiting-approval + prompt
    const raised = sent.find((m) => m.t === "promptRaised");
    expect(raised).toBeTruthy();
    if (raised?.t === "promptRaised") expect(raised.sessionId).toBe("sim-1");
  });

  it("applies an inbound decision to the source (approve → artifact forwarded)", () => {
    const { conn, sent, inbound } = fakeConn();
    const source = new SimulatedSource("alpha", "sim-1");
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    source.tick();
    source.tick();
    const raised = sent.find((m) => m.t === "promptRaised");
    const promptId = raised?.t === "promptRaised" ? raised.promptId : "";
    inbound({ t: "decision", promptId, approve: true });
    const artifact = sent.find((m) => m.t === "artifact");
    expect(artifact).toBeTruthy();
    if (artifact?.t === "artifact") expect(artifact.diff).toContain("+++ ");
    const last = sent.filter((m) => m.t === "sessions").at(-1);
    if (last?.t === "sessions") expect(last.sessions[0].status).toBe("done");
  });

  it("answers an inbound requestDetail with the source's getDetail events (T6)", async () => {
    const { conn, sent, inbound } = fakeConn();
    const events: SessionEvent[] = [
      { kind: "text", text: "hi" },
      { kind: "tool", text: "Bash" },
    ];
    const source = {
      onSessions() {},
      onPrompt() {},
      onArtifact() {},
      currentSessions: () => [],
      resolvePrompt() {},
      start() {},
      getDetail: async (id: string) => (id === "s1" ? events : []),
    } as unknown as SessionSource;
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    inbound({ t: "requestDetail", sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    const detail = sent.find((m) => m.t === "sessionDetail");
    expect(detail).toEqual({ t: "sessionDetail", sessionId: "s1", events });
  });

  it("a source WITHOUT getDetail replies with an empty tail (T6)", async () => {
    const { conn, sent, inbound } = fakeConn();
    const source = new SimulatedSource("alpha", "sim-1"); // no getDetail
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    inbound({ t: "requestDetail", sessionId: "sim-1" });
    await new Promise((r) => setTimeout(r, 10));
    const detail = sent.find((m) => m.t === "sessionDetail");
    expect(detail).toEqual({ t: "sessionDetail", sessionId: "sim-1", events: [] });
  });

  it("a getDetail that throws → empty events, node does not crash (T6)", async () => {
    const { conn, sent, inbound } = fakeConn();
    const source = {
      onSessions() {},
      onPrompt() {},
      onArtifact() {},
      currentSessions: () => [],
      resolvePrompt() {},
      start() {},
      getDetail: async () => {
        throw new Error("boom");
      },
    } as unknown as SessionSource;
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    inbound({ t: "requestDetail", sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    const detail = sent.find((m) => m.t === "sessionDetail");
    expect(detail).toEqual({ t: "sessionDetail", sessionId: "s1", events: [] });
  });

  it("deny → session aborts, no artifact", () => {
    const { conn, sent, inbound } = fakeConn();
    const source = new SimulatedSource("alpha", "sim-1");
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    source.tick();
    source.tick();
    const raised = sent.find((m) => m.t === "promptRaised");
    const promptId = raised?.t === "promptRaised" ? raised.promptId : "";
    inbound({ t: "decision", promptId, approve: false });
    expect(sent.find((m) => m.t === "artifact")).toBeUndefined();
    const last = sent.filter((m) => m.t === "sessions").at(-1);
    if (last?.t === "sessions") expect(last.sessions[0].status).toBe("aborted");
  });
});

describe("FleetNode — external prompt resolution (review HIGH fix)", () => {
  it("forwards source.onPromptResolved as a promptResolved frame", () => {
    const { conn, sent } = fakeConn();
    // Minimal source exposing the optional onPromptResolved seam.
    let fire: ((promptId: string, approve: boolean) => void) | undefined;
    const source = {
      onSessions() {}, onPrompt() {}, onArtifact() {},
      onPromptResolved(cb: (p: string, a: boolean) => void) { fire = cb; },
      currentSessions() { return []; },
      resolvePrompt() {}, start() {},
    };
    new FleetNode({ machineId: "alpha", token: "secret", conn, source }).start();
    fire!("tok-9", false);
    const pr = sent.find((m) => m.t === "promptResolved");
    expect(pr).toEqual({ t: "promptResolved", promptId: "tok-9", approve: false });
  });
});
