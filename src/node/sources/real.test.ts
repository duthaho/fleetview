import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSessions, getSessionDetail, RealSource } from "./real.js";

function makeClaudeDir(): string {
  const base = mkdtempSync(join(tmpdir(), "fleetview-claude-"));
  mkdirSync(join(base, "projects", "-home-me-proj"), { recursive: true });
  return base;
}

function writeSession(base: string, slug: string, file: string, lines: object[]): string {
  const dir = join(base, "projects", slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("readClaudeSessions", () => {
  it("reads id + cwd + model + status from a real-shaped transcript", () => {
    const base = makeClaudeDir();
    writeSession(base, "-home-me-proj", "sess-1.jsonl", [
      { type: "user", sessionId: "sess-1", cwd: "/home/me/proj", timestamp: "2026-08-10T10:00:00Z" },
      { type: "assistant", sessionId: "sess-1", cwd: "/home/me/proj", message: { model: "claude-opus-5" } },
    ]);
    const sessions = readClaudeSessions(base, "alpha");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "sess-1",
      machineId: "alpha",
      cwd: "/home/me/proj",
      model: "claude-opus-5",
    });
    expect(["running", "done"]).toContain(sessions[0]!.status);
  });

  it("marks a recently-modified session running, an old one done", () => {
    const base = makeClaudeDir();
    const recent = writeSession(base, "-p", "recent.jsonl", [
      { type: "user", sessionId: "recent", cwd: "/p" },
    ]);
    const old = writeSession(base, "-p", "old.jsonl", [
      { type: "user", sessionId: "old", cwd: "/p" },
    ]);
    const longAgo = new Date(Date.now() - 3600_000);
    utimesSync(old, longAgo, longAgo);
    const byId = Object.fromEntries(readClaudeSessions(base, "m").map((s) => [s.id, s.status]));
    expect(byId["recent"]).toBe("running");
    expect(byId["old"]).toBe("done");
  });

  it("returns [] for a missing or empty base dir (A5)", () => {
    expect(readClaudeSessions(join(tmpdir(), "does-not-exist-fleetview"), "m")).toEqual([]);
    expect(readClaudeSessions(makeClaudeDir(), "m")).toEqual([]);
  });

  it("skips a malformed/truncated transcript without throwing (codex)", () => {
    const base = makeClaudeDir();
    writeSession(base, "-p", "good.jsonl", [{ type: "user", sessionId: "good", cwd: "/p" }]);
    // truncated JSON line + a totally non-JSON file
    writeFileSync(join(base, "projects", "-p", "bad.jsonl"), '{"type":"user","sessionId":"b\n');
    writeFileSync(join(base, "projects", "-p", "notjson.jsonl"), "\x00\x01 not json at all\n");
    const sessions = readClaudeSessions(base, "m");
    expect(sessions.map((s) => s.id)).toContain("good");
    // no throw; bad files contribute nothing usable
    expect(sessions.every((s) => typeof s.id === "string" && s.id.length > 0)).toBe(true);
  });

  it("tolerates an unexpected layout (a file where a project dir is expected)", () => {
    const base = mkdtempSync(join(tmpdir(), "fleetview-claude-"));
    mkdirSync(join(base, "projects"), { recursive: true });
    writeFileSync(join(base, "projects", "stray.txt"), "not a directory of sessions");
    expect(readClaudeSessions(base, "m")).toEqual([]);
  });
});

describe("readClaudeSessions — activity summary fields (T2, D1/D8)", () => {
  it("computes lastActivity, lastTool, messages, tokens, costUsd from a transcript", () => {
    const base = makeClaudeDir();
    writeSession(base, "-home-me-proj", "act.jsonl", [
      { type: "user", sessionId: "act", cwd: "/p", timestamp: "2026-08-10T10:00:00Z" },
      {
        type: "assistant",
        sessionId: "act",
        cwd: "/p",
        timestamp: "2026-08-10T10:00:01Z",
        message: {
          model: "claude-opus-5",
          content: [
            { type: "text", text: "hi there" },
            { type: "tool_use", name: "Bash" },
          ],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
        costUSD: 0.05,
      },
      {
        type: "assistant",
        sessionId: "act",
        cwd: "/p",
        timestamp: "2026-08-10T10:00:05Z",
        message: {
          model: "claude-opus-5",
          content: [{ type: "tool_use", name: "Edit" }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
        costUSD: 0.01,
      },
    ]);
    const s = readClaudeSessions(base, "m").find((x) => x.id === "act")!;
    expect(s.lastActivity).toBe("2026-08-10T10:00:05Z");
    expect(s.lastTool).toBe("Edit");
    expect(s.messages).toBe(3); // 1 user + 2 assistant
    expect(s.tokens).toBe(128); // 100+20+5+3
    expect(s.costUsd).toBeCloseTo(0.06);
  });

  it("a usage-less session → tokens/cost 0, lastTool empty", () => {
    const base = makeClaudeDir();
    writeSession(base, "-p", "nousage.jsonl", [
      { type: "user", sessionId: "nousage", cwd: "/p", timestamp: "2026-08-10T09:00:00Z" },
      { type: "assistant", sessionId: "nousage", cwd: "/p", message: { model: "m", content: "plain text" } },
    ]);
    const s = readClaudeSessions(base, "m").find((x) => x.id === "nousage")!;
    expect(s.tokens).toBe(0);
    expect(s.costUsd).toBe(0);
    expect(s.lastTool).toBe("");
    expect(s.messages).toBe(2);
  });

  it("skips malformed lines while still computing fields (codex)", () => {
    const base = makeClaudeDir();
    const path = writeSession(base, "-p", "mixed.jsonl", [
      { type: "user", sessionId: "mixed", cwd: "/p", timestamp: "2026-08-10T08:00:00Z" },
    ]);
    writeFileSync(path, JSON.stringify({ type: "user", sessionId: "mixed", cwd: "/p", timestamp: "2026-08-10T08:00:00Z" }) + "\n" + '{"broken\n' + JSON.stringify({ type: "assistant", sessionId: "mixed", cwd: "/p", timestamp: "2026-08-10T08:00:02Z", message: { model: "m", content: [{ type: "tool_use", name: "Grep" }], usage: { input_tokens: 7, output_tokens: 1 } } }) + "\n");
    const s = readClaudeSessions(base, "m").find((x) => x.id === "mixed")!;
    expect(s.lastTool).toBe("Grep");
    expect(s.tokens).toBe(8);
    expect(s.messages).toBe(2);
  });
});

describe("getSessionDetail (T3, D3/D8)", () => {
  it("returns the last ≤10 text/tool events, oldest→newest, text capped at 120", () => {
    const base = makeClaudeDir();
    const long = "x".repeat(200);
    const lines: object[] = [];
    // 12 assistant records → only the last 10 events kept
    for (let i = 0; i < 12; i++) {
      lines.push({
        type: "assistant",
        sessionId: "detail-1",
        cwd: "/p",
        timestamp: `2026-08-10T10:00:${String(i).padStart(2, "0")}Z`,
        message: { model: "m", content: [{ type: "text", text: `${i}-${long}` }] },
      });
    }
    lines.push({
      type: "assistant",
      sessionId: "detail-1",
      cwd: "/p",
      timestamp: "2026-08-10T10:01:00Z",
      message: { model: "m", content: [{ type: "tool_use", name: "Bash" }] },
    });
    writeSession(base, "-home-me-proj", "detail-1.jsonl", lines);
    const events = getSessionDetail(base, "detail-1");
    expect(events.length).toBe(10);
    // last event is the tool_use
    expect(events.at(-1)).toEqual({ kind: "tool", text: "Bash" });
    // text events capped at 120
    for (const e of events) {
      if (e.kind === "text") expect(e.text.length).toBeLessThanOrEqual(120);
    }
    // oldest→newest ordering: earlier index carries an earlier counter
    const firstText = events.find((e) => e.kind === "text")!;
    expect(firstText.text.startsWith("3-")).toBe(true); // events 3..11 text + tool = 10
  });

  it("locates a session whose file name differs from its id", () => {
    const base = makeClaudeDir();
    writeSession(base, "-p", "some-file.jsonl", [
      { type: "assistant", sessionId: "inner-id", cwd: "/p", message: { model: "m", content: [{ type: "text", text: "hello" }] } },
    ]);
    expect(getSessionDetail(base, "inner-id")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("unknown id → []", () => {
    const base = makeClaudeDir();
    writeSession(base, "-p", "a.jsonl", [{ type: "user", sessionId: "a", cwd: "/p" }]);
    expect(getSessionDetail(base, "nope")).toEqual([]);
  });

  it("rejects a path-like id with no filesystem access (traversal guard, codex)", () => {
    const base = makeClaudeDir();
    writeSession(base, "-p", "a.jsonl", [{ type: "user", sessionId: "a", cwd: "/p" }]);
    expect(getSessionDetail(base, "../foo")).toEqual([]);
    expect(getSessionDetail(base, "/etc/passwd")).toEqual([]);
    expect(getSessionDetail(base, "a/../../b")).toEqual([]);
  });

  it("never throws on a missing base dir", () => {
    expect(getSessionDetail(join(tmpdir(), "no-such-fleetview-dir"), "x")).toEqual([]);
  });
});

describe("RealSource.getDetail (T4, D4)", () => {
  it("returns the fixture events for a known session", async () => {
    const base = makeClaudeDir();
    writeSession(base, "-p", "gd-1.jsonl", [
      { type: "assistant", sessionId: "gd-1", cwd: "/p", message: { model: "m", content: [{ type: "text", text: "yo" }, { type: "tool_use", name: "Read" }] } },
    ]);
    const src = new RealSource("m", base);
    await expect(src.getDetail("gd-1")).resolves.toEqual([
      { kind: "text", text: "yo" },
      { kind: "tool", text: "Read" },
    ]);
  });

  it("an unknown id → []", async () => {
    const base = makeClaudeDir();
    const src = new RealSource("m", base);
    await expect(src.getDetail("nope")).resolves.toEqual([]);
  });
});

describe("real reader — future mtime guard (review fix)", () => {
  it("marks an implausibly future-dated transcript done, not running forever", () => {
    const base = makeClaudeDir();
    const p = writeSession(base, "-p", "future.jsonl", [{ type: "user", sessionId: "future", cwd: "/p" }]);
    const future = new Date(Date.now() + 3600_000);
    utimesSync(p, future, future);
    const s = readClaudeSessions(base, "m").find((x) => x.id === "future");
    expect(s!.status).toBe("done");
  });
});

describe("readClaudeSessions — recency filter (deploy feedback: 711→recent)", () => {
  it("with activeWithinMs, excludes sessions older than the window", () => {
    const base = makeClaudeDir();
    const fresh = writeSession(base, "-p", "fresh.jsonl", [{ type: "user", sessionId: "fresh", cwd: "/p" }]);
    const stale = writeSession(base, "-p", "stale.jsonl", [{ type: "user", sessionId: "stale", cwd: "/p" }]);
    const old = new Date(Date.now() - 48 * 3600_000); // 2 days ago
    utimesSync(stale, old, old);
    const ids = readClaudeSessions(base, "m", { activeWithinMs: 24 * 3600_000 }).map((s) => s.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("stale");
  });

  it("with limit, keeps only the most-recently-touched N, newest first", () => {
    const base = makeClaudeDir();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const p = writeSession(base, "-p", `s${i}.jsonl`, [{ type: "user", sessionId: `s${i}`, cwd: "/p" }]);
      const t = new Date(now - i * 1000); // s0 newest, s4 oldest
      utimesSync(p, t, t);
    }
    const ids = readClaudeSessions(base, "m", { limit: 3 }).map((s) => s.id);
    expect(ids).toEqual(["s0", "s1", "s2"]);
  });

  it("with no opts, still returns everything (faithful reader unchanged)", () => {
    const base = makeClaudeDir();
    writeSession(base, "-p", "a.jsonl", [{ type: "user", sessionId: "a", cwd: "/p" }]);
    writeSession(base, "-p", "b.jsonl", [{ type: "user", sessionId: "b", cwd: "/p" }]);
    expect(readClaudeSessions(base, "m").map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});
