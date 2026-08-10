// The full fleetview wire protocol — every direction, both connection roles.
// One WebSocket endpoint; the `hello.role` field routes node vs browser.

export type SessionStatus = "starting" | "running" | "awaiting-approval" | "done" | "aborted";

export interface Session {
  id: string;
  machineId: string;
  cwd: string;
  model: string;
  status: SessionStatus;
}

export interface PendingPrompt {
  promptId: string;
  sessionId: string;
  machineId: string;
  tool: string;
  detail: string;
}

// --- node → server ---
export type NodeToServer =
  | { t: "hello"; role: "node"; machineId: string; token: string }
  | { t: "sessions"; sessions: Session[] }
  | { t: "promptRaised"; promptId: string; sessionId: string; tool: string; detail: string }
  | { t: "artifact"; sessionId: string; diff: string }
  | { t: "promptResolved"; promptId: string; approve: boolean };

// --- browser → server ---
export type BrowserToServer =
  | { t: "hello"; role: "browser"; token?: string }
  | { t: "decision"; promptId: string; approve: boolean };

// --- server → node ---
export type ServerToNode = { t: "decision"; promptId: string; approve: boolean };

// --- server → browser ---
export interface MachineView {
  machineId: string;
  sessions: Session[];
}
export type PatchOp =
  | { op: "machines"; machines: MachineView[] }
  | { op: "prompts"; prompts: PendingPrompt[] }
  | { op: "artifact"; sessionId: string; diff: string };
export type ServerToBrowser =
  | { t: "snapshot"; machines: MachineView[] }
  | { t: "patch"; ops: PatchOp[] };

export type WireMessage = NodeToServer | BrowserToServer | ServerToNode | ServerToBrowser;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isSession(v: unknown): v is Session {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    isStr(s.id) &&
    isStr(s.machineId) &&
    isStr(s.cwd) &&
    isStr(s.model) &&
    ["starting", "running", "awaiting-approval", "done", "aborted"].includes(s.status as string)
  );
}

/** Parse a wire message. Returns the typed object, or null if malformed. */
export function parseMessage(raw: string): WireMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  switch (m.t) {
    case "hello":
      if (m.role === "node") return isStr(m.machineId) && isStr(m.token) ? (m as WireMessage) : null;
      if (m.role === "browser") return m.token === undefined || isStr(m.token) ? (m as WireMessage) : null;
      return null;
    case "sessions":
      return Array.isArray(m.sessions) && m.sessions.every(isSession) ? (m as WireMessage) : null;
    case "promptRaised":
      return isStr(m.promptId) && isStr(m.sessionId) && isStr(m.tool) && isStr(m.detail)
        ? (m as WireMessage)
        : null;
    case "artifact":
      return isStr(m.sessionId) && isStr(m.diff) ? (m as WireMessage) : null;
    case "promptResolved":
    case "decision":
      return isStr(m.promptId) && isBool(m.approve) ? (m as WireMessage) : null;
    case "snapshot":
      return Array.isArray(m.machines) ? (m as WireMessage) : null;
    case "patch":
      return Array.isArray(m.ops) ? (m as WireMessage) : null;
    default:
      return null;
  }
}

export function encode(msg: WireMessage): string {
  return JSON.stringify(msg);
}
