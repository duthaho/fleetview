import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, renderSessionDetail } from "./diff.js";
import type { Session } from "../protocol.js";

const KNOWN_DIFF = `--- a/greeter.ts
+++ b/greeter.ts
@@ -1,3 +1,3 @@
 export function greet(name: string) {
-  return "Hi " + name;
+  return \`Hello, \${name}!\`;
 }`;

describe("parseUnifiedDiff", () => {
  it("tags every row add/del/context/hunk", () => {
    const rows = parseUnifiedDiff(KNOWN_DIFF);
    const kinds = rows.map((r) => r.kind);
    // The two file headers (--- / +++) are context-ish meta; hunk header @@ tagged.
    expect(kinds).toContain("hunk");
    expect(kinds).toContain("add");
    expect(kinds).toContain("del");
    expect(kinds).toContain("context");
  });

  it("counts added and removed lines correctly (known diff)", () => {
    const rows = parseUnifiedDiff(KNOWN_DIFF);
    const added = rows.filter((r) => r.kind === "add").length;
    const removed = rows.filter((r) => r.kind === "del").length;
    expect(added).toBe(1);
    expect(removed).toBe(1);
    const hunks = rows.filter((r) => r.kind === "hunk").length;
    expect(hunks).toBe(1);
  });

  it("does not misclassify the +++/--- file headers as add/del", () => {
    const rows = parseUnifiedDiff(KNOWN_DIFF);
    // Only real content lines (single +/-) count as add/del, not +++ / ---.
    expect(rows.filter((r) => r.kind === "add").every((r) => !r.text.startsWith("+++"))).toBe(true);
    expect(rows.filter((r) => r.kind === "del").every((r) => !r.text.startsWith("---"))).toBe(true);
  });

  it("handles empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

const SESSION: Session = {
  id: "s1",
  machineId: "alpha",
  cwd: "/repo",
  model: "opus",
  status: "done",
};

describe("renderSessionDetail", () => {
  it("renders diff rows with +/- coloring classes", () => {
    const html = renderSessionDetail(SESSION, KNOWN_DIFF);
    expect(html).toContain("diff-add");
    expect(html).toContain("diff-del");
    expect(html).toContain("diff-hunk");
    expect(html).toContain("diff-context");
  });

  it("shows the session id/status and an empty-state when no diff", () => {
    const html = renderSessionDetail(SESSION, null);
    expect(html).toContain("s1");
    expect(html.toLowerCase()).toContain("no diff");
  });

  it("html-escapes diff lines so a diff line with <script> cannot inject", () => {
    const hostile = `@@ -1 +1 @@
-<script>old()</script>
+<script>alert("xss")</script>
 context <b>ok</b>`;
    const html = renderSessionDetail(SESSION, hostile);
    expect(html).not.toContain("<script>old()</script>");
    expect(html).not.toContain(`<script>alert("xss")</script>`);
    expect(html).not.toContain("<b>ok</b>");
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });
});

describe("parseUnifiedDiff — hunk-aware classification (review fix)", () => {
  it("classifies content lines starting with +++/--- inside a hunk as add/del, not meta", async () => {
    const { parseUnifiedDiff } = await import("./diff.js");
    const diff = [
      "--- a/f",       // file header (meta)
      "+++ b/f",       // file header (meta)
      "@@ -1,2 +1,2 @@",
      "+++ added marker line",   // ADD inside hunk
      "--- removed marker line", // DEL inside hunk
      " context",
    ].join("\n");
    const rows = parseUnifiedDiff(diff);
    expect(rows[0]!.kind).toBe("meta");
    expect(rows[1]!.kind).toBe("meta");
    expect(rows[2]!.kind).toBe("hunk");
    expect(rows[3]!.kind).toBe("add");
    expect(rows[4]!.kind).toBe("del");
  });
});

describe("renderSessionDetail — activity events (session-activity feature)", () => {
  const base = { id: "s1", machineId: "m", cwd: "/repo", model: "opus", status: "running" as const };

  it("renders an activity header + recent events, all escaped", async () => {
    const { renderSessionDetail } = await import("./diff.js");
    const session = { ...base, lastTool: "Bash", messages: 4, tokens: 120, costUsd: 0.02 };
    const events = [
      { kind: "text" as const, text: "building the thing <ok>" },
      { kind: "tool" as const, text: "Bash" },
    ];
    const html = renderSessionDetail(session, null, events);
    expect(html).toContain("Bash");
    expect(html).toMatch(/120|tokens/);
    expect(html).toContain("building the thing &lt;ok&gt;"); // escaped
  });

  it("escapes a hostile event text (no injection)", async () => {
    const { renderSessionDetail } = await import("./diff.js");
    const events = [{ kind: "text" as const, text: `<script>alert(1)</script>` }];
    const html = renderSessionDetail(base, null, events);
    expect(html).not.toContain("<script>alert");
  });

  it("renders safely when an event kind is unexpected", async () => {
    const { renderSessionDetail } = await import("./diff.js");
    const events = [{ kind: "weird" as unknown as "text", text: "x" }];
    expect(() => renderSessionDetail(base, null, events)).not.toThrow();
  });

  it("falls back to diff/empty when no events passed (unchanged behavior)", async () => {
    const { renderSessionDetail } = await import("./diff.js");
    expect(renderSessionDetail(base, null)).toContain("no diff evidence yet");
  });
});
