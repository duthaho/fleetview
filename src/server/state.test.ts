import { describe, it, expect } from "vitest";
import { FleetState } from "./state.js";
import type { Session } from "../protocol.js";

function sess(id: string, machineId: string, status: Session["status"] = "running"): Session {
  return { id, machineId, cwd: "/tmp", model: "opus", status };
}

describe("FleetState", () => {
  it("aggregates two machines' sessions grouped by machine", () => {
    const s = new FleetState();
    s.upsertSessions("alpha", [sess("a1", "alpha"), sess("a2", "alpha")]);
    s.upsertSessions("beta", [sess("b1", "beta")]);
    const machines = s.listMachines();
    expect(machines.map((m) => m.machineId).sort()).toEqual(["alpha", "beta"]);
    const alpha = machines.find((m) => m.machineId === "alpha")!;
    expect(alpha.sessions.map((x) => x.id).sort()).toEqual(["a1", "a2"]);
  });

  it("drops only the disconnected machine's sessions", () => {
    const s = new FleetState();
    s.upsertSessions("alpha", [sess("a1", "alpha")]);
    s.upsertSessions("beta", [sess("b1", "beta")]);
    s.dropMachine("alpha");
    expect(s.listMachines().map((m) => m.machineId)).toEqual(["beta"]);
  });

  it("replaces a machine's sessions cleanly on reconnect re-announce (AC6)", () => {
    const s = new FleetState();
    s.upsertSessions("alpha", [sess("a1", "alpha", "running"), sess("a2", "alpha", "running")]);
    // Reconnect: node re-announces a different, smaller session set.
    s.upsertSessions("alpha", [sess("a3", "alpha", "starting")]);
    const alpha = s.listMachines().find((m) => m.machineId === "alpha")!;
    expect(alpha.sessions.map((x) => x.id)).toEqual(["a3"]);
  });

  it("tracks pending prompts and resolves them (for T8/T10)", () => {
    const s = new FleetState();
    s.upsertSessions("alpha", [sess("a1", "alpha", "awaiting-approval")]);
    s.addPrompt({ promptId: "p1", sessionId: "a1", machineId: "alpha", tool: "bash", detail: "rm -rf" });
    expect(s.listPrompts().map((p) => p.promptId)).toEqual(["p1"]);
    expect(s.machineForPrompt("p1")).toBe("alpha");
    s.resolvePrompt("p1");
    expect(s.listPrompts()).toEqual([]);
    expect(s.machineForPrompt("p1")).toBeUndefined();
  });

  it("drops a machine's pending prompts when it disconnects", () => {
    const s = new FleetState();
    s.upsertSessions("alpha", [sess("a1", "alpha", "awaiting-approval")]);
    s.addPrompt({ promptId: "p1", sessionId: "a1", machineId: "alpha", tool: "bash", detail: "x" });
    s.dropMachine("alpha");
    expect(s.listPrompts()).toEqual([]);
  });

  it("machineForSession returns the owning machine, undefined for an unknown id (T5)", () => {
    const s = new FleetState();
    s.upsertSessions("alpha", [sess("a1", "alpha"), sess("a2", "alpha")]);
    s.upsertSessions("beta", [sess("b1", "beta")]);
    expect(s.machineForSession("a2")).toBe("alpha");
    expect(s.machineForSession("b1")).toBe("beta");
    expect(s.machineForSession("ghost")).toBeUndefined();
  });

  it("tracks the latest artifact per session (for T8/T11)", () => {
    const s = new FleetState();
    s.upsertSessions("alpha", [sess("a1", "alpha")]);
    s.setArtifact("a1", "--- a\n+++ b\n");
    expect(s.artifactFor("a1")).toBe("--- a\n+++ b\n");
    s.setArtifact("a1", "newer");
    expect(s.artifactFor("a1")).toBe("newer");
  });
});
