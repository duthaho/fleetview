// fleetview browser client (D4). Opens a same-origin WebSocket, sends the
// browser hello, and live-renders snapshot/patch frames into #app via the PURE
// render.ts builders. Browser-only (native WebSocket + DOM) — tsc emits this as
// loadable ESM; vitest tests only the pure render.ts functions, never this file.
import type { MachineView, PendingPrompt, ServerToBrowser, SessionEvent } from "../protocol.js";
import { renderFleet, renderInbox } from "./render.js";
import { renderSessionDetail } from "./diff.js";

export const CLIENT_VERSION = "0.1.0";

interface View {
  machines: MachineView[];
  prompts: PendingPrompt[];
  artifacts: Map<string, string>;
  details: Map<string, SessionEvent[]>;
  selected: string | null;
}

const view: View = { machines: [], prompts: [], artifacts: new Map(), details: new Map(), selected: null };

// Project groups render as native <details> with a default-open heuristic, but
// paint() replaces .fleet-region's innerHTML on every 3s patch — which would
// discard the user's manual expand/collapse. Remember each group's toggled
// state by machine+cwd key and re-apply it after every repaint.
const groupOpen = new Map<string, boolean>();

function restoreGroupState(root: HTMLElement): void {
  root.querySelectorAll<HTMLDetailsElement>(".project-group[data-group-key]").forEach((el) => {
    // Namespace by machine so two machines sharing a cwd (or the "" unknown
    // group) keep independent collapse state. Composite key is JS-only (never
    // rendered), so a NUL separator is safe and cannot appear in a real path.
    const machine = el.closest<HTMLElement>(".machine")?.dataset.machineId ?? "";
    const key = `${machine}\u0000${el.dataset.groupKey ?? ""}`;
    if (groupOpen.has(key)) el.open = groupOpen.get(key)!;
    el.addEventListener("toggle", () => groupOpen.set(key, el.open));
  });
}

function q(sel: string): HTMLElement | null {
  return document.querySelector(sel);
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
  if (fleet) {
    fleet.innerHTML = renderFleet(view.machines);
    restoreGroupState(fleet);
  }
  const inbox = q(".inbox-region");
  if (inbox) inbox.innerHTML = renderInbox(view.prompts);
  const detail = q(".detail-region");
  if (detail) {
    const s = view.selected ? sessionById(view.selected) : null;
    detail.innerHTML = s
      ? renderSessionDetail(s, view.artifacts.get(s.id) ?? null, view.details.get(s.id))
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
      // Store detail by sessionId; only the currently-selected id is rendered, so
      // a late/out-of-order reply for another session is harmless.
      else if (op.op === "detail") view.details.set(op.sessionId, op.events);
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
      // Fetch this session's recent-activity tail on demand.
      if (view.selected && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ t: "requestDetail", sessionId: view.selected }));
      }
      paint();
    }
  });
}

connect();
