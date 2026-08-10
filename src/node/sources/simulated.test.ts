import { describe, it, expect } from "vitest";
import { SimulatedSource } from "./simulated.js";
import type { Session } from "../../protocol.js";

function drive(machineId: string) {
  const source = new SimulatedSource(machineId, "sim-1");
  const statuses: Session["status"][] = [];
  const prompts: { promptId: string; sessionId: string }[] = [];
  const artifacts: { sessionId: string; diff: string }[] = [];
  source.onSessions((sessions) => {
    const s = sessions.find((x) => x.id === "sim-1");
    if (s) statuses.push(s.status);
  });
  source.onPrompt((p) => prompts.push({ promptId: p.promptId, sessionId: p.sessionId }));
  source.onArtifact((a) => artifacts.push({ sessionId: a.sessionId, diff: a.diff }));
  return { source, statuses, prompts, artifacts };
}

describe("SimulatedSource scripted lifecycle (injected tick)", () => {
  it("start → running → awaiting-approval, raising a prompt", () => {
    const { source, statuses, prompts } = drive("alpha");
    source.start();
    source.tick(); // starting → running
    source.tick(); // running → awaiting-approval + prompt
    expect(statuses).toEqual(["starting", "running", "awaiting-approval"]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].sessionId).toBe("sim-1");
  });

  it("approve → emits a unified-diff artifact then done", () => {
    const { source, statuses, prompts, artifacts } = drive("alpha");
    source.start();
    source.tick();
    source.tick();
    source.resolvePrompt(prompts[0].promptId, true);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].diff).toContain("--- ");
    expect(artifacts[0].diff).toContain("+++ ");
    expect(statuses.at(-1)).toBe("done");
  });

  it("deny → aborted, no artifact", () => {
    const { source, statuses, prompts, artifacts } = drive("alpha");
    source.start();
    source.tick();
    source.tick();
    source.resolvePrompt(prompts[0].promptId, false);
    expect(artifacts).toHaveLength(0);
    expect(statuses.at(-1)).toBe("aborted");
  });

  it("is deterministic — no real timers, nothing happens without tick/resolve", () => {
    const { source, statuses } = drive("alpha");
    source.start();
    expect(statuses).toEqual(["starting"]);
  });

  it("ignores resolving before a prompt is raised", () => {
    const { source, artifacts, statuses } = drive("alpha");
    source.start();
    source.resolvePrompt("nope", true);
    expect(artifacts).toHaveLength(0);
    expect(statuses).toEqual(["starting"]);
  });

  it("exposes current sessions with the right machineId", () => {
    const source = new SimulatedSource("beta", "sim-9");
    source.start();
    const sessions = source.currentSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].machineId).toBe("beta");
    expect(sessions[0].id).toBe("sim-9");
  });
});
