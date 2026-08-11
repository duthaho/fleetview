// FleetNode — the testable core of a fleet-node process (D1). It bridges a
// SessionSource to the server over a WebSocket-like connection: sends the node
// hello, forwards source updates (sessions / promptRaised / artifact), and
// applies inbound decisions to source.resolvePrompt. The ws connection and the
// source are injected so tests drive it with a fake conn + SimulatedSource.
import { encode, parseMessage, type NodeToServer, type SessionEvent } from "../protocol.js";
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

    conn.on("message", (data) => {
      const msg = parseMessage(String(data));
      if (msg?.t === "decision") source.resolvePrompt(msg.promptId, msg.approve);
      else if (msg?.t === "requestDetail") void this.answerDetail(msg.sessionId);
    });

    // Announce ourselves, then start the source (which emits the initial set).
    this.send({ t: "hello", role: "node", machineId, token });
    source.start();
  }

  // Answer a detail request (T6): the source's getDetail (absent ⇒ empty tail),
  // guarded so a source error yields an empty tail rather than crashing the node.
  private async answerDetail(sessionId: string): Promise<void> {
    let events: SessionEvent[];
    try {
      events = (await this.opts.source.getDetail?.(sessionId)) ?? [];
    } catch {
      events = [];
    }
    this.send({ t: "sessionDetail", sessionId, events });
  }

  private send(msg: NodeToServer): void {
    this.opts.conn.send(encode(msg));
  }
}
