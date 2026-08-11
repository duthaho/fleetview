import { describe, it, expect } from "vitest";
import { renderFleet, renderInbox, renderShell, escapeHtml } from "./render.js";
import type { MachineView, PendingPrompt } from "../protocol.js";

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

describe("renderInbox", () => {
  it("renders one card per prompt with Approve/Deny buttons carrying the promptId", () => {
    const prompts: PendingPrompt[] = [
      { promptId: "p1", sessionId: "s1", machineId: "alpha", tool: "bash", detail: "rm -rf build" },
    ];
    const html = renderInbox(prompts);
    expect(html).toContain("bash");
    expect(html).toContain("rm -rf build");
    expect(html).toContain('data-prompt-id="p1"');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
  });

  it("html-escapes hostile prompt fields so no markup is injected", () => {
    const prompts: PendingPrompt[] = [
      {
        promptId: `"><img src=x onerror=alert(1)>`,
        sessionId: `</span><script>evil()</script>`,
        machineId: `<b>m</b>`,
        tool: `<i>t</i>`,
        detail: `<script>steal()</script>`,
      },
    ];
    const html = renderInbox(prompts);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).not.toContain("<script>steal()</script>");
    expect(html).not.toContain("<b>m</b>");
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
  });

  it("shows an empty-state when the inbox is empty", () => {
    expect(renderInbox([]).toLowerCase()).toContain("no pending");
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

describe("renderFleet — row activity line (session-activity feature)", () => {
  it("shows last-tool + tokens per row and escapes a hostile lastTool", async () => {
    const { renderFleet } = await import("./render.js");
    const machines = [{ machineId: "m", sessions: [
      { id: "s1", machineId: "m", cwd: "/r", model: "opus", status: "running" as const, lastTool: "<img src=x>", tokens: 999 },
    ]}];
    const html = renderFleet(machines);
    expect(html).toContain("999");
    expect(html).not.toContain("<img src=x>"); // escaped
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("places the activity line on its own grid row so it can't collide with meta (Bug A)", async () => {
    const { renderFleet, THEME_CSS_FOR_TEST } = await import("./render.js");
    const machines = [{ machineId: "m", sessions: [
      { id: "s1", machineId: "m", cwd: "/r", model: "opus", status: "running" as const, lastTool: "Bash", tokens: 10 },
    ]}];
    expect(renderFleet(machines)).toContain("session-activity");
    // Bug A was meta and activity both `grid-column: 2` in the same auto row.
    expect(THEME_CSS_FOR_TEST).not.toMatch(/\.session-meta\s*\{[^}]*grid-column:\s*2;[^}]*\}[\s\S]*\.session-activity\s*\{[^}]*grid-column:\s*2;/);
    // Activity now carries an explicit grid-row so it stacks below meta.
    expect(THEME_CSS_FOR_TEST).toMatch(/\.session-activity\s*\{[^}]*grid-row:/);
  });
});

describe("renderFleet — grouped by project/cwd (session-grouping feature)", () => {
  it("groups a machine's sessions by cwd into collapsible project groups with counts", async () => {
    const { renderFleet } = await import("./render.js");
    const machines = [{ machineId: "m", sessions: [
      { id: "s1", machineId: "m", cwd: "/home/me/showcase/fleetview", model: "opus", status: "running" as const },
      { id: "s2", machineId: "m", cwd: "/home/me/showcase/fleetview", model: "opus", status: "done" as const },
      { id: "s3", machineId: "m", cwd: "/home/me/agentkit", model: "opus", status: "done" as const },
    ]}];
    const html = renderFleet(machines);
    expect(html).toContain("project-group");
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("fleetview");
    expect(html).toContain("agentkit");
    expect(html).toMatch(/data-group-key="\/home\/me\/showcase\/fleetview"[\s\S]*?project-count">2</);
    for (const id of ["s1", "s2", "s3"]) expect(html).toContain(id);
  });

  it("opens a group with an active session and collapses an all-done group", async () => {
    const { renderFleet } = await import("./render.js");
    const machines = [{ machineId: "m", sessions: [
      { id: "a", machineId: "m", cwd: "/proj/live", model: "opus", status: "running" as const },
      { id: "b", machineId: "m", cwd: "/proj/idle", model: "opus", status: "done" as const },
    ]}];
    const html = renderFleet(machines);
    expect(html).toMatch(/<details class="project-group" data-group-key="\/proj\/live" open>/);
    expect(html).toMatch(/<details class="project-group" data-group-key="\/proj\/idle">/);
  });

  it("labels an empty cwd group 'unknown' and escapes a hostile cwd", async () => {
    const { renderFleet } = await import("./render.js");
    const machines = [{ machineId: "m", sessions: [
      { id: "x", machineId: "m", cwd: "", model: "opus", status: "done" as const },
      { id: "y", machineId: "m", cwd: `"><img src=x>`, model: "opus", status: "done" as const },
    ]}];
    const html = renderFleet(machines);
    expect(html).toContain("unknown");
    expect(html).not.toContain(`"><img src=x>`);
  });
});
