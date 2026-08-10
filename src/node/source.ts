// SessionSource — the pluggable feed of local sessions a fleet-node forwards to
// the server (D2). Two v1 implementations: simulated (deterministic, drives the
// demo + tests) and real (best-effort reader of ~/.claude). The node (T7)
// subscribes to the callbacks and applies inbound decisions via resolvePrompt.
import type { PendingPrompt, Session } from "../protocol.js";

export interface SourcePrompt {
  promptId: string;
  sessionId: string;
  tool: string;
  detail: string;
}

export interface SourceArtifact {
  sessionId: string;
  diff: string;
}

export interface SessionSource {
  /** Notified whenever the session set changes; also called with the initial set. */
  onSessions(cb: (sessions: Session[]) => void): void;
  /** Notified when a session raises a permission prompt. */
  onPrompt(cb: (prompt: SourcePrompt) => void): void;
  /** Notified when a session produces an artifact (unified diff, v1). */
  onArtifact(cb: (artifact: SourceArtifact) => void): void;
  /** Current sessions right now (for the initial hello/announce). */
  currentSessions(): Session[];
  /** Apply a remote decision to a pending prompt. */
  resolvePrompt(promptId: string, approve: boolean): void;
  /** Begin producing sessions (idempotent; real sources start reading). */
  start(): void;
}

/** Shared shape the node uses when turning a SourcePrompt into wire state. */
export type { PendingPrompt };
