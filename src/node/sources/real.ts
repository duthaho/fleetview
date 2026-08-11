// Real SessionSource (D2, A5) — a best-effort, read-only reader of local Claude
// Code session transcripts under ~/.claude/projects/<slug>/<session-id>.jsonl.
// It exposes id + cwd + model + a heuristic status. It never gates prompts and
// never crashes on odd/missing/malformed layouts — it degrades to "no sessions".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, SessionStatus } from "../../protocol.js";
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
    const msg = rec.message;
    if (msg && typeof msg === "object" && typeof (msg as { model?: unknown }).model === "string") {
      model = (msg as { model: string }).model;
    }
  }
  // Running only if touched within the window AND not implausibly future-dated
  // (clock skew beyond a minute → treat as done, never "running forever").
  const age = now - mtimeMs;
  const status: SessionStatus = age >= -60_000 && age <= RUNNING_WITHIN_MS ? "running" : "done";
  return { session: { id, machineId, cwd, model, status }, mtimeMs };
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
