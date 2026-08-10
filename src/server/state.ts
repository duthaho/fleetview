// FleetState — the server's in-memory aggregate of the whole fleet (D1, D7, A3).
// PURE: no WebSocket, no I/O. The hub (T8) folds wire messages into this and
// reads snapshots/patches out of it. Server restart drops everything; nodes
// re-announce on reconnect, which replaces that machine's sessions cleanly.
import type { MachineView, PendingPrompt, Session } from "../protocol.js";

export class FleetState {
  private sessionsByMachine = new Map<string, Session[]>();
  private prompts = new Map<string, PendingPrompt>();
  private artifacts = new Map<string, string>();

  /** Replace a machine's session set wholesale (re-announce semantics, AC6). */
  upsertSessions(machineId: string, sessions: Session[]): void {
    this.sessionsByMachine.set(machineId, [...sessions]);
  }

  /** Remove a machine entirely: its sessions and any pending prompts. */
  dropMachine(machineId: string): void {
    this.sessionsByMachine.delete(machineId);
    for (const [id, p] of this.prompts) {
      if (p.machineId === machineId) this.prompts.delete(id);
    }
  }

  /** All machines with their sessions, grouped. */
  listMachines(): MachineView[] {
    return [...this.sessionsByMachine.entries()].map(([machineId, sessions]) => ({
      machineId,
      sessions: [...sessions],
    }));
  }

  addPrompt(prompt: PendingPrompt): void {
    this.prompts.set(prompt.promptId, prompt);
  }

  resolvePrompt(promptId: string): void {
    this.prompts.delete(promptId);
  }

  listPrompts(): PendingPrompt[] {
    return [...this.prompts.values()];
  }

  /** Which machine owns a pending prompt — the hub uses this to route decisions. */
  machineForPrompt(promptId: string): string | undefined {
    return this.prompts.get(promptId)?.machineId;
  }

  setArtifact(sessionId: string, diff: string): void {
    this.artifacts.set(sessionId, diff);
  }

  artifactFor(sessionId: string): string | undefined {
    return this.artifacts.get(sessionId);
  }
}
