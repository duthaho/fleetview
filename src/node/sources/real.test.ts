import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSessions } from "./real.js";

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
