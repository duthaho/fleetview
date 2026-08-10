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

// dist/server/http.js → dist/web/client.js (both under dist/ after tsc build).
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_JS_PATH = join(HERE, "..", "web", "client.js");

export interface DashboardOptions {
  token: string;
  port?: number;
}

export interface Dashboard {
  server: Server;
  hub: Hub;
  port: number;
  close(): Promise<void>;
}

/** Build (but don't start) the http server + attached hub. */
export function createDashboard(token: string): { server: Server; hub: Hub } {
  const shell = renderShell();
  const hub = new Hub({ token });

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(shell);
      return;
    }
    if (url === "/client.js") {
      readFile(CLIENT_JS_PATH)
        .then((buf) => {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("client.js not built — run `npm run build`");
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
  const { server, hub } = createDashboard(opts.token);
  const port = opts.port ?? 4300;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
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
