// Inline diff evidence (D6, AC4). PURE string builders — no DOM. parseUnifiedDiff
// splits a unified diff into typed rows; renderSessionDetail renders them with
// +/- coloring classes. EVERY diff line is html-escaped: a diff line containing
// <script> must not inject markup (tested). Shares the terminal theme via the
// diff-* classes defined in render.ts's inlined CSS.
import type { Session, SessionEvent, SessionStatus } from "../protocol.js";
import { escapeHtml } from "./render.js";

export type DiffKind = "add" | "del" | "hunk" | "context" | "meta";

export interface DiffRow {
  kind: DiffKind;
  text: string;
}

/**
 * Parse a unified diff into typed rows.
 *  - `@@ … @@` hunk headers → "hunk"
 *  - `--- ` / `+++ ` file headers → "meta" (NOT add/del)
 *  - single `+` / `-` content lines → "add" / "del"
 *  - everything else (incl. leading space) → "context"
 */
export function parseUnifiedDiff(text: string): DiffRow[] {
  if (text === "") return [];
  // Track hunk state: inside a hunk body the first character is the marker, so
  // a content line like "+++ note" is an ADDED line, not a file header. The
  // `--- a/…` / `+++ b/…` headers only appear before the first `@@`.
  let inHunk = false;
  return text.split("\n").map((line) => {
    if (line.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk" as DiffKind, text: line };
    }
    return { kind: classify(line, inHunk), text: line };
  });
}

function classify(line: string, inHunk: boolean): DiffKind {
  if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: "starting",
  running: "running",
  "awaiting-approval": "awaiting approval",
  done: "done",
  aborted: "aborted",
};

function renderRow(row: DiffRow): string {
  return `<div class="diff-row diff-${row.kind}">${escapeHtml(row.text)}</div>`;
}

/** Compact activity summary for a session (header line / fleet row). */
export function activitySummary(s: Session): string {
  const bits: string[] = [];
  if (s.lastTool) bits.push(`▸ ${escapeHtml(s.lastTool)}`);
  if (typeof s.messages === "number" && s.messages > 0) bits.push(`${s.messages} msg`);
  if (typeof s.tokens === "number" && s.tokens > 0) bits.push(`${s.tokens.toLocaleString("en-US")} tok`);
  if (typeof s.costUsd === "number" && s.costUsd > 0) bits.push(`$${s.costUsd.toFixed(2)}`);
  return bits.join(" · ");
}

function renderEvent(e: SessionEvent): string {
  const kind = e.kind === "tool" ? "tool" : "text"; // unknown kind → text (safe)
  const label = kind === "tool" ? `▸ ${escapeHtml(e.text)}` : escapeHtml(e.text);
  return `<div class="event event-${kind}">${label}</div>`;
}

/**
 * The session-detail panel: header + activity (recent events when supplied,
 * else the inline unified diff, else empty). Every field is html-escaped.
 */
export function renderSessionDetail(
  session: Session,
  diffText: string | null,
  events?: SessionEvent[],
): string {
  const summary = activitySummary(session);
  const head = `<header class="detail-head">
    <span class="detail-id">${escapeHtml(session.id)}</span>
    <span class="detail-meta">${escapeHtml(session.model)} · ${escapeHtml(session.cwd)}</span>
    <span class="detail-status status-label-${session.status}">${escapeHtml(STATUS_LABEL[session.status])}</span>
    ${summary ? `<span class="detail-activity">${summary}</span>` : ""}
  </header>`;
  if (events && events.length > 0) {
    const rows = events.map(renderEvent).join("\n");
    return `<div class="session-detail">${head}<div class="detail-events">${rows}</div></div>`;
  }
  if (!diffText) {
    return `<div class="session-detail">${head}<p class="empty">no diff evidence yet</p></div>`;
  }
  const rows = parseUnifiedDiff(diffText).map(renderRow).join("\n");
  return `<div class="session-detail">${head}<div class="detail-diff">${rows}</div></div>`;
}
