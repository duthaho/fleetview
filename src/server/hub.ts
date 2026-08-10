// Hub — the fleet server's WebSocket core (D1, D3). Post-auth it registers each
// connection by role: node messages fold into a shared FleetState and fan out to
// browsers as snapshot-then-patches; browsers get the current snapshot on connect
// and live patches thereafter. A node disconnect drops only that machine and
// patches browsers. Decisions from a browser route back to the owning node.
import { WebSocketServer, type WebSocket } from "ws";
import { attachAuth } from "./auth.js";
import { FleetState } from "./state.js";
import {
  encode,
  parseMessage,
  type PatchOp,
  type PendingPrompt,
  type ServerToBrowser,
} from "../protocol.js";

export interface HubOptions {
  token: string;
}

export class Hub {
  private wss: WebSocketServer | null = null;
  private readonly state = new FleetState();
  private readonly browsers = new Set<WebSocket>();
  private readonly nodesByMachine = new Map<string, WebSocket>();

  constructor(private readonly opts: HubOptions) {}

  /** Start listening; resolves with the bound port. */
  listen(port: number): Promise<number> {
    this.wss = new WebSocketServer({ port });
    const wss = this.wss;
    wss.on("connection", (sock) => {
      attachAuth(sock, this.opts.token, (machineId, role) => {
        if (role === "node") this.registerNode(sock, machineId);
        else this.registerBrowser(sock);
      });
    });
    return new Promise((resolve) => wss.once("listening", () => resolve((wss.address() as { port: number }).port)));
  }

  close(): Promise<void> {
    for (const b of this.browsers) b.close();
    for (const n of this.nodesByMachine.values()) n.close();
    return new Promise((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  private registerNode(sock: WebSocket, machineId: string): void {
    // A reconnect for the same machineId replaces the previous conn cleanly.
    this.nodesByMachine.set(machineId, sock);
    sock.on("message", (data: unknown) => this.onNodeMessage(machineId, String(data)));
    sock.on("close", () => {
      // Only drop if this is still the registered conn (guards stale reconnects).
      if (this.nodesByMachine.get(machineId) === sock) {
        this.nodesByMachine.delete(machineId);
        this.state.dropMachine(machineId);
        this.broadcast([this.machinesOp(), this.promptsOp()]);
      }
    });
  }

  private registerBrowser(sock: WebSocket): void {
    this.browsers.add(sock);
    const snapshot: ServerToBrowser = { t: "snapshot", machines: this.state.listMachines() };
    sock.send(encode(snapshot));
    // Also send current prompts as an initial patch so the inbox is populated.
    if (this.state.listPrompts().length) sock.send(encode({ t: "patch", ops: [this.promptsOp()] }));
    sock.on("message", (data: unknown) => this.onBrowserMessage(String(data)));
    sock.on("close", () => this.browsers.delete(sock));
  }

  private onNodeMessage(machineId: string, raw: string): void {
    const msg = parseMessage(raw);
    if (!msg) return;
    switch (msg.t) {
      case "sessions":
        this.state.upsertSessions(machineId, msg.sessions);
        this.broadcast([this.machinesOp()]);
        break;
      case "promptRaised": {
        const prompt: PendingPrompt = {
          promptId: msg.promptId,
          sessionId: msg.sessionId,
          machineId,
          tool: msg.tool,
          detail: msg.detail,
        };
        this.state.addPrompt(prompt);
        this.broadcast([this.promptsOp()]);
        break;
      }
      case "artifact":
        this.state.setArtifact(msg.sessionId, msg.diff);
        this.broadcast([{ op: "artifact", sessionId: msg.sessionId, diff: msg.diff }]);
        break;
      case "promptResolved":
        this.state.resolvePrompt(msg.promptId);
        this.broadcast([this.promptsOp()]);
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(raw: string): void {
    const msg = parseMessage(raw);
    if (msg?.t !== "decision") return;
    const machineId = this.state.machineForPrompt(msg.promptId);
    if (!machineId) return;
    const node = this.nodesByMachine.get(machineId);
    node?.send(encode({ t: "decision", promptId: msg.promptId, approve: msg.approve }));
    // The prompt is now decided; drop it from the inbox and tell browsers.
    this.state.resolvePrompt(msg.promptId);
    this.broadcast([this.promptsOp()]);
  }

  private machinesOp(): PatchOp {
    return { op: "machines", machines: this.state.listMachines() };
  }

  private promptsOp(): PatchOp {
    return { op: "prompts", prompts: this.state.listPrompts() };
  }

  private broadcast(ops: PatchOp[]): void {
    const frame = encode({ t: "patch", ops });
    for (const b of this.browsers) b.send(frame);
  }
}
