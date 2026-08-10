// T3 spike: prove the `ws` server/client pair + JSON message framing work,
// before building the hub on it. Run: node scripts/spike-ws.mjs
import { WebSocketServer, WebSocket } from "ws";

const wss = new WebSocketServer({ port: 0 });
await new Promise((r) => wss.on("listening", r));
const port = wss.address().port;
console.log("server listening on", port);

wss.on("connection", (sock) => {
  sock.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    console.log("server got:", msg);
    if (msg.t === "hello") sock.send(JSON.stringify({ t: "ack", role: msg.role }));
  });
});

const client = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((r) => client.on("open", r));
client.send(JSON.stringify({ t: "hello", role: "node", machineId: "spike", token: "x" }));

const ack = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no ack in 2s")), 2000);
  client.on("message", (d) => {
    clearTimeout(timer);
    resolve(JSON.parse(d.toString()));
  });
});
console.log("client got ack:", ack);

client.close();
wss.close();
if (ack.t !== "ack" || ack.role !== "node") throw new Error("SPIKE FAIL");
console.log("SPIKE OK");
