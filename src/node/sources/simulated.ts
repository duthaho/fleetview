// SimulatedSource — a deterministic scripted session lifecycle (D2, D5, D6).
// Drives the demo and all tests. NO real timers: the lifecycle advances only on
// an injected `tick()` (starting → running → awaiting-approval) and on
// `resolvePrompt` (approve → diff artifact + done / deny → aborted). This keeps
// tests deterministic and lets the node (T7) pace it however it likes.
import type { Session, SessionStatus } from "../../protocol.js";
import type { SessionSource, SourceArtifact, SourcePrompt } from "../source.js";

const DEMO_DIFF = `--- a/greeter.ts
+++ b/greeter.ts
@@ -1,3 +1,3 @@
 export function greet(name: string) {
-  return "Hi " + name;
+  return \`Hello, \${name}!\`;
 }
`;

export class SimulatedSource implements SessionSource {
  private status: SessionStatus = "starting";
  private started = false;
  private promptId: string | null = null;
  private sessionsCbs: ((sessions: Session[]) => void)[] = [];
  private promptCbs: ((p: SourcePrompt) => void)[] = [];
  private artifactCbs: ((a: SourceArtifact) => void)[] = [];

  constructor(
    private readonly machineId: string,
    private readonly sessionId: string,
  ) {}

  onSessions(cb: (sessions: Session[]) => void): void {
    this.sessionsCbs.push(cb);
  }
  onPrompt(cb: (p: SourcePrompt) => void): void {
    this.promptCbs.push(cb);
  }
  onArtifact(cb: (a: SourceArtifact) => void): void {
    this.artifactCbs.push(cb);
  }

  currentSessions(): Session[] {
    return [
      {
        id: this.sessionId,
        machineId: this.machineId,
        cwd: "/repo/fleetview",
        model: "claude-opus-4-8",
        status: this.status,
      },
    ];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.status = "starting";
    this.emitSessions();
  }

  /** Advance one step in the scripted lifecycle. */
  tick(): void {
    if (this.status === "starting") {
      this.status = "running";
      this.emitSessions();
    } else if (this.status === "running") {
      this.status = "awaiting-approval";
      this.promptId = `${this.sessionId}-p1`;
      this.emitSessions();
      const prompt: SourcePrompt = {
        promptId: this.promptId,
        sessionId: this.sessionId,
        tool: "bash",
        detail: "apply patch to greeter.ts",
      };
      for (const cb of this.promptCbs) cb(prompt);
    }
  }

  resolvePrompt(promptId: string, approve: boolean): void {
    if (this.promptId === null || promptId !== this.promptId) return;
    this.promptId = null;
    if (approve) {
      for (const cb of this.artifactCbs) cb({ sessionId: this.sessionId, diff: DEMO_DIFF });
      this.status = "done";
    } else {
      this.status = "aborted";
    }
    this.emitSessions();
  }

  private emitSessions(): void {
    const sessions = this.currentSessions();
    for (const cb of this.sessionsCbs) cb(sessions);
  }
}
