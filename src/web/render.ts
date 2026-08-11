// PURE dom-string builders for the fleet dashboard (D4). No DOM, no I/O — the
// browser client (client.ts) injects these strings into #app on snapshot/patch.
// EVERY piece of session text is html-escaped: a hostile machineId / cwd / model
// must never inject markup (tested). The shell inlines the terminal theme so the
// console reads like the sibling vibecheck project (dark phosphor).
import type { MachineView, PendingPrompt, Session, SessionStatus } from "../protocol.js";
import { activitySummary } from "./diff.js";

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
      ${activitySummary(s) ? `<span class="session-activity">${activitySummary(s)}</span>` : ""}
    </li>`;
}

const ACTIVE: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["starting", "running", "awaiting-approval"]);

/** Trailing path segment of a cwd as a short project label; "" → "unknown". */
function projectLabel(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "unknown";
}

interface ProjectGroup {
  key: string;
  sessions: Session[];
  active: boolean;
  lastActivity: number;
}

/**
 * Group a machine's sessions by cwd so a long list reads as a few projects.
 * Groups sort active-first, then most-recently-active; sessions keep input order.
 */
function groupByCwd(sessions: Session[]): ProjectGroup[] {
  const byKey = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const key = s.cwd || "";
    let g = byKey.get(key);
    if (!g) {
      g = { key, sessions: [], active: false, lastActivity: 0 };
      byKey.set(key, g);
    }
    g.sessions.push(s);
    if (ACTIVE.has(s.status)) g.active = true;
    const ts = s.lastActivity ? Date.parse(s.lastActivity) : NaN;
    if (!Number.isNaN(ts)) g.lastActivity = Math.max(g.lastActivity, ts);
  }
  return [...byKey.values()].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.lastActivity - a.lastActivity || a.key.localeCompare(b.key),
  );
}

function renderGroup(g: ProjectGroup): string {
  const key = escapeHtml(g.key);
  const label = escapeHtml(projectLabel(g.key));
  const rows = g.sessions.map(renderSession).join("\n");
  // A group holding a live session opens by default; all-done groups collapse
  // to keep a long list scannable. The client preserves manual toggles.
  return `<details class="project-group" data-group-key="${key}"${g.active ? " open" : ""}>
    <summary class="project-head">
      <span class="project-name">${label}</span>
      <span class="project-count">${g.sessions.length}</span>
    </summary>
    <ul class="session-list">
${rows}
    </ul>
  </details>`;
}

function renderMachine(m: MachineView): string {
  const name = escapeHtml(m.machineId);
  const count = m.sessions.length;
  const body = count
    ? groupByCwd(m.sessions).map(renderGroup).join("\n")
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
.session-list { list-style: none; margin: 0; padding: 0 0 0 8px; }
.project-group { margin: 2px 0; }
.project-group > summary {
  display: flex; align-items: baseline; gap: 8px; cursor: pointer;
  padding: 4px 6px; border-radius: 4px; list-style: none; user-select: none;
}
.project-group > summary::-webkit-details-marker { display: none; }
.project-group > summary::before { content: "▸"; color: var(--ink-2); font-size: 10px; }
.project-group[open] > summary::before { content: "▾"; }
.project-group > summary:hover { background: var(--paper-2); }
.project-name { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-count {
  color: var(--ink-2); font-size: 11px; border: 1px solid var(--rule);
  border-radius: 999px; padding: 0 7px; margin-left: auto;
}
.session {
  display: grid; grid-template-columns: 14px minmax(0,1fr) auto;
  align-items: center; column-gap: 10px; row-gap: 1px;
  padding: 5px 6px; border-radius: 4px; cursor: pointer;
}
.session:hover { background: var(--paper-2); }
.session.selected { background: var(--paper-2); outline: 1px solid var(--rule); }
.dot { grid-column: 1; grid-row: 1; }
.session-id { grid-column: 2; grid-row: 1; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-status { grid-column: 3; grid-row: 1; color: var(--ink-2); font-size: 11px; }
.session-meta { grid-column: 2 / -1; grid-row: 2; color: var(--ink-2); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.session-detail .detail-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px solid var(--rule);
}
.detail-id { color: var(--accent); font-weight: 600; }
.detail-meta { color: var(--ink-2); font-size: 11px; }
.detail-status { margin-left: auto; color: var(--ink-2); font-size: 11px; }
.status-label-done { color: var(--accent); }
.status-label-aborted { color: var(--danger); }
.status-label-awaiting-approval { color: var(--warn); }
.detail-diff { border: 1px solid var(--rule); border-radius: 5px; overflow: hidden; }
.diff-row { padding: 0 10px; white-space: pre-wrap; word-break: break-all; }
.diff-hunk { color: var(--ink); background: var(--paper-2); }
.diff-meta { color: var(--ink-2); background: var(--paper-2); }
.diff-add { color: var(--accent); }
.diff-del { color: var(--danger); }
.diff-context { color: var(--ink-2); }
.session-activity { grid-column: 2 / -1; grid-row: 3; color: var(--ink-2); font-size: 11px; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-activity { display: block; margin-top: 4px; color: var(--ink-2); font-size: 12px; }
.detail-events { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.event { padding: 4px 8px; border-left: 2px solid var(--rule); white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.event-text { color: var(--ink); }
.event-tool { color: var(--accent); border-left-color: var(--accent); }`;

/** Exposed for CSS-regression tests (Bug A: activity line must not collide). */
export const THEME_CSS_FOR_TEST = THEME_CSS;

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
