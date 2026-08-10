// fleetview-node entry point (D1). Parses `--machine <id> --source <simulated|real>`,
// opens a real WebSocket to the server, wires a SessionSource into FleetNode, and
// (for the simulated source) paces the scripted lifecycle with a real interval —
// the only place real timers live; FleetNode + SimulatedSource stay deterministic.
import { WebSocket } from "ws";
import { FleetNode, type NodeConn } from "./node.js";
import { SimulatedSource } from "./sources/simulated.js";
import type { SessionSource } from "./source.js";

interface Args {
  machineId: string;
  sourceKind: "simulated" | "real";
  serverUrl: string;
  token: string;
}

export function parseArgs(argv: string[]): Args {
  let machineId = "local";
  let sourceKind: "simulated" | "real" = "simulated";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--machine") machineId = argv[++i] ?? machineId;
    else if (argv[i] === "--source") {
      const v = argv[++i];
      if (v === "simulated" || v === "real") sourceKind = v;
    }
  }
  return {
    machineId,
    sourceKind,
    serverUrl: process.env.FLEETVIEW_SERVER ?? "ws://127.0.0.1:4300",
    token: process.env.FLEETVIEW_TOKEN ?? "",
  };
}

function makeSource(args: Args): SessionSource {
  if (args.sourceKind === "real") {
    // T12 provides the real reader; until then fall back to simulated so the
    // process never crashes on `--source real`.
    return new SimulatedSource(args.machineId, `${args.machineId}-sim`);
  }
  return new SimulatedSource(args.machineId, `${args.machineId}-sim`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const source = makeSource(args);
  const ws = new WebSocket(args.serverUrl);

  ws.on("open", () => {
    const node = new FleetNode({
      machineId: args.machineId,
      token: args.token,
      conn: ws as unknown as NodeConn,
      source,
    });
    node.start();
    // Pace the simulated lifecycle: running, then a permission prompt.
    if (source instanceof SimulatedSource) {
      setInterval(() => source.tick(), 3000).unref();
    }
  });

  ws.on("close", () => process.exit(0));
  ws.on("error", (err: Error) => {
    console.error("fleet-node connection error:", err.message);
    process.exit(1);
  });
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
