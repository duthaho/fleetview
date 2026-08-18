import { describe, expect, it } from "vitest";
import { parseArgs } from "./main.js";

describe("parseArgs", () => {
  it("defaults to the simulated source and machine 'local'", () => {
    const a = parseArgs([]);
    expect(a.sourceKind).toBe("simulated");
    expect(a.machineId).toBe("local");
    expect(a.bridgePath).toBeUndefined();
  });

  it("parses --source agentkit --bridge <path>", () => {
    const a = parseArgs(["--machine", "this-box", "--source", "agentkit", "--bridge", "/tmp/x.sock"]);
    expect(a.machineId).toBe("this-box");
    expect(a.sourceKind).toBe("agentkit");
    expect(a.bridgePath).toBe("/tmp/x.sock");
  });

  it("keeps parsing simulated and real unchanged", () => {
    expect(parseArgs(["--source", "real"]).sourceKind).toBe("real");
    expect(parseArgs(["--source", "simulated"]).sourceKind).toBe("simulated");
  });

  it("falls back safely on an unknown source", () => {
    const a = parseArgs(["--source", "bogus"]);
    expect(a.sourceKind).toBe("simulated");
  });
});
