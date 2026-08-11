// HTTP dashboard server (D4). Serves the HTML shell (with the #app mount, the
// inlined terminal-theme CSS, and the module client script) and the tsc-built
// browser client at /client.js. It ATTACHES the ws Hub on the SAME http server,
// so the browser opens its WebSocket same-origin (D3). No framework, no bundler.
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderShell } from "../web/render.js";
import { Hub } from "./hub.js";

// dist/server/http.js → dist/web/ (both under dist/ after tsc build).
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..", "web");

export interface DashboardOptions {
  token: string;
  port?: number;
  /** Bind address. Default 127.0.0.1 (safe); set to 0.0.0.0 to expose the
   * fleet server to remote nodes — do so behind a firewall (network-exposure). */
  host?: string;
  /** Dir the browser-ESM modules are served from. Defaults to the built
   * dist/web next to this file; overridable for tests. */
  webDir?: string;
}

export interface Dashboard {
  server: Server;
  hub: Hub;
  port: number;
  close(): Promise<void>;
}

/** Build (but don't start) the http server + attached hub. */
export function createDashboard(token: string, webDir: string = WEB_DIR): { server: Server; hub: Hub } {
  const shell = renderShell();
  const hub = new Hub({ token });

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(shell);
      return;
    }
    // Serve any browser-ESM module from dist/web. The client is unbundled, so
    // client.js imports ./render.js and ./diff.js — all must be reachable, not
    // just /client.js. Basename-only lookup (no subpaths) blocks path traversal.
    if (url === "/favicon.ico") {
      res.writeHead(204); // no favicon; answer cleanly so the console stays quiet
      res.end();
      return;
    }
    const jsMatch = /^\/([a-z0-9_-]+\.js)$/i.exec(url);
    if (jsMatch) {
      readFile(join(webDir, jsMatch[1]!))
        .then((buf) => {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end(`${jsMatch[1]} not built — run \`npm run build\``);
        });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  hub.attach(server);
  return { server, hub };
}

/** Start the dashboard (http + ws hub) and resolve once listening. */
export function startDashboard(opts: DashboardOptions): Promise<Dashboard> {
  const { server, hub } = createDashboard(opts.token, opts.webDir);
  const port = opts.port ?? 4300;
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        hub,
        port: boundPort,
        close: () =>
          hub.close().then(() => new Promise<void>((r) => server.close(() => r()))),
      });
    });
  });
}
