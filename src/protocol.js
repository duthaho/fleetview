// The full fleetview wire protocol — every direction, both connection roles.
// One WebSocket endpoint; the `hello.role` field routes node vs browser.
function isStr(v) {
    return typeof v === "string";
}
function isBool(v) {
    return typeof v === "boolean";
}
function isSession(v) {
    if (typeof v !== "object" || v === null)
        return false;
    const s = v;
    return (isStr(s.id) &&
        isStr(s.machineId) &&
        isStr(s.cwd) &&
        isStr(s.model) &&
        ["starting", "running", "awaiting-approval", "done", "aborted"].includes(s.status));
}
/** Parse a wire message. Returns the typed object, or null if malformed. */
export function parseMessage(raw) {
    let v;
    try {
        v = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof v !== "object" || v === null)
        return null;
    const m = v;
    switch (m.t) {
        case "hello":
            if (m.role === "node")
                return isStr(m.machineId) && isStr(m.token) ? m : null;
            if (m.role === "browser")
                return m.token === undefined || isStr(m.token) ? m : null;
            return null;
        case "sessions":
            return Array.isArray(m.sessions) && m.sessions.every(isSession) ? m : null;
        case "promptRaised":
            return isStr(m.promptId) && isStr(m.sessionId) && isStr(m.tool) && isStr(m.detail)
                ? m
                : null;
        case "artifact":
            return isStr(m.sessionId) && isStr(m.diff) ? m : null;
        case "promptResolved":
        case "decision":
            return isStr(m.promptId) && isBool(m.approve) ? m : null;
        case "snapshot":
            return Array.isArray(m.machines) ? m : null;
        case "patch":
            return Array.isArray(m.ops) ? m : null;
        default:
            return null;
    }
}
export function encode(msg) {
    return JSON.stringify(msg);
}
