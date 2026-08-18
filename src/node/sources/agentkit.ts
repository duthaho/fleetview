// AgentkitSource (D4, A1) — a SessionSource that bridges agentkit's escalation
// flow into fleetview. It connects to agentkit's local Unix-domain-socket
// escalation bridge (NDJSON framing) and turns each pending escalation into an
// awaiting-approval Session + a SourcePrompt; a fleetview decision is relayed
// back as a `decide` frame. Escalation-driven only: sessions appear because they
// raised a prompt (the full live list stays on `--source real`). Read-gating, so
// it raises no artifacts.
//
// Wire protocol (agentkit side):
//   agentkit → client: {t:"escalation", token, toolName, input, cwd, sessionId}
//                      {t:"resolved", token, allow, stale?}
//   client → agentkit: {t:"decide", token, allow}
// On connect the bridge replays currently-pending escalations.
import { connect as netConnect, type Socket } from "node:net";
import type { Session } from "../../protocol.js";
import type { SessionSource, SourceArtifact, SourcePrompt } from "../source.js";

const DETAIL_MAX = 500;

/** Injectable factory so tests can stand up an in-process socket. */
export type ConnectFn = (path: string) => Socket;

export interface AgentkitSourceOptions {
  /** Backoff between reconnect attempts (ms). Short/injectable for tests. */
  backoffMs?: number;
  /** Socket-connect factory (defaults to node `net.connect`). */
  connectFn?: ConnectFn;
}

/** One tracked, currently-pending escalation. */
interface Tracked {
  token: string;
  sessionId: string;
  cwd: string;
  tool: string;
}

/** Bound preview of a tool input — the Bash command or a short JSON blob. */
function previewInput(input: unknown): string {
  let s: string;
  if (typeof input === "string") {
    s = input;
  } else if (input && typeof input === "object") {
    const cmd = (input as { command?: unknown }).command;
    if (typeof cmd === "string") s = cmd;
    else {
      try {
        s = JSON.stringify(input);
      } catch {
        s = String(input);
      }
    }
  } else {
    s = String(input ?? "");
  }
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}…` : s;
}

export class AgentkitSource implements SessionSource {
  private readonly backoffMs: number;
  private readonly connectFn: ConnectFn;
  private sessionsCbs: ((sessions: Session[]) => void)[] = [];
  private promptCbs: ((p: SourcePrompt) => void)[] = [];
  private promptResolvedCbs: ((promptId: string, approve: boolean) => void)[] = [];
  private tracked = new Map<string, Tracked>();
  private sock: Socket | null = null;
  private buf = "";
  private started = false;
  private stopped = false;

  constructor(
    private readonly machineId: string,
    private readonly socketPath: string,
    opts: AgentkitSourceOptions = {},
  ) {
    this.backoffMs = opts.backoffMs ?? 500;
    this.connectFn = opts.connectFn ?? ((p) => netConnect(p));
  }

  onSessions(cb: (sessions: Session[]) => void): void {
    this.sessionsCbs.push(cb);
  }
  onPrompt(cb: (p: SourcePrompt) => void): void {
    this.promptCbs.push(cb);
  }
  onArtifact(_cb: (a: SourceArtifact) => void): void {
    /* read-gating source raises no artifacts (D4) */
  }
  onPromptResolved(cb: (promptId: string, approve: boolean) => void): void {
    this.promptResolvedCbs.push(cb);
  }

  currentSessions(): Session[] {
    return [...this.tracked.values()].map((t) => this.toSession(t));
  }

  resolvePrompt(promptId: string, approve: boolean): void {
    // Send even if the escalation is untracked here: the bridge replies with a
    // stale `resolved` and the token is a no-op agentkit-side either way.
    this.write({ t: "decide", token: promptId, allow: approve });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /** Tear down the socket and stop reconnecting (idempotent). */
  stop(): void {
    this.stopped = true;
    if (this.sock) {
      this.sock.removeAllListeners();
      this.sock.destroy();
      this.sock = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.buf = "";
    const sock = this.connectFn(this.socketPath);
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", () => {
      /* handled by 'close' → retry */
    });
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const t = setTimeout(() => this.connect(), this.backoffMs);
    t.unref?.();
  }

  private write(obj: unknown): void {
    if (!this.sock || this.sock.destroyed) return;
    try {
      this.sock.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* client disconnected mid-write; reconnect will catch up */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    // eslint-disable-next-line no-cond-assign
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim() === "") continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // tolerate malformed lines by skipping (D4)
    }
    if (typeof msg.t !== "string" || typeof msg.token !== "string") return;
    if (msg.t === "escalation") this.onEscalation(msg);
    else if (msg.t === "resolved") this.onResolved(msg.token, msg.allow === true);
  }

  private onEscalation(msg: Record<string, unknown>): void {
    const token = msg.token as string;
    const sessionId = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : token;
    const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
    const tool = typeof msg.toolName === "string" ? msg.toolName : "";
    this.tracked.set(token, { token, sessionId, cwd, tool });
    this.emitSessions();
    const prompt: SourcePrompt = {
      promptId: token,
      sessionId,
      tool,
      detail: previewInput(msg.input),
    };
    for (const cb of this.promptCbs) cb(prompt);
  }

  private onResolved(token: string, approve: boolean): void {
    const had = this.tracked.delete(token);
    // Always signal an external resolution so the node clears the inbox prompt,
    // even if we'd already dropped the session (idempotent on the hub side).
    for (const cb of this.promptResolvedCbs) cb(token, approve);
    if (had) this.emitSessions();
  }

  private toSession(t: Tracked): Session {
    return {
      id: t.sessionId,
      machineId: this.machineId,
      cwd: t.cwd,
      model: "",
      status: "awaiting-approval",
    };
  }

  private emitSessions(): void {
    const sessions = this.currentSessions();
    for (const cb of this.sessionsCbs) cb(sessions);
  }
}
