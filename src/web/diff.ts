// Inline diff evidence (D6, AC4). PURE string builders — no DOM. parseUnifiedDiff
// splits a unified diff into typed rows; renderSessionDetail renders them with
// +/- coloring classes. EVERY diff line is html-escaped: a diff line containing
// <script> must not inject markup (tested). Shares the terminal theme via the
// diff-* classes defined in render.ts's inlined CSS.
import type { Session, SessionStatus } from "../protocol.js";
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

/** The session-detail panel: header + the inline unified diff (or empty-state). */
export function renderSessionDetail(session: Session, diffText: string | null): string {
  const head = `<header class="detail-head">
    <span class="detail-id">${escapeHtml(session.id)}</span>
    <span class="detail-meta">${escapeHtml(session.model)} · ${escapeHtml(session.cwd)}</span>
    <span class="detail-status status-label-${session.status}">${escapeHtml(STATUS_LABEL[session.status])}</span>
  </header>`;
  if (!diffText) {
    return `<div class="session-detail">${head}<p class="empty">no diff evidence yet</p></div>`;
  }
  const rows = parseUnifiedDiff(diffText).map(renderRow).join("\n");
  return `<div class="session-detail">${head}<div class="detail-diff">${rows}</div></div>`;
}
