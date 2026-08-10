// PURE dom-string builders for the fleet dashboard (D4). No DOM, no I/O — the
// browser client (client.ts) injects these strings into #app on snapshot/patch.
// EVERY piece of session text is html-escaped: a hostile machineId / cwd / model
// must never inject markup (tested). The shell inlines the terminal theme so the
// console reads like the sibling vibecheck project (dark phosphor).
import type { MachineView, PendingPrompt, Session, SessionStatus } from "../protocol.js";

/** Escape the five markup-significant characters. Order matters: & first. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "starting",
  running: "running",
  "awaiting-approval": "awaiting approval",
  done: "done",
  aborted: "aborted",
};

function renderSession(s: Session): string {
  const id = escapeHtml(s.id);
  return `<li class="session" data-session-id="${id}" data-status="${s.status}">
      <span class="dot status-${s.status}" title="${escapeHtml(STATUS_LABEL[s.status])}"></span>
      <span class="session-id">${id}</span>
      <span class="session-meta">${escapeHtml(s.model)} · ${escapeHtml(s.cwd)}</span>
      <span class="session-status">${escapeHtml(STATUS_LABEL[s.status])}</span>
    </li>`;
}

function renderMachine(m: MachineView): string {
  const name = escapeHtml(m.machineId);
  const count = m.sessions.length;
  const rows = m.sessions.map(renderSession).join("\n");
  const body = count
    ? `<ul class="session-list">\n${rows}\n</ul>`
    : `<p class="empty">no sessions</p>`;
  return `<section class="machine" data-machine-id="${name}">
    <header class="machine-head">
      <span class="machine-name">${name}</span>
      <span class="machine-count">${count} session${count === 1 ? "" : "s"}</span>
    </header>
    ${body}
  </section>`;
}

/** The fleet session list, grouped by machine. */
export function renderFleet(machines: MachineView[]): string {
  if (machines.length === 0) {
    return `<p class="empty">no machines connected — start a fleet-node</p>`;
  }
  return machines.map(renderMachine).join("\n");
}

/** The approval inbox: one card per pending prompt with Approve/Deny buttons. */
export function renderInbox(prompts: PendingPrompt[]): string {
  if (prompts.length === 0) {
    return `<p class="empty">no pending approvals</p>`;
  }
  return prompts
    .map((p) => {
      const id = escapeHtml(p.promptId);
      return `<div class="inbox-item" data-prompt-id="${id}">
      <div class="prompt-head">
        <span class="prompt-tool">${escapeHtml(p.tool)}</span>
        <span class="prompt-where">${escapeHtml(p.machineId)} · ${escapeHtml(p.sessionId)}</span>
      </div>
      <div class="prompt-detail">${escapeHtml(p.detail)}</div>
      <div class="inbox-actions">
        <button class="btn approve" data-prompt-id="${id}" data-action="approve">Approve</button>
        <button class="btn deny" data-prompt-id="${id}" data-action="deny">Deny</button>
      </div>
    </div>`;
    })
    .join("\n");
}

// --- Terminal theme (dark phosphor), shared visual language with vibecheck. ---
const THEME_CSS = `:root {
  --paper: oklch(17% 0.015 160);
  --paper-2: oklch(21% 0.018 160);
  --ink: oklch(88% 0.02 150);
  --ink-2: oklch(62% 0.025 155);
  --rule: oklch(31% 0.02 160);
  --accent: oklch(78% 0.17 150);
  --danger: oklch(68% 0.19 25);
  --warn: oklch(80% 0.13 85);
  --font: ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
}
#app { display: grid; gap: 0; min-height: 100vh; }
.masthead {
  display: flex; align-items: baseline; gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--rule);
  background: var(--paper-2);
}
.masthead h1 { margin: 0; font-size: 15px; letter-spacing: 0.5px; color: var(--accent); }
.masthead .tag { color: var(--ink-2); font-size: 12px; }
.masthead .conn { margin-left: auto; color: var(--ink-2); font-size: 12px; }
.masthead .conn.live::before { content: "● "; color: var(--accent); }
.masthead .conn.down::before { content: "● "; color: var(--danger); }
.layout { display: grid; grid-template-columns: 1.4fr 1fr; gap: 1px; background: var(--rule); flex: 1; }
.pane { background: var(--paper); padding: 16px 20px; overflow: auto; }
.pane > h2 {
  margin: 0 0 12px; font-size: 12px; text-transform: uppercase;
  letter-spacing: 1px; color: var(--ink-2); font-weight: 600;
}
.machine { margin-bottom: 18px; }
.machine-head {
  display: flex; align-items: baseline; gap: 10px;
  padding-bottom: 6px; border-bottom: 1px solid var(--rule); margin-bottom: 6px;
}
.machine-name { color: var(--accent); font-weight: 600; }
.machine-count { color: var(--ink-2); font-size: 11px; }
.session-list { list-style: none; margin: 0; padding: 0; }
.session {
  display: grid; grid-template-columns: 14px minmax(0,1fr) auto; align-items: center;
  column-gap: 10px; padding: 5px 6px; border-radius: 4px; cursor: pointer;
}
.session:hover { background: var(--paper-2); }
.session.selected { background: var(--paper-2); outline: 1px solid var(--rule); }
.session-id { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-meta { grid-column: 2; color: var(--ink-2); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-status { color: var(--ink-2); font-size: 11px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ink-2); display: inline-block; }
.status-starting { background: var(--ink-2); }
.status-running { background: var(--accent); box-shadow: 0 0 6px var(--accent); }
.status-awaiting-approval { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.status-done { background: var(--ink-2); }
.status-aborted { background: var(--danger); }
.empty { color: var(--ink-2); font-style: italic; }
.inbox-item {
  border: 1px solid var(--rule); border-radius: 5px; padding: 10px 12px; margin-bottom: 10px;
  background: var(--paper-2);
}
.inbox-item .prompt-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
.inbox-item .prompt-tool { color: var(--warn); font-weight: 600; }
.inbox-item .prompt-where { color: var(--ink-2); font-size: 11px; }
.inbox-item .prompt-detail { color: var(--ink); margin: 4px 0 8px; }
.inbox-actions { display: flex; gap: 8px; }
.btn {
  font-family: var(--font); font-size: 12px; cursor: pointer;
  padding: 4px 12px; border-radius: 4px; border: 1px solid var(--rule);
  background: var(--paper); color: var(--ink);
}
.btn.approve { border-color: var(--accent); color: var(--accent); }
.btn.approve:hover { background: var(--accent); color: var(--paper); }
.btn.deny { border-color: var(--danger); color: var(--danger); }
.btn.deny:hover { background: var(--danger); color: var(--paper); }
.detail-diff { border: 1px solid var(--rule); border-radius: 5px; overflow: hidden; }
.diff-row { display: grid; grid-template-columns: 100%; padding: 0 10px; white-space: pre-wrap; word-break: break-all; }
.diff-hunk { color: var(--ink-2); background: var(--paper-2); }
.diff-add { color: var(--accent); }
.diff-del { color: var(--danger); }
.diff-context { color: var(--ink-2); }`;

/** The server-rendered HTML shell: #app mount + module client + inlined theme. */
export function renderShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>fleetview — fleet console</title>
<style>${THEME_CSS}</style>
</head>
<body>
<div id="app">
  <div class="masthead"><h1>fleetview</h1><span class="tag">fleet console</span><span class="conn down">connecting…</span></div>
  <div class="layout">
    <div class="pane"><h2>Fleet</h2><div class="fleet-region"><p class="empty">connecting…</p></div></div>
    <div class="pane">
      <h2>Approval inbox</h2><div class="inbox-region"><p class="empty">no pending approvals</p></div>
      <h2 style="margin-top:20px">Session detail</h2><div class="detail-region"><p class="empty">select a session</p></div>
    </div>
  </div>
</div>
<script type="module" src="/client.js"></script>
</body>
</html>`;
}
