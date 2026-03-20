# CodeShare Classroom

This repository contains:
- A VS Code extension (`/extension`) that prompts you to **Host session** or **Join session**
- A local Node.js WebSocket relay server (`/server`) that broadcasts full-document updates to all connected clients

## Folder layout
- `/extension` – VS Code extension (TypeScript)
- `/server` – WebSocket server (`ws`)

## Install

Open a terminal in the repo root (`CodeShare/`) and run:

```bash
cd /Users/blancoarnau/Documents/GitHub/CodeShare

# Install server deps
npm install --prefix server

# Install extension deps
npm install --prefix extension
```

## Run the server

In one terminal (host device), run:

```bash
npm start --prefix server
```

The server listens on `ws://localhost:3000` by default.

To use a different port:

```bash
PORT=4000 npm start --prefix server
```

## Run the extension (F5)

1. Open the repository in VS Code.
2. Open the Command Palette and choose `Debug: Start Debugging` (or press `F5`).
3. When the extension activates, choose:
   - **Host session** (host device), then provide a port (default `3000`)
   - **Join session** (student devices), then provide the host IP and port

## How collaboration works

- Only the **active editor** is synchronized.
- Each text change sends the **full document text** using:
  ```json
  { "type": "update", "content": "<full file text>" }
  ```
- Incoming updates replace the editor content.
- A guard flag (`isApplyingRemoteEdit`) prevents infinite edit loops.

## Notes / Troubleshooting

- Make sure all devices are on the same WiFi network and the host IP is reachable from students.
- For best results, have all students open the same file before/when updates begin.

