// fleetview-node entry point (D1). Parses `--machine <id> --source <simulated|real>`,
// opens a real WebSocket to the server, wires a SessionSource into FleetNode, and
// (for the simulated source) paces the scripted lifecycle with a real interval —
// the only place real timers live; FleetNode + SimulatedSource stay deterministic.
import { WebSocket } from "ws";
import { FleetNode, type NodeConn } from "./node.js";
import { SimulatedSource } from "./sources/simulated.js";
import { RealSource } from "./sources/real.js";
import { AgentkitSource } from "./sources/agentkit.js";
import type { SessionSource } from "./source.js";

interface Args {
  machineId: string;
  sourceKind: "simulated" | "real" | "agentkit";
  serverUrl: string;
  token: string;
  /** Unix-socket path for the agentkit escalation bridge (--source agentkit). */
  bridgePath?: string;
}

export function parseArgs(argv: string[]): Args {
  let machineId = "local";
  let sourceKind: "simulated" | "real" | "agentkit" = "simulated";
  let bridgePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--machine") machineId = argv[++i] ?? machineId;
    else if (argv[i] === "--source") {
      const v = argv[++i];
      if (v === "simulated" || v === "real" || v === "agentkit") sourceKind = v;
    } else if (argv[i] === "--bridge") bridgePath = argv[++i] ?? bridgePath;
  }
  return {
    machineId,
    sourceKind,
    serverUrl: process.env.FLEETVIEW_SERVER ?? "ws://127.0.0.1:4300",
    token: process.env.FLEETVIEW_TOKEN ?? "",
    bridgePath,
  };
}

function makeSource(args: Args): SessionSource {
  if (args.sourceKind === "real") return new RealSource(args.machineId);
  if (args.sourceKind === "agentkit") {
    const path = args.bridgePath ?? process.env.AGENTKIT_ESC_BRIDGE ?? "/tmp/agentkit-esc.sock";
    return new AgentkitSource(args.machineId, path);
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
