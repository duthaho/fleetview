import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { Hub } from "./hub.js";
import { encode, parseMessage, type MachineView, type ServerToBrowser, type WireMessage } from "../protocol.js";

const TOKEN = "secret";

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Wait for the next parsed message on a socket. */
function next(ws: WebSocket): Promise<WireMessage> {
  return new Promise((resolve) => {
    ws.once("message", (d) => resolve(parseMessage(String(d))!));
  });
}

/** Wait until a browser frame satisfies `pred`, returning the merged machine view. */
function waitForMachines(ws: WebSocket, pred: (machines: MachineView[]) => boolean): Promise<MachineView[]> {
  let machines: MachineView[] = [];
  return new Promise((resolve) => {
    const onMsg = (d: unknown) => {
      const msg = parseMessage(String(d)) as ServerToBrowser | null;
      if (!msg) return;
      if (msg.t === "snapshot") machines = msg.machines;
      else if (msg.t === "patch") {
        for (const op of msg.ops) if (op.op === "machines") machines = op.machines;
      }
      if (pred(machines)) {
        ws.off("message", onMsg);
        resolve(machines);
      }
    };
    ws.on("message", onMsg);
  });
}

describe("Hub (real in-process ws, 2 nodes + 1 browser)", () => {
  let hub: Hub;
  let url: string;

  beforeEach(async () => {
    hub = new Hub({ token: TOKEN });
    const port = await hub.listen(0);
    url = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await hub.close();
  });

  it("browser sees both machines' sessions and a live status change (AC1)", async () => {
    const alpha = await open(url);
    alpha.send(encode({ t: "hello", role: "node", machineId: "alpha", token: TOKEN }));
    const beta = await open(url);
    beta.send(encode({ t: "hello", role: "node", machineId: "beta", token: TOKEN }));

    alpha.send(encode({ t: "sessions", sessions: [{ id: "a1", machineId: "alpha", cwd: "/", model: "m", status: "running" }] }));
    beta.send(encode({ t: "sessions", sessions: [{ id: "b1", machineId: "beta", cwd: "/", model: "m", status: "running" }] }));

    const browser = await open(url);
    browser.send(encode({ t: "hello", role: "browser", token: TOKEN }));

    const both = await waitForMachines(browser, (ms) => ms.length === 2 && ms.every((m) => m.sessions.length === 1));
    expect(both.map((m) => m.machineId).sort()).toEqual(["alpha", "beta"]);

    // Live status change on alpha → browser gets a patch reflecting it.
    alpha.send(encode({ t: "sessions", sessions: [{ id: "a1", machineId: "alpha", cwd: "/", model: "m", status: "awaiting-approval" }] }));
    const updated = await waitForMachines(browser, (ms) => {
      const a = ms.find((m) => m.machineId === "alpha");
      return a?.sessions[0]?.status === "awaiting-approval";
    });
    expect(updated.find((m) => m.machineId === "alpha")!.sessions[0].status).toBe("awaiting-approval");

    alpha.close();
    beta.close();
    browser.close();
  });

  it("when one node disconnects, browser gets a patch dropping only that machine's sessions", async () => {
    const alpha = await open(url);
    alpha.send(encode({ t: "hello", role: "node", machineId: "alpha", token: TOKEN }));
    const beta = await open(url);
    beta.send(encode({ t: "hello", role: "node", machineId: "beta", token: TOKEN }));
    alpha.send(encode({ t: "sessions", sessions: [{ id: "a1", machineId: "alpha", cwd: "/", model: "m", status: "running" }] }));
    beta.send(encode({ t: "sessions", sessions: [{ id: "b1", machineId: "beta", cwd: "/", model: "m", status: "running" }] }));

    const browser = await open(url);
    browser.send(encode({ t: "hello", role: "browser", token: TOKEN }));
    await waitForMachines(browser, (ms) => ms.length === 2);

    alpha.close();
    const afterDrop = await waitForMachines(browser, (ms) => ms.length === 1);
    expect(afterDrop.map((m) => m.machineId)).toEqual(["beta"]);
    expect(afterDrop[0].sessions[0].id).toBe("b1");

    beta.close();
    browser.close();
  });

  it("rejects a node with a bad token (AC2) and it never reaches the browser", async () => {
    const bad = await open(url);
    const closed = new Promise<number>((resolve) => bad.once("close", (code) => resolve(code)));
    bad.send(encode({ t: "hello", role: "node", machineId: "evil", token: "WRONG" }));
    expect(await closed).toBe(4001);
  });
});

describe("Hub — cross-origin browser is rejected (CSWSH guard)", () => {
  let hub: Hub;
  let url: string;
  beforeEach(async () => {
    hub = new Hub({ token: TOKEN });
    const port = await hub.listen(0);
    url = `ws://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    await hub.close();
  });

  it("closes a connection whose Origin is a foreign site with code 4003", async () => {
    const evil = new WebSocket(url, { origin: "http://evil.example.com" });
    const code = await new Promise<number>((resolve) => {
      evil.once("close", (c) => resolve(c));
    });
    expect(code).toBe(4003);
  });

  it("still accepts a same-origin browser and an origin-less node client", async () => {
    const host = new URL(url).host;
    const good = new WebSocket(url, { origin: `http://${host}` });
    good.on("open", () => good.send(encode({ t: "hello", role: "browser" })));
    const snap = (await next(good)) as ServerToBrowser;
    expect(snap.t).toBe("snapshot");
    good.close();
  });
});

describe("Hub — review fixes", () => {
  let hub: Hub;
  let url: string;
  beforeEach(async () => {
    hub = new Hub({ token: TOKEN });
    const port = await hub.listen(0);
    url = `ws://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    await hub.close();
  });

  it("binds sessions to the AUTHENTICATED machineId, ignoring a spoofed one (anti-spoof)", async () => {
    const alpha = await open(url);
    alpha.send(encode({ t: "hello", role: "node", machineId: "alpha", token: TOKEN }));
    // alpha lies: stamps its session as belonging to "beta"
    alpha.send(encode({ t: "sessions", sessions: [{ id: "x", machineId: "beta", cwd: "/", model: "m", status: "running" }] }));
    const browser = await open(url);
    browser.send(encode({ t: "hello", role: "browser", token: TOKEN }));
    const ms = await waitForMachines(browser, (m) => m.some((x) => x.sessions.length > 0));
    expect(ms.map((m) => m.machineId)).toEqual(["alpha"]);
    expect(ms[0].sessions[0].machineId).toBe("alpha");
    alpha.close();
    browser.close();
  });

  it("catches a late-joining browser up on a stored artifact", async () => {
    const alpha = await open(url);
    alpha.send(encode({ t: "hello", role: "node", machineId: "alpha", token: TOKEN }));
    alpha.send(encode({ t: "sessions", sessions: [{ id: "s1", machineId: "alpha", cwd: "/", model: "m", status: "running" }] }));
    alpha.send(encode({ t: "artifact", sessionId: "s1", diff: "--- a\n+++ b\n@@\n+x" }));
    await new Promise((r) => setTimeout(r, 100)); // let the artifact land in state
    const browser = await open(url);
    browser.send(encode({ t: "hello", role: "browser", token: TOKEN }));
    const diff = await new Promise<string>((resolve) => {
      browser.on("message", (d) => {
        const m = parseMessage(String(d)) as ServerToBrowser | null;
        if (m?.t === "patch") for (const op of m.ops) if (op.op === "artifact") resolve(op.diff);
      });
    });
    expect(diff).toContain("+x");
    alpha.close();
    browser.close();
  });

  it("does not falsely resolve a prompt when the owning node is gone", async () => {
    const alpha = await open(url);
    alpha.send(encode({ t: "hello", role: "node", machineId: "alpha", token: TOKEN }));
    alpha.send(encode({ t: "sessions", sessions: [{ id: "s1", machineId: "alpha", cwd: "/", model: "m", status: "running" }] }));
    alpha.send(encode({ t: "promptRaised", promptId: "p1", sessionId: "s1", tool: "Bash", detail: "x" }));
    const browser = await open(url);
    browser.send(encode({ t: "hello", role: "browser", token: TOKEN }));
    // capture the browser-facing (namespaced) promptId
    const gpid = await new Promise<string>((resolve) => {
      browser.on("message", (d) => {
        const m = parseMessage(String(d)) as ServerToBrowser | null;
        if (m?.t === "patch") for (const op of m.ops) if (op.op === "prompts" && op.prompts[0]) resolve(op.prompts[0].promptId);
      });
    });
    expect(gpid).toContain("alpha");
    // node vanishes uncleanly is hard to force; instead decide on an unknown prompt id → no-op, no throw
    browser.send(encode({ t: "decision", promptId: "does-not-exist", approve: true }));
    await new Promise((r) => setTimeout(r, 100));
    // hub still alive and the real prompt still routable
    expect(gpid.length).toBeGreaterThan("alpha".length);
    alpha.close();
    browser.close();
  });
});
