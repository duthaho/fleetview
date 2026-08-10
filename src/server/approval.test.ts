// AC3 — the money feature: a REAL in-process ws chain
//   browser → server(Hub) → node(FleetNode) → SimulatedSource
// drives a full approval round-trip. The node announces a session; a sim tick
// raises a prompt that reaches the browser via patch; the browser sends a
// decision; approve → session done + diff artifact / deny → aborted, each
// reflected in the next patch back to the browser. No mocks in the middle.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { Hub } from "./hub.js";
import { FleetNode, type NodeConn } from "../node/node.js";
import { SimulatedSource } from "../node/sources/simulated.js";
import {
  encode,
  parseMessage,
  type MachineView,
  type PendingPrompt,
  type ServerToBrowser,
} from "../protocol.js";

const TOKEN = "secret";

function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

interface BrowserView {
  machines: MachineView[];
  prompts: PendingPrompt[];
  artifacts: Map<string, string>;
}

/**
 * A single, persistent browser-frame accumulator. Attaching one durable
 * listener (rather than a fresh one per wait) means no frame is ever missed in
 * the gap between one wait resolving and the next attaching — the sim's ticks
 * fire synchronously, so that race is real.
 */
class BrowserTap {
  readonly view: BrowserView = { machines: [], prompts: [], artifacts: new Map() };
  private waiters: { pred: (v: BrowserView) => boolean; resolve: (v: BrowserView) => void }[] = [];

  constructor(ws: WebSocket) {
    ws.on("message", (d: unknown) => {
      const msg = parseMessage(String(d)) as ServerToBrowser | null;
      if (!msg) return;
      if (msg.t === "snapshot") this.view.machines = msg.machines;
      else for (const op of msg.ops) {
        if (op.op === "machines") this.view.machines = op.machines;
        else if (op.op === "prompts") this.view.prompts = op.prompts;
        else if (op.op === "artifact") this.view.artifacts.set(op.sessionId, op.diff);
      }
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(this.view)) return true;
        w.resolve(this.view);
        return false;
      });
    });
  }

  waitFor(pred: (v: BrowserView) => boolean): Promise<BrowserView> {
    if (pred(this.view)) return Promise.resolve(this.view);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }
}

/** Spin up a real node against the hub url, wired to a SimulatedSource. */
async function startNode(url: string, machineId: string): Promise<{ source: SimulatedSource; ws: WebSocket }> {
  const ws = await open(url);
  const source = new SimulatedSource(machineId, `${machineId}-sim`);
  const node = new FleetNode({ machineId, token: TOKEN, conn: ws as unknown as NodeConn, source });
  node.start();
  return { source, ws };
}

function sessionStatus(machines: MachineView[], machineId: string): string | undefined {
  return machines.find((m) => m.machineId === machineId)?.sessions[0]?.status;
}

describe("approval round-trip (browser→hub→node→SimulatedSource, real ws)", () => {
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

  it("approve unblocks the session (status→done) and emits its diff artifact (AC3)", async () => {
    const { source } = await startNode(url, "alpha");
    const browser = await open(url);
    const tap = new BrowserTap(browser);
    browser.send(encode({ t: "hello", role: "browser", token: TOKEN }));

    // Session announced.
    await tap.waitFor((v) => sessionStatus(v.machines, "alpha") !== undefined);

    // Drive the sim: running → awaiting-approval + a raised prompt.
    source.tick(); // starting → running
    source.tick(); // running → awaiting-approval + prompt
    const raised = await tap.waitFor((v) => v.prompts.length === 1);
    const promptId = raised.prompts[0].promptId;
    expect(sessionStatus(raised.machines, "alpha")).toBe("awaiting-approval");

    // Browser approves → travels to the node → source unblocks.
    browser.send(encode({ t: "decision", promptId, approve: true }));

    const done = await tap.waitFor(
      (v) => sessionStatus(v.machines, "alpha") === "done" && v.artifacts.has("alpha-sim"),
    );
    expect(sessionStatus(done.machines, "alpha")).toBe("done");
    expect(done.artifacts.get("alpha-sim")).toContain("greeter.ts");
    // Prompt cleared from the inbox.
    const cleared = await tap.waitFor((v) => v.prompts.length === 0);
    expect(cleared.prompts).toEqual([]);

    browser.close();
  });

  it("deny aborts the session (status→aborted), no artifact", async () => {
    const { source } = await startNode(url, "beta");
    const browser = await open(url);
    const tap = new BrowserTap(browser);
    browser.send(encode({ t: "hello", role: "browser", token: TOKEN }));
    await tap.waitFor((v) => sessionStatus(v.machines, "beta") !== undefined);

    source.tick();
    source.tick();
    const raised = await tap.waitFor((v) => v.prompts.length === 1);
    const promptId = raised.prompts[0].promptId;

    browser.send(encode({ t: "decision", promptId, approve: false }));

    const aborted = await tap.waitFor((v) => sessionStatus(v.machines, "beta") === "aborted");
    expect(sessionStatus(aborted.machines, "beta")).toBe("aborted");
    expect(aborted.artifacts.has("beta-sim")).toBe(false);

    browser.close();
  });
});
