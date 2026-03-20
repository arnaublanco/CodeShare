const WebSocket = require("ws");

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const wss = new WebSocket.Server({ port });
const clients = new Set();

console.log(`[CodeShare server] Listening on ws://localhost:${port}`);

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[CodeShare server] Client connected. Total: ${clients.size}`);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // MVP protocol: only broadcast full-document updates.
    if (!msg || msg.type !== "update" || typeof msg.content !== "string") return;

    for (const client of clients) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify({ type: "update", content: msg.content }));
        } catch {
          // ignore transient send errors
        }
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[CodeShare server] Client disconnected. Total: ${clients.size}`);
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

