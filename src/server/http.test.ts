import { describe, expect, it, afterEach } from "vitest";
import { join } from "node:path";
import { startDashboard, type Dashboard } from "./http.js";

let dash: Dashboard | undefined;
afterEach(async () => {
  await dash?.close();
  dash = undefined;
});

describe("dashboard http server", () => {
  it("serves the shell and EVERY browser-ESM module the client imports", async () => {
    dash = await startDashboard({ token: "t", port: 0, host: "127.0.0.1", webDir: join(process.cwd(), "dist", "web") });
    const base = `http://127.0.0.1:${dash.port}`;

    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<script type="module" src="/client.js">');

    // The client is unbundled: client.js imports ./render.js and ./diff.js.
    // All three must be served, or the module graph 404s and the app never boots.
    for (const mod of ["client.js", "render.js", "diff.js"]) {
      const r = await fetch(`${base}/${mod}`);
      expect(r.status, `${mod} should be served`).toBe(200);
      expect(r.headers.get("content-type")).toContain("javascript");
    }
  });

  it("404s an unknown module and rejects path traversal", async () => {
    dash = await startDashboard({ token: "t", port: 0, host: "127.0.0.1", webDir: join(process.cwd(), "dist", "web") });
    const base = `http://127.0.0.1:${dash.port}`;
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    // A traversal attempt must not match the basename-only route.
    expect((await fetch(`${base}/../server/http.js`)).status).toBe(404);
  });
});
