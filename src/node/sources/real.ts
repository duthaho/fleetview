// Real SessionSource (D2, A5) — a best-effort, read-only reader of local Claude
// Code session transcripts under ~/.claude/projects/<slug>/<session-id>.jsonl.
// It exposes id + cwd + model + a heuristic status. It never gates prompts and
// never crashes on odd/missing/malformed layouts — it degrades to "no sessions".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, SessionEvent, SessionStatus } from "../../protocol.js";
import type { SessionSource, SourceArtifact, SourcePrompt } from "../source.js";

// A transcript touched within this window is treated as a live session.
const RUNNING_WITHIN_MS = 5 * 60_000;

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface ReadOptions {
  now?: number;
  /** Only include sessions touched within this window (ms). Omit = no filter. */
  activeWithinMs?: number;
  /** Keep at most this many, most-recently-touched first. Omit = no cap. */
  limit?: number;
}

/**
 * Pure reader: scan a `.claude` base dir into Sessions, newest-touched first.
 * Never throws. With no options it's a faithful full read; `activeWithinMs` /
 * `limit` turn a months-deep transcript archive into a live-fleet view.
 */
export function readClaudeSessions(baseDir: string, machineId: string, opts: ReadOptions = {}): Session[] {
  const now = opts.now ?? Date.now();
  const projectsDir = join(baseDir, "projects");
  const found: { session: Session; mtimeMs: number }[] = [];
  for (const slug of safeReaddir(projectsDir)) {
    const projDir = join(projectsDir, slug);
    let entries: string[];
    try {
      if (!statSync(projDir).isDirectory()) continue; // stray file where a dir was expected
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const one = readOneSession(join(projDir, file), file, machineId, now);
      if (!one) continue;
      if (opts.activeWithinMs !== undefined) {
        const age = now - one.mtimeMs;
        if (age < -60_000 || age > opts.activeWithinMs) continue; // outside the window
      }
      found.push(one);
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const capped = opts.limit !== undefined ? found.slice(0, opts.limit) : found;
  return capped.map((f) => f.session);
}

function readOneSession(
  path: string,
  file: string,
  machineId: string,
  now: number,
): { session: Session; mtimeMs: number } | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(path, "utf8");
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  let id = file.replace(/\.jsonl$/, "");
  let cwd = "";
  let model = "";
  // Activity summary (D1/D8): accumulated in the single pass we already make.
  let lastActivity = "";
  let lastTool = "";
  let messages = 0;
  let tokens = 0;
  let costUsd = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // skip malformed/truncated lines, keep reading
    }
    if (typeof rec.sessionId === "string" && rec.sessionId) id = rec.sessionId;
    if (typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
    if (typeof rec.timestamp === "string" && rec.timestamp > lastActivity) lastActivity = rec.timestamp;
    if (rec.type === "user" || rec.type === "assistant") messages++;
    for (const name of toolNames(rec)) lastTool = name; // last one wins (most recent)
    tokens += usageTokens(rec);
    costUsd += costOf(rec);
    const msg = rec.message;
    if (msg && typeof msg === "object" && typeof (msg as { model?: unknown }).model === "string") {
      model = (msg as { model: string }).model;
    }
  }
  // Running only if touched within the window AND not implausibly future-dated
  // (clock skew beyond a minute → treat as done, never "running forever").
  const age = now - mtimeMs;
  const status: SessionStatus = age >= -60_000 && age <= RUNNING_WITHIN_MS ? "running" : "done";
  return {
    session: { id, machineId, cwd, model, status, lastActivity, lastTool, messages, tokens, costUsd },
    mtimeMs,
  };
}

// --- transcript field extractors (best-effort, never throw) ---

/** Tool-use names in record order (assistant content blocks). */
function toolNames(rec: Record<string, unknown>): string[] {
  const msg = rec.message;
  if (!msg || typeof msg !== "object") return [];
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; name?: unknown };
      if (b.type === "tool_use" && typeof b.name === "string") names.push(b.name);
    }
  }
  return names;
}

/** Summed input+output usage tokens for a record (0 if absent). */
function usageTokens(rec: Record<string, unknown>): number {
  const msg = rec.message;
  if (!msg || typeof msg !== "object") return 0;
  const usage = (msg as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as { input_tokens?: unknown; output_tokens?: unknown };
  const inTok = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outTok = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return inTok + outTok;
}

/** Any per-record cost field (costUSD / total_cost_usd), best-effort, else 0. */
function costOf(rec: Record<string, unknown>): number {
  const c = rec.costUSD ?? rec.total_cost_usd;
  return typeof c === "number" ? c : 0;
}

// Detail tail bounds (D3): the last 10 events, text snippets capped at 120 chars.
const DETAIL_MAX_EVENTS = 10;
const SNIPPET_MAX = 120;
/** A session id that is safe to use as a bare file name (no path traversal). */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Text/tool events, in record order, from one assistant record's content. */
function eventsOf(rec: Record<string, unknown>): SessionEvent[] {
  const msg = rec.message;
  if (!msg || typeof msg !== "object") return [];
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: SessionEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown; name?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ kind: "text", text: b.text.slice(0, SNIPPET_MAX) });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      out.push({ kind: "tool", text: b.name });
    }
  }
  return out;
}

/**
 * On-demand detail tail (D3/D8): the last ≤10 text/tool events of ONE session's
 * transcript, oldest→newest. Never throws. A path-like id is rejected up front
 * with NO filesystem access, and reads stay confined to `baseDir/projects`.
 */
export function getSessionDetail(baseDir: string, sessionId: string): SessionEvent[] {
  // Traversal guard (codex): reject anything that isn't a bare id — before any I/O.
  if (!SAFE_ID.test(sessionId)) return [];
  const projectsDir = join(baseDir, "projects");
  const named = `${sessionId}.jsonl`;
  for (const slug of safeReaddir(projectsDir)) {
    const projDir = join(projectsDir, slug);
    let entries: string[];
    try {
      if (!statSync(projDir).isDirectory()) continue;
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    // Prefer the <id>.jsonl file, then fall back to scanning for the id inside.
    const ordered = entries.includes(named) ? [named, ...entries.filter((e) => e !== named)] : entries;
    for (const file of ordered) {
      if (!file.endsWith(".jsonl")) continue;
      const events = detailFromFile(join(projDir, file), file, sessionId);
      if (events) return events;
    }
  }
  return [];
}

/** Read one transcript's tail if it belongs to `sessionId`, else null. */
function detailFromFile(path: string, file: string, sessionId: string): SessionEvent[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const nameMatches = file === `${sessionId}.jsonl`;
  let belongs = nameMatches;
  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // skip malformed/truncated lines
    }
    if (typeof rec.sessionId === "string" && rec.sessionId === sessionId) belongs = true;
    else if (typeof rec.sessionId === "string" && rec.sessionId && !nameMatches) return null; // a different session's file
    events.push(...eventsOf(rec));
  }
  if (!belongs) return null;
  return events.slice(-DETAIL_MAX_EVENTS);
}

// A fleet console shows the live/recent fleet, not a months-deep archive:
// the real source defaults to sessions touched in the last day, capped.
export const DEFAULT_ACTIVE_WITHIN_MS = 24 * 3600_000;
export const DEFAULT_LIMIT = 50;

/** SessionSource wrapper: polls the reader; read-only, so it raises no prompts. */
export class RealSource implements SessionSource {
  private sessionsCb: ((s: Session[]) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly machineId: string,
    private readonly baseDir: string = join(homedir(), ".claude"),
    private readonly pollMs = 3000,
    private readonly activeWithinMs = DEFAULT_ACTIVE_WITHIN_MS,
    private readonly limit = DEFAULT_LIMIT,
  ) {}

  onSessions(cb: (sessions: Session[]) => void): void {
    this.sessionsCb = cb;
  }
  onPrompt(_cb: (p: SourcePrompt) => void): void {
    /* real reader is read-only in v1 (A1): no prompts */
  }
  onArtifact(_cb: (a: SourceArtifact) => void): void {
    /* no artifacts from the real reader in v1 */
  }
  currentSessions(): Session[] {
    return readClaudeSessions(this.baseDir, this.machineId, {
      activeWithinMs: this.activeWithinMs,
      limit: this.limit,
    });
  }
  resolvePrompt(_promptId: string, _approve: boolean): void {
    /* nothing to resolve — read-only */
  }
  start(): void {
    const emit = () => this.sessionsCb?.(this.currentSessions());
    emit();
    if (!this.timer) this.timer = setInterval(emit, this.pollMs).unref?.() ?? null;
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
