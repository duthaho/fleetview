import { describe, it, expect } from "vitest";
import { renderFleet, renderShell, escapeHtml } from "./render.js";
import type { MachineView } from "../protocol.js";

describe("escapeHtml", () => {
  it("escapes markup-significant characters", () => {
    expect(escapeHtml(`<script>alert("x")&'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;",
    );
  });
});

describe("renderFleet", () => {
  const machines: MachineView[] = [
    {
      machineId: "alpha",
      sessions: [
        { id: "a1", machineId: "alpha", cwd: "/repo", model: "opus", status: "running" },
        { id: "a2", machineId: "alpha", cwd: "/tmp", model: "sonnet", status: "awaiting-approval" },
      ],
    },
    {
      machineId: "beta",
      sessions: [{ id: "b1", machineId: "beta", cwd: "/srv", model: "haiku", status: "done" }],
    },
  ];

  it("groups sessions under their machine and lists every session", () => {
    const html = renderFleet(machines);
    // Machine group headers present.
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    // Each session id shows.
    expect(html).toContain("a1");
    expect(html).toContain("a2");
    expect(html).toContain("b1");
    // Status becomes a class-bearing dot per status.
    expect(html).toContain("status-running");
    expect(html).toContain("status-awaiting-approval");
    expect(html).toContain("status-done");
  });

  it("html-escapes hostile machineId, cwd and model so no markup is injected", () => {
    const hostile: MachineView[] = [
      {
        machineId: `<img src=x onerror=alert(1)>`,
        sessions: [
          {
            id: `<script>1</script>`,
            machineId: `<img src=x onerror=alert(1)>`,
            cwd: `"/><b>hax</b>`,
            model: `</span><script>evil()</script>`,
            status: "running",
          },
        ],
      },
    ];
    const html = renderFleet(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>1</script>");
    expect(html).not.toContain("<b>hax</b>");
    expect(html).not.toContain("<script>evil()</script>");
    // The escaped forms are present.
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
  });

  it("shows an empty-state when there are no machines", () => {
    const html = renderFleet([]);
    expect(html.toLowerCase()).toContain("no ");
  });
});

describe("renderShell", () => {
  it("contains the #app mount and the module client script", () => {
    const html = renderShell();
    expect(html).toContain('id="app"');
    expect(html).toContain('<script type="module" src="/client.js">');
    // Terminal theme is inlined as CSS custom properties.
    expect(html).toContain("--paper");
    expect(html).toContain("--accent");
    expect(html).toContain("<!doctype html>");
  });
});
