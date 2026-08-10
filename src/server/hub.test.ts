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
