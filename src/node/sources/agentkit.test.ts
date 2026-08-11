import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentkitSource } from "./agentkit.js";
import type { Session } from "../../protocol.js";
import type { SourcePrompt } from "../source.js";

// A minimal in-process Unix-socket bridge standing in for agentkit.
class FakeBridge {
  readonly path: string;
  private server: Server;
  private clients: Socket[] = [];
  readonly received: unknown[] = [];

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), "fv-bridge-"));
    this.path = join(dir, "bridge.sock");
    this.server = createServer((sock) => {
      this.clients.push(sock);
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim() === "") continue;
          try {
            this.received.push(JSON.parse(line));
          } catch {
            /* ignore */
          }
        }
      });
      sock.on("error", () => {});
    });
  }

  listen(): Promise<void> {
    return new Promise((res) => this.server.listen(this.path, () => res()));
  }
  send(obj: unknown): void {
    const line = `${JSON.stringify(obj)}\n`;
    for (const c of this.clients) c.write(line);
  }
  sendRaw(line: string): void {
    for (const c of this.clients) c.write(line);
  }
  close(): Promise<void> {
    for (const c of this.clients) c.destroy();
    return new Promise((res) => this.server.close(() => res()));
  }
}

function collect(source: AgentkitSource) {
  const sessions: Session[][] = [];
  const prompts: SourcePrompt[] = [];
  source.onSessions((s) => sessions.push(s));
  source.onPrompt((p) => prompts.push(p));
  return { sessions, prompts };
}

const waitFor = async (pred: () => boolean, ms = 1000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

let bridges: FakeBridge[] = [];
let sources: AgentkitSource[] = [];
afterEach(async () => {
  for (const s of sources) s.stop();
  for (const b of bridges) await b.close();
  bridges = [];
  sources = [];
});

async function setup() {
  const bridge = new FakeBridge();
  bridges.push(bridge);
  await bridge.listen();
  const source = new AgentkitSource("box-1", bridge.path, { backoffMs: 5 });
  sources.push(source);
  const seen = collect(source);
  source.start();
  await waitFor(() => bridge["clients"].length > 0);
  return { bridge, source, seen };
}

describe("AgentkitSource over a real Unix socket bridge", () => {
  it("surfaces a prompt + awaiting-approval session on an escalation frame", async () => {
    const { bridge, seen } = await setup();
    bridge.send({
      t: "escalation",
      token: "7",
      toolName: "Bash",
      input: { command: "rm -rf /tmp/x" },
      cwd: "/repo/app",
      sessionId: "sess-abc",
    });

    await waitFor(() => seen.prompts.length > 0);
    expect(seen.prompts[0]).toMatchObject({
      promptId: "7",
      sessionId: "sess-abc",
      tool: "Bash",
    });
    expect(seen.prompts[0].detail).toContain("rm -rf /tmp/x");

    const last = seen.sessions.at(-1)!;
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({
      id: "sess-abc",
      machineId: "box-1",
      cwd: "/repo/app",
      model: "",
      status: "awaiting-approval",
    });
  });

  it("falls back to token as session id when sessionId is absent", async () => {
    const { bridge, seen } = await setup();
    bridge.send({ t: "escalation", token: "42", toolName: "Write", input: "hello", cwd: "/w" });
    await waitFor(() => seen.prompts.length > 0);
    expect(seen.prompts[0].sessionId).toBe("42");
    expect(seen.sessions.at(-1)![0].id).toBe("42");
  });

  it("bounds an oversized detail preview", async () => {
    const { bridge, seen } = await setup();
    const big = "x".repeat(5000);
    bridge.send({ t: "escalation", token: "1", toolName: "Bash", input: { command: big }, cwd: "" });
    await waitFor(() => seen.prompts.length > 0);
    expect(seen.prompts[0].detail.length).toBeLessThanOrEqual(520);
  });

  it("resolvePrompt sends a decide frame with allow:true", async () => {
    const { bridge, source } = await setup();
    bridge.send({ t: "escalation", token: "9", toolName: "Bash", input: "ls", cwd: "" });
    await waitFor(() => bridge["clients"].length > 0);
    source.resolvePrompt("9", true);
    await waitFor(() => bridge.received.length > 0);
    expect(bridge.received[0]).toEqual({ t: "decide", token: "9", allow: true });
  });

  it("resolvePrompt(false) sends allow:false", async () => {
    const { bridge, source } = await setup();
    source.resolvePrompt("3", false);
    await waitFor(() => bridge.received.length > 0);
    expect(bridge.received[0]).toEqual({ t: "decide", token: "3", allow: false });
  });

  it("a resolved frame clears the prompt/session", async () => {
    const { bridge, source, seen } = await setup();
    bridge.send({ t: "escalation", token: "5", toolName: "Bash", input: "ls", cwd: "/x" });
    await waitFor(() => seen.prompts.length > 0);
    expect(source.currentSessions()).toHaveLength(1);

    bridge.send({ t: "resolved", token: "5", allow: true });
    await waitFor(() => source.currentSessions().length === 0);
    expect(seen.sessions.at(-1)).toEqual([]);
  });

  it("does not crash on a malformed line", async () => {
    const { bridge, seen } = await setup();
    bridge.sendRaw("this is not json\n");
    bridge.send({ t: "escalation", token: "8", toolName: "Bash", input: "ok", cwd: "" });
    await waitFor(() => seen.prompts.length > 0);
    expect(seen.prompts[0].promptId).toBe("8");
  });

  it("retries the connection until the bridge is up", async () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    const source = new AgentkitSource("box-2", bridge.path, { backoffMs: 5 });
    sources.push(source);
    const seen = collect(source);
    source.start(); // connect before the server exists → should retry
    await new Promise((r) => setTimeout(r, 20));
    await bridge.listen();
    await waitFor(() => bridge["clients"].length > 0, 2000);
    bridge.send({ t: "escalation", token: "1", toolName: "Bash", input: "x", cwd: "" });
    await waitFor(() => seen.prompts.length > 0, 2000);
    expect(seen.prompts[0].promptId).toBe("1");
  });
});

describe("AgentkitSource — external resolution clears the prompt (review HIGH fix)", () => {
  it("fires onPromptResolved when the bridge broadcasts a resolved frame", async () => {
    const { bridge, source, seen } = await setup();
    const resolved: Array<{ token: string; approve: boolean }> = [];
    source.onPromptResolved((token, approve) => resolved.push({ token, approve }));
    bridge.send({ t: "escalation", token: "tk1", toolName: "Bash", input: { command: "x" }, cwd: "/c", sessionId: "s1" });
    await waitFor(() => seen.prompts.some((p) => p.promptId === "tk1"));
    // external resolution (e.g. a Telegram tap), NOT via the dashboard
    bridge.send({ t: "resolved", token: "tk1", allow: false });
    await waitFor(() => resolved.length === 1);
    expect(resolved[0]).toEqual({ token: "tk1", approve: false });
  });
});
