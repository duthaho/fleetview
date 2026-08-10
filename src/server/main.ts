// fleetview-server entry point (D1, D3). Reads the shared bearer token via
// requireToken(FLEETVIEW_TOKEN) — FAIL-CLOSED: the server refuses to start
// without a real token (the auth-hardening fix). Port from PORT (default 4300).
// Starts the http dashboard with the ws Hub attached on the same origin.
import { requireToken } from "./auth.js";
import { startDashboard } from "./http.js";

async function main(): Promise<void> {
  const token = requireToken(process.env.FLEETVIEW_TOKEN);
  const port = Number(process.env.PORT ?? 4300);
  const dash = await startDashboard({ token, port });
  console.log(`fleetview-server listening on http://127.0.0.1:${dash.port}`);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
