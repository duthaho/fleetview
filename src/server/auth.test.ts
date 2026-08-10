import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { AUTH_FAIL_CODE, AUTH_FAIL_REASON, verifyHello, attachAuth } from "./auth.js";
import { encode } from "../protocol.js";

describe("verifyHello (pure)", () => {
  it("accepts a node hello whose token matches the expected token", () => {
    expect(verifyHello({ t: "hello", role: "node", machineId: "m", token: "secret" }, "secret")).toBe(true);
  });
  it("rejects a wrong token", () => {
    expect(verifyHello({ t: "hello", role: "node", machineId: "m", token: "nope" }, "secret")).toBe(false);
  });
  it("rejects a non-hello message", () => {
    expect(verifyHello({ t: "sessions", sessions: [] }, "secret")).toBe(false);
  });
});

// A real in-process ws server+client makes the close-code assertion cleanest.
describe("attachAuth over a real ws pair", () => {
  let wss: WebSocketServer;
  let port: number;
  const registered: string[] = [];

  beforeEach(async () => {
    registered.length = 0;
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once("listening", r));
    port = (wss.address() as { port: number }).port;
    wss.on("connection", (sock) => {
      attachAuth(sock, "secret", (machineId) => {
        registered.push(machineId);
      });
    });
  });

  afterEach(async () => {
    await new Promise((r) => wss.close(r));
  });

  function connectAndHello(hello: unknown) {
    return new Promise<{ code: number; reason: string; registered: boolean }>((resolve) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      let closed = false;
      client.on("open", () => client.send(encode(hello as never)));
      client.on("close", (code, reasonBuf) => {
        closed = true;
        resolve({ code, reason: reasonBuf.toString(), registered: false });
      });
      // If not closed within a beat, treat as registered/accepted.
      setTimeout(() => {
        if (!closed) {
          client.close();
          resolve({ code: 1000, reason: "", registered: true });
        }
      }, 200);
    });
  }

  it("registers a connection with the correct token", async () => {
    const res = await connectAndHello({ t: "hello", role: "node", machineId: "alpha", token: "secret" });
    expect(res.registered).toBe(true);
    expect(registered).toEqual(["alpha"]);
  });

  it("closes with the exact auth-fail code + reason on a wrong token, never registering", async () => {
    const res = await connectAndHello({ t: "hello", role: "node", machineId: "alpha", token: "WRONG" });
    expect(res.code).toBe(AUTH_FAIL_CODE);
    expect(res.reason).toBe(AUTH_FAIL_REASON);
    expect(registered).toEqual([]);
  });

  it("closes with the auth-fail code when the token is absent, never registering", async () => {
    const res = await connectAndHello({ t: "hello", role: "node", machineId: "alpha" });
    expect(res.code).toBe(AUTH_FAIL_CODE);
    expect(res.reason).toBe(AUTH_FAIL_REASON);
    expect(registered).toEqual([]);
  });
});

describe("auth hardening (security review)", () => {
  it("uses constant-time comparison but still matches/ rejects correctly", () => {
    // functional guarantee unchanged by timing-safe compare
    expect(verifyHello({ t: "hello", role: "node", machineId: "m", token: "secret" }, "secret")).toBe(true);
    expect(verifyHello({ t: "hello", role: "node", machineId: "m", token: "secreu" }, "secret")).toBe(false);
    // different lengths must not throw (timingSafeEqual requires equal length)
    expect(verifyHello({ t: "hello", role: "node", machineId: "m", token: "s" }, "secret")).toBe(false);
  });

  it("fail-closed: an empty expected token rejects everything, including empty-token nodes", () => {
    expect(verifyHello({ t: "hello", role: "node", machineId: "m", token: "" }, "")).toBe(false);
    expect(verifyHello({ t: "hello", role: "browser" }, "")).toBe(false);
  });

  it("requireToken throws when FLEETVIEW_TOKEN is unset/empty (fail-closed config)", async () => {
    const { requireToken } = await import("./auth.js");
    expect(() => requireToken(undefined)).toThrow(/FLEETVIEW_TOKEN/);
    expect(() => requireToken("")).toThrow(/FLEETVIEW_TOKEN/);
    expect(requireToken("secret")).toBe("secret");
  });
});
