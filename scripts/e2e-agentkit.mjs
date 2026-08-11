// T9 end-to-end (real-agent gating): exercises the REAL code across processes.
//   real agentkit Escalation + EscalationBridge (on a real Unix socket)
//   → real fleetview server + node (--source agentkit) + a browser WebSocket.
// The "agent" at the far end is a real `decide()` callback that resolves a
// promise — that callback IS the SDK's canUseTool resolve, the exact boundary
// A1 gates. Approve in the browser must resolve it {allow:true}; Deny {allow:false}.
// Run (after building both repos):  node scripts/e2e-agentkit.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const AK = "/home/ubuntu/agentkit-workspace/agentkit/dist";
const { Escalation } = await import(`${AK}/transport/escalation.js`);
const { EscalationBridge } = await import(`${AK}/transport/escalation-bridge.js`);
const { SessionRuntime } = await import(`${AK}/runtime/sessions.js`);
const { TurnQueue } = await import(`${AK}/runtime/turn-queue.js`);

const TOKEN = "e2e-demo";
const PORT = 4398;
const sock = join(mkdtempSync(join(tmpdir(), "e2e-ak-")), "esc.sock");
const procs = [];
const cleanup = () => procs.forEach((p) => { try { p.kill(); } catch {} });
const fail = (m) => { console.error("E2E FAIL:", m); cleanup(); process.exit(1); };

// --- real agentkit escalation machinery (minimal real deps, real decide) ---
const rowFor = (id) => ({
  id, project_path: "/home/ubuntu/demo", project_name: "demo", telegram_chat_id: 7,
  telegram_topic_id: 3, claude_session_id: "sess-abc", model: null, permission_posture: "auto",
  worktree_path: null, branch: null, base_ref: null, total_output_tokens: 0, total_cost_usd: 0,
  state: "Idle", created_at: "", last_active_at: "",
});
const store = {
  rows: new Map([[1, rowFor(1)]]),
  findById(id) { return this.rows.get(id); },
  getById(id) { return this.rows.get(id); },
  setState(id, s) { this.rows.get(id).state = s; },
  setPosture() {}, deleteJobsBySession() { return 0; }, deleteWakeupsBySession() { return 0; },
  resetPostures() {}, markInterrupted() { return []; },
};
const chat = {
  send: async () => 10, editText: async () => {}, editKeyboard: async () => {},
  react: async () => {}, sendFile: async () => undefined,
};
const audit = { record: () => {} };
const runtime = new SessionRuntime(store, new TurnQueue(5, 10));
const esc = new Escalation(chat, runtime, store, audit);
const bridge = new EscalationBridge(sock, (token, d) => esc.resolveExternal(token, d));
esc.setListener(bridge);
await bridge.listen();

// --- real fleetview server + node(--source agentkit) ---
const env = { ...process.env, FLEETVIEW_TOKEN: TOKEN, PORT: String(PORT), HOST: "127.0.0.1" };
const spawnNode = (args) => { const p = spawn("node", args, { env: { ...env, FLEETVIEW_SERVER: `ws://127.0.0.1:${PORT}` }, stdio: "inherit" }); procs.push(p); return p; };
spawnNode(["dist/server/main.js"]);
await new Promise((r) => setTimeout(r, 800));
spawnNode(["dist/node/main.js", "--machine", "this-box", "--source", "agentkit", "--bridge", sock]);
await new Promise((r) => setTimeout(r, 1200));

// --- browser ---
const view = { prompts: [] };
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { origin: `http://127.0.0.1:${PORT}` });
ws.on("open", () => ws.send(JSON.stringify({ t: "hello", role: "browser" })));
ws.on("message", (d) => {
  const m = JSON.parse(String(d));
  if (m.t === "snapshot") return;
  if (m.t === "patch") for (const op of m.ops) if (op.op === "prompts") view.prompts = op.prompts;
});
const until = async (label, pred, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await new Promise((r) => setTimeout(r, 150)); }
  fail(`timeout: ${label}`);
};

// Raise a REAL escalation and gate one case (approve or deny).
async function runCase(kind, approve) {
  let decided;
  const decide = new Promise((res) => { decided = res; });
  const reqCtrl = new AbortController();
  const req = { toolName: "Bash", input: { command: `rm -rf /tmp/${kind}` }, signal: reqCtrl.signal, decide: (d) => decided(d) };
  runtime.registerTurn(1, new AbortController()); // → Running, so the turn is live
  await esc.present(1, 7, 3, req);                 // arms + bridge broadcasts to fleetview

  await until(`${kind}: prompt in inbox`, () => view.prompts.some((p) => p.tool === "Bash"));
  const prompt = view.prompts.find((p) => p.tool === "Bash");
  console.log(`OK  ${kind}: real prompt reached fleetview inbox (${prompt.promptId})`);

  ws.send(JSON.stringify({ t: "decision", promptId: prompt.promptId, approve }));
  const d = await Promise.race([decide, new Promise((_, rej) => setTimeout(() => rej(new Error("decide() never fired")), 10000))]).catch((e) => fail(`${kind}: ${e.message}`));
  if (d.allow !== approve) fail(`${kind}: agent decided allow=${d.allow}, expected ${approve}`);
  console.log(`OK  ${kind}: real agent decide() fired allow=${d.allow} — the agent was ${approve ? "unblocked" : "blocked"}`);
  await until(`${kind}: inbox cleared`, () => !view.prompts.some((p) => p.tool === "Bash"));
  runtime.finishTurn?.(1);
}

try {
  await runCase("approve", true);
  await runCase("deny", false);
  console.log("\nE2E OK — a real permission prompt was gated from the fleetview dashboard: Approve unblocked the agent, Deny blocked it.");
} catch (e) { fail(e.message); }
ws.close(); bridge.close?.(); cleanup(); process.exit(0);
