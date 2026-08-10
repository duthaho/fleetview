// fleetview browser client (D4). Opens a same-origin WebSocket, sends the
// browser hello, and live-renders snapshot/patch frames into #app via the PURE
// render.ts builders. Browser-only (native WebSocket + DOM) — tsc emits this as
// loadable ESM; vitest tests only the pure render.ts functions, never this file.
import type { MachineView, PendingPrompt, ServerToBrowser } from "../protocol.js";
import { renderFleet, renderInbox } from "./render.js";

export const CLIENT_VERSION = "0.1.0";

interface View {
  machines: MachineView[];
  prompts: PendingPrompt[];
  artifacts: Map<string, string>;
  selected: string | null;
}

const view: View = { machines: [], prompts: [], artifacts: new Map(), selected: null };

function q(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

// Session-detail rendering is provided by diff.ts (wired in T11). Until then a
// minimal placeholder keeps the read-path client honest.
function renderDetail(session: { id: string; status: string }, _diff: string | null): string {
  return `<p class="empty">${session.id} — ${session.status}</p>`;
}

function sessionById(id: string) {
  for (const m of view.machines) {
    const s = m.sessions.find((x) => x.id === id);
    if (s) return s;
  }
  return null;
}

function paint(): void {
  const fleet = q(".fleet-region");
  if (fleet) fleet.innerHTML = renderFleet(view.machines);
  const inbox = q(".inbox-region");
  if (inbox) inbox.innerHTML = renderInbox(view.prompts);
  const detail = q(".detail-region");
  if (detail) {
    const s = view.selected ? sessionById(view.selected) : null;
    detail.innerHTML = s
      ? renderDetail(s, view.artifacts.get(s.id) ?? null)
      : `<p class="empty">select a session</p>`;
  }
  const sel = view.selected;
  if (sel) {
    const el = document.querySelector(`.session[data-session-id="${CSS.escape(sel)}"]`);
    el?.classList.add("selected");
  }
}

function applyFrame(msg: ServerToBrowser): void {
  if (msg.t === "snapshot") {
    view.machines = msg.machines;
  } else {
    for (const op of msg.ops) {
      if (op.op === "machines") view.machines = op.machines;
      else if (op.op === "prompts") view.prompts = op.prompts;
      else if (op.op === "artifact") view.artifacts.set(op.sessionId, op.diff);
    }
  }
  paint();
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}`);
  const conn = q(".conn");

  ws.addEventListener("open", () => {
    if (conn) {
      conn.textContent = "live";
      conn.className = "conn live";
    }
    ws.send(JSON.stringify({ t: "hello", role: "browser" }));
  });

  ws.addEventListener("message", (ev: MessageEvent) => {
    let msg: ServerToBrowser;
    try {
      msg = JSON.parse(String(ev.data)) as ServerToBrowser;
    } catch {
      return;
    }
    applyFrame(msg);
  });

  ws.addEventListener("close", () => {
    if (conn) {
      conn.textContent = "disconnected — retrying…";
      conn.className = "conn down";
    }
    setTimeout(connect, 1500);
  });

  // Delegated clicks: session select + approve/deny buttons.
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const btn = target.closest<HTMLElement>("button[data-prompt-id]");
    if (btn) {
      const promptId = btn.dataset.promptId!;
      const approve = btn.dataset.action === "approve";
      ws.send(JSON.stringify({ t: "decision", promptId, approve }));
      return;
    }
    const row = target.closest<HTMLElement>(".session[data-session-id]");
    if (row) {
      view.selected = row.dataset.sessionId ?? null;
      paint();
    }
  });
}

connect();
