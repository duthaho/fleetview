// FleetNode — the testable core of a fleet-node process (D1). It bridges a
// SessionSource to the server over a WebSocket-like connection: sends the node
// hello, forwards source updates (sessions / promptRaised / artifact), and
// applies inbound decisions to source.resolvePrompt. The ws connection and the
// source are injected so tests drive it with a fake conn + SimulatedSource.
import { encode, parseMessage, type NodeToServer } from "../protocol.js";
import type { SessionSource } from "./source.js";

/** Minimal WebSocket surface FleetNode needs — satisfied by `ws`'s WebSocket. */
export interface NodeConn {
  send(data: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "open", cb: () => void): void;
  on(event: "close", cb: () => void): void;
  on(event: string, cb: (data: unknown) => void): void;
}

export interface FleetNodeOptions {
  machineId: string;
  token: string;
  conn: NodeConn;
  source: SessionSource;
}

export class FleetNode {
  constructor(private readonly opts: FleetNodeOptions) {}

  start(): void {
    const { conn, source, machineId, token } = this.opts;

    source.onSessions((sessions) => this.send({ t: "sessions", sessions }));
    source.onPrompt((p) =>
      this.send({ t: "promptRaised", promptId: p.promptId, sessionId: p.sessionId, tool: p.tool, detail: p.detail }),
    );
    source.onArtifact((a) => this.send({ t: "artifact", sessionId: a.sessionId, diff: a.diff }));
    // External resolution (e.g. a Telegram tap on the agentkit bridge): clear the
    // prompt from the server inbox so it doesn't linger, clickable, after the fact.
    source.onPromptResolved?.((promptId, approve) =>
      this.send({ t: "promptResolved", promptId, approve }),
    );

    conn.on("message", (data) => {
      const msg = parseMessage(String(data));
      if (msg?.t === "decision") source.resolvePrompt(msg.promptId, msg.approve);
    });

    // Announce ourselves, then start the source (which emits the initial set).
    this.send({ t: "hello", role: "node", machineId, token });
    source.start();
  }

  private send(msg: NodeToServer): void {
    this.opts.conn.send(encode(msg));
  }
}
