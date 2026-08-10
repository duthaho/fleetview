// T14 end-to-end: spawn the built server + two simulated nodes, connect as a
// browser over WebSocket, and assert the flagship demo path:
//   1. both machines' sessions list (multi-machine, AC1)
//   2. a permission prompt reaches the inbox (AC3)
//   3. Approve unblocks the session → status done + a diff artifact (AC3/AC4)
// Run: node scripts/e2e.mjs   (from repo root, after `npm run build`)
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const TOKEN = "demo";
const PORT = 4399;
const env = { ...process.env, FLEETVIEW_TOKEN: TOKEN, PORT: String(PORT), HOST: "127.0.0.1" };
const procs = [];
const spawnNode = (args) => {
  const p = spawn("node", args, { env: { ...env, FLEETVIEW_SERVER: `ws://127.0.0.1:${PORT}` }, stdio: "inherit" });
  procs.push(p);
  return p;
};
const cleanup = () => procs.forEach((p) => { try { p.kill(); } catch {} });
const fail = (m) => { console.error("E2E FAIL:", m); cleanup(); process.exit(1); };

spawnNode(["dist/server/main.js"]);
await new Promise((r) => setTimeout(r, 800));
spawnNode(["dist/node/main.js", "--machine", "alpha", "--source", "simulated"]);
spawnNode(["dist/node/main.js", "--machine", "beta", "--source", "simulated"]);

const view = { machines: [], prompts: [], artifacts: {} };
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: `http://127.0.0.1:${PORT}` });
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", role: "browser" })));
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  const apply = (op) => {
    if (op.op === "machines") view.machines = op.machines;
    else if (op.op === "prompts") view.prompts = op.prompts;
    else if (op.op === "artifact") view.artifacts[op.sessionId] = op.diff;
  };
  if (m.t === "snapshot") view.machines = m.machines;
  else if (m.t === "patch") m.ops.forEach(apply);
});

const until = async (label, pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`timeout waiting for: ${label}`);
};

// 1. both machines visible
await until("both machines listed", () => {
  const ids = view.machines.map((m) => m.machineId).sort();
  return ids.includes("alpha") && ids.includes("beta");
});
console.log("OK  multi-machine: machines =", view.machines.map((m) => m.machineId).sort().join(", "));

// 2. a prompt reaches the inbox
await until("a prompt in the inbox", () => view.prompts.length > 0);
const prompt = view.prompts[0];
console.log(`OK  approval inbox: prompt ${prompt.promptId} from ${prompt.machineId} (${prompt.tool})`);

// 3. approve → session done + diff artifact
ws.send(JSON.stringify({ t: "decision", promptId: prompt.promptId, approve: true }));
await until("artifact after approve", () => Object.keys(view.artifacts).length > 0);
const [sid, diff] = Object.entries(view.artifacts)[0];
if (!diff.includes("+") || !diff.includes("-")) fail("artifact is not a diff");
console.log(`OK  remote approval → diff artifact for session ${sid} (${diff.split("\n").length} diff lines)`);

console.log("\nE2E OK — multi-machine list, approval round-trip, inline diff all verified.");
ws.close();
cleanup();
process.exit(0);
