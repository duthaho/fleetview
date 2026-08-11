# Deploying fleetview

Run the server + a node as `systemd` services on one box, expose the dashboard
with a Cloudflare Tunnel, and gate humans with Cloudflare Access.

## 1. systemd (server + node)

```bash
# from the repo (already built: npm ci && npm run build)
sudo cp deploy/fleetview.env.example /etc/fleetview.env
sudo sed -i "s/replace-with-a-long-random-secret/$(openssl rand -hex 24)/" /etc/fleetview.env
sudo chmod 600 /etc/fleetview.env

sudo cp deploy/systemd/fleetview-*.service /etc/systemd/system/
# edit User=, WorkingDirectory=, node path if yours differ
sudo systemctl daemon-reload
sudo systemctl enable --now fleetview-server fleetview-node

systemctl status fleetview-server fleetview-node
journalctl -u fleetview-server -f
```

The server binds `127.0.0.1:4300`; the node reads this host's `~/.claude`
read-only and dials the local server. Nothing is public yet.

## 2. Tunnel (you do this manually)

A **named** tunnel on a domain you control (quick `trycloudflare.com` tunnels
can't have Access). Point the tunnel's ingress at `http://127.0.0.1:4300`. The
same-origin guard passes because cloudflared preserves the `Host` header.

## 3. Cloudflare Access — gate humans at the edge

Access is **Cloudflare-side config, not fleetview code.** In the Zero Trust
dashboard:

1. **Access → Applications → Add → Self-hosted**, hostname = your tunnel
   hostname (e.g. `fleet.example.com`).
2. Add a **policy**: Allow → your email (or a Google/GitHub group). Everyone
   else is challenged to log in before a single byte reaches fleetview.
3. Save. Now the dashboard requires SSO.

**Why your node is unaffected:** the node connects to `ws://127.0.0.1:4300`
locally, never through the tunnel — so Access gates only the browser dashboard.
(If you later run a *remote* node through the tunnel, give it an Access
**service token** and send the `CF-Access-Client-Id` / `CF-Access-Client-Secret`
headers, or route node traffic to a hostname without an Access policy.)

## 4. Defense-in-depth (optional) — verify the Access JWT at the origin

Access at the edge is the gate; verifying its JWT **inside** fleetview means a
request that skips the edge (direct-to-origin, or a misconfigured policy) is
still rejected. Set in `/etc/fleetview.env`:

```
FLEETVIEW_ACCESS_TEAM=your-team.cloudflareaccess.com
FLEETVIEW_ACCESS_AUD=<application audience tag>
```

When set, the server validates the `Cf-Access-Jwt-Assertion` header on browser
requests against your team's JWKS. Unset = skipped (local/dev). *(This code
path is implemented separately — see the app's Access-verification module.)*
