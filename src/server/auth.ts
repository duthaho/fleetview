// Token auth for node/browser connections. Shared bearer token (D3, A4):
// the server verifies `hello.token` against FLEETVIEW_TOKEN. A wrong/absent
// token closes the socket with a specific app-range code + reason and the
// connection is never registered.
import type { WebSocket } from "ws";
import { parseMessage, type WireMessage } from "../protocol.js";

// App-specific close code in the 4000-4999 range (RFC 6455 private use).
export const AUTH_FAIL_CODE = 4001;
export const AUTH_FAIL_REASON = "auth failed";

/** True iff `msg` is a well-formed hello whose token matches `expected`. */
export function verifyHello(msg: WireMessage, expected: string): boolean {
  if (msg.t !== "hello") return false;
  if (msg.role === "node") return msg.token === expected;
  // Browser hellos are same-origin; a token, if present, must still match.
  if (msg.role === "browser") return msg.token === undefined || msg.token === expected;
  return false;
}

/**
 * Wait for the first message on `sock`. If it is a valid hello with the right
 * token, call `onAuthed(machineId, role)`. Otherwise close with the auth-fail
 * code + reason and never register.
 */
export function attachAuth(
  sock: WebSocket,
  expected: string,
  onAuthed: (machineId: string, role: "node" | "browser") => void,
): void {
  sock.once("message", (data: unknown) => {
    const msg = parseMessage(String(data));
    if (!msg || msg.t !== "hello" || !verifyHello(msg, expected)) {
      sock.close(AUTH_FAIL_CODE, AUTH_FAIL_REASON);
      return;
    }
    const machineId = msg.role === "node" ? msg.machineId : "browser";
    onAuthed(machineId, msg.role);
  });
}
