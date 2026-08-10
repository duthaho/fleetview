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

/** Pure reader: scan a `.claude` base dir into Sessions. Never throws. */
export function readClaudeSessions(baseDir: string, machineId: string, now = Date.now()): Session[] {
  const projectsDir = join(baseDir, "projects");
  const out: Session[] = [];
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
      const path = join(projDir, file);
      const session = readOneSession(path, file, machineId, now);
      if (session) out.push(session);
    }
  }
  return out;
}

function readOneSession(
  path: string,
  file: string,
  machineId: string,
  now: number,
): Session | null {
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
  const status: SessionStatus = now - mtimeMs <= RUNNING_WITHIN_MS ? "running" : "done";
  return { id, machineId, cwd, model, status };
}

/** SessionSource wrapper: polls the reader; read-only, so it raises no prompts. */
export class RealSource implements SessionSource {
  private sessionsCb: ((s: Session[]) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly machineId: string,
    private readonly baseDir: string = join(homedir(), ".claude"),
    private readonly pollMs = 3000,
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
    return readClaudeSessions(this.baseDir, this.machineId);
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
