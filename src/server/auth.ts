// Token auth for node/browser connections. Shared bearer token (D3, A4):
// the server verifies `hello.token` against FLEETVIEW_TOKEN. A wrong/absent
// token closes the socket with a specific app-range code + reason and the
// connection is never registered.
import { timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { parseMessage, type WireMessage } from "../protocol.js";

// App-specific close code in the 4000-4999 range (RFC 6455 private use).
export const AUTH_FAIL_CODE = 4001;
export const AUTH_FAIL_REASON = "auth failed";

/** Constant-time string equality; false on length mismatch (never throws). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Fail-closed config check: the server must not run without a real token.
 * An unset or empty FLEETVIEW_TOKEN would otherwise let empty-token clients in.
 */
export function requireToken(value: string | undefined): string {
  if (!value) {
    throw new Error("FLEETVIEW_TOKEN must be set to a non-empty value (fail-closed).");
  }
  return value;
}

// Close code for a rejected cross-origin WebSocket (CSWSH mitigation).
export const BAD_ORIGIN_CODE = 4003;
export const BAD_ORIGIN_REASON = "bad origin";

/**
 * Cross-site WebSocket hijacking guard. A browser always sends an `Origin`
 * header; it must match the `Host` the request came in on (same-origin). A
 * non-browser client (the fleet-node `ws` client) sends no Origin — allowed,
 * because it still must pass the shared-token check. `Origin: null` (sandboxed
 * document) is rejected.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true; // non-browser client (node)
  if (origin === "null" || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** True iff `msg` is a well-formed hello whose token matches `expected`. */
export function verifyHello(msg: WireMessage, expected: string): boolean {
  // Fail closed: with no configured token, reject everything.
  if (!expected) return false;
  if (msg.t !== "hello") return false;
  if (msg.role === "node") return safeEqual(msg.token, expected);
  // Browser hellos are same-origin (D3/A4): a token is optional, but if
  // present it must still match. Browsing the dashboard requires reaching the
  // same-origin server; the token is the node-push credential.
  if (msg.role === "browser") return msg.token === undefined || safeEqual(msg.token, expected);
  return false;
}

/**
 * Wait for the first message on `sock`. If it is a valid hello with the right
 * token, call `onAuthed(machineId, role)`. Otherwise close with the auth-fail
 * code + reason and never register.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export function attachAuth(
  sock: WebSocket,
  expected: string,
  onAuthed: (machineId: string, role: "node" | "browser") => void,
  handshakeTimeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): void {
  // A client that connects but never sends a hello must not hold a slot forever
  // (DoS/leak). Close it if the handshake doesn't arrive in time.
  const timer = setTimeout(() => sock.close(AUTH_FAIL_CODE, AUTH_FAIL_REASON), handshakeTimeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  sock.once("message", (data: unknown) => {
    clearTimeout(timer);
    const msg = parseMessage(String(data));
    if (!msg || msg.t !== "hello" || !verifyHello(msg, expected)) {
      sock.close(AUTH_FAIL_CODE, AUTH_FAIL_REASON);
      return;
    }
    const machineId = msg.role === "node" ? msg.machineId : "browser";
    onAuthed(machineId, msg.role);
  });
}
