import * as vscode from "vscode";
import WebSocket from "ws";
import path from "path";
import { spawn, ChildProcess } from "child_process";

type SessionRole = "host" | "join";

type IncomingMessage =
  | { type: "update"; content: string }
  | { type: string; [key: string]: unknown };

class CodeShareSession {
  private role: SessionRole | null = null;
  private port: number | null = null;
  private hostIp: string | null = null;

  private ws: WebSocket | null = null;
  private hostProcess: ChildProcess | null = null;

  private targetUri: vscode.Uri | null = null;
  private pendingRemoteText: string | null = null;

  private isApplyingRemoteEdit = false;
  private debounceTimer: NodeJS.Timeout | null = null;

  private statusBarItem: vscode.StatusBarItem;

  private textChangeDisposable: vscode.Disposable | null = null;
  private activeEditorDisposable: vscode.Disposable | null = null;

  constructor(statusBarItem: vscode.StatusBarItem) {
    this.statusBarItem = statusBarItem;
    this.setStatusDisconnected("Not connected");
  }

  public isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  public async startHost(context: vscode.ExtensionContext, port: number): Promise<void> {
    if (this.isConnected()) {
      vscode.window.showInformationMessage("CodeShare: Already connected.");
      return;
    }

    this.cleanupConnectionOnly();

    this.role = "host";
    this.port = port;
    this.hostIp = null;

    this.killHostProcess(); // ensure only one server process

    // Start local server from repo root: ../server/server.js
    const serverJsPath = path.join(context.extensionPath, "..", "server", "server.js");
    const serverDir = path.join(context.extensionPath, "..", "server");
    this.statusBarItem.text = `CodeShare: Starting server on port ${port}...`;
    this.statusBarItem.show();

    this.hostProcess = spawn(process.execPath, [serverJsPath], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port) }
    });

    this.hostProcess.stdout?.on("data", (chunk: Buffer) => {
      // Keep output minimal in classroom settings
      const line = chunk.toString().trim();
      if (line.length) {
        // eslint-disable-next-line no-console
        console.log(`[CodeShare server] ${line}`);
      }
    });
    this.hostProcess.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line.length) {
        // eslint-disable-next-line no-console
        console.error(`[CodeShare server] ${line}`);
      }
    });

    const url = `ws://localhost:${port}`;
    await this.connect(url, context, true);
  }

  public async join(
    context: vscode.ExtensionContext,
    hostIp: string,
    port: number
  ): Promise<void> {
    if (this.isConnected()) {
      vscode.window.showInformationMessage("CodeShare: Already connected.");
      return;
    }

    this.cleanupConnectionOnly();

    this.role = "join";
    this.port = port;
    this.hostIp = hostIp;

    const url = `ws://${hostIp}:${port}`;
    this.statusBarItem.text = `CodeShare: Joining ${hostIp}:${port}...`;
    this.statusBarItem.show();

    await this.connect(url, context, false);
  }

  public disconnect(): void {
    this.cleanupConnectionOnly();
    this.killHostProcess();

    this.role = null;
    this.port = null;
    this.hostIp = null;
    this.targetUri = null;
    this.pendingRemoteText = null;
    this.isApplyingRemoteEdit = false;

    this.setStatusDisconnected("Disconnected");
  }

  public initializeDocumentListeners(context: vscode.ExtensionContext): void {
    if (this.textChangeDisposable || this.activeEditorDisposable) return;

    this.textChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      // Only send updates for the currently targeted document.
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.isApplyingRemoteEdit) return;
      if (this.targetUri && event.document.uri.toString() !== this.targetUri.toString()) return;

      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document.uri.toString() !== event.document.uri.toString()) return;

      const currentText = event.document.getText();

      // Debounce a little to avoid spamming on rapid typing.
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        try {
          this.ws?.send(JSON.stringify({ type: "update", content: currentText }));
        } catch {
          // Ignore transient websocket errors.
        }
      }, 150);
    });

    this.activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      if (this.pendingRemoteText && (!this.targetUri || editor.document.uri.toString() === this.targetUri.toString())) {
        // Apply the latest remote content when the user opens/switches to the targeted document.
        void this.applyRemoteTextToEditor(editor, this.pendingRemoteText);
        this.pendingRemoteText = null;
      }
    });

    context.subscriptions.push(this.textChangeDisposable, this.activeEditorDisposable);
  }

  private setStatusDisconnected(reason: string): void {
    this.statusBarItem.text = `CodeShare: ${reason}`;
    this.statusBarItem.show();
  }

  private setStatusConnected(): void {
    const filePart =
      this.targetUri ? `Editing: ${path.basename(this.targetUri.fsPath)}` : "No file selected yet";
    const rolePart = this.role === "host" ? "Host" : "Client";
    const endpoint =
      this.role === "host"
        ? `localhost:${this.port ?? ""}`
        : `${this.hostIp ?? ""}:${this.port ?? ""}`;

    this.statusBarItem.text = `CodeShare: Connected (${rolePart}) @ ${endpoint} | ${filePart}`;
    this.statusBarItem.show();
  }

  private async connect(
    url: string,
    context: vscode.ExtensionContext,
    isHost: boolean
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    this.targetUri = editor ? editor.document.uri : null;

    const ws = await this.connectWithRetry(url, 20, 300);
    this.ws = ws;

    ws.on("message", async (data) => {
      let parsed: IncomingMessage | null = null;
      try {
        parsed = JSON.parse(data.toString()) as IncomingMessage;
      } catch {
        return;
      }

      if (!parsed || parsed.type !== "update" || typeof (parsed as any).content !== "string") return;
      const content = (parsed as any).content as string;

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        this.pendingRemoteText = content;
        return;
      }

      // If we don't have a target yet, set it based on current editor.
      if (!this.targetUri) this.targetUri = activeEditor.document.uri;

      if (activeEditor.document.uri.toString() !== this.targetUri.toString()) {
        // Target mismatch; store latest content so we can apply if/when user switches.
        this.pendingRemoteText = content;
        return;
      }

      await this.applyRemoteTextToEditor(activeEditor, content);
    });

    ws.on("close", () => {
      // Server may have been stopped.
      if (this.ws === ws) {
        this.ws = null;
        this.setStatusDisconnected("Disconnected (server closed)");
      }
    });

    ws.on("error", () => {
      // errors are followed by close in ws, but keep UI clean.
      this.setStatusDisconnected("Connection error");
    });

    this.initializeDocumentListeners(context);
    this.setStatusConnected();

    // Host immediately sends the current file so joining clients sync.
    if (isHost && this.targetUri) {
      const editorToSend = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.targetUri?.toString());
      const text = editorToSend ? editorToSend.document.getText() : (await vscode.workspace.openTextDocument(this.targetUri)).getText();
      ws.send(JSON.stringify({ type: "update", content: text }));
    }
  }

  private async connectWithRetry(url: string, attempts: number, delayMs: number): Promise<WebSocket> {
    let lastErr: unknown = null;

    for (let i = 0; i < attempts; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const ws = await this.tryConnectOnce(url, 1000);
        return ws;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw lastErr ?? new Error("Failed to connect");
  }

  private tryConnectOnce(url: string, timeoutMs: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);

      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new Error(`Timeout connecting to ${url}`));
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        resolve(ws);
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(err);
      });
    });
  }

  private async applyRemoteTextToEditor(
    editor: vscode.TextEditor,
    newText: string
  ): Promise<void> {
    if (this.isApplyingRemoteEdit) return;

    this.isApplyingRemoteEdit = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    try {
      const doc = editor.document;
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );

      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, fullRange, newText);

      // Apply edit atomically; triggers onDidChangeTextDocument but is guarded by the flag.
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.isApplyingRemoteEdit = false;
    }
  }

  private cleanupConnectionOnly(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private killHostProcess(): void {
    if (this.hostProcess) {
      try {
        this.hostProcess.kill();
      } catch {
        // ignore
      }
      this.hostProcess = null;
    }
  }
}

function parsePort(input: string | undefined): number | null {
  if (!input) return null;
  const n = Number(input);
  if (Number.isFinite(n) && n > 0 && n < 65536) return Math.floor(n);
  return null;
}

function isLikelyIpv4(ip: string): boolean {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d+$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

let activeSession: CodeShareSession | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  context.subscriptions.push(statusBarItem);

  const session = new CodeShareSession(statusBarItem);
  activeSession = session;

  context.subscriptions.push(
    vscode.commands.registerCommand("codeshare.startHost", async () => {
      const port = await promptForPort();
      if (!port) return;
      await session.startHost(context, port);
    }),
    vscode.commands.registerCommand("codeshare.join", async () => {
      const ip = await promptForHostIp();
      if (!ip) return;
      const port = await promptForPort();
      if (!port) return;
      await session.join(context, ip, port);
    }),
    vscode.commands.registerCommand("codeshare.disconnect", () => {
      session.disconnect();
    })
  );

  const pick = await vscode.window.showQuickPick(["Host session", "Join session"], {
    placeHolder: "CodeShare: Choose how to collaborate"
  });

  if (pick === "Host session") {
    const port = await promptForPort(3000);
    if (!port) return;
    await session.startHost(context, port);
  } else if (pick === "Join session") {
    const ip = await promptForHostIp();
    if (!ip) return;
    const port = await promptForPort(3000);
    if (!port) return;
    await session.join(context, ip, port);
  }

  // Ensure we apply remote content when the user already has a file open.
  session.initializeDocumentListeners(context);
}

export function deactivate(): void {
  // VS Code calls this on shutdown; ensure we stop server processes we started.
  activeSession?.disconnect();
  activeSession = null;
}

async function promptForPort(defaultValue = 3000): Promise<number | null> {
  const raw = await vscode.window.showInputBox({
    prompt: "CodeShare: Port for WebSocket server",
    value: String(defaultValue),
    validateInput: (value) => (parsePort(value) ? "" : "Enter a valid port (1-65535).")
  });
  return parsePort(raw ?? undefined);
}

async function promptForHostIp(): Promise<string | null> {
  const raw = await vscode.window.showInputBox({
    prompt: "CodeShare: Host IP address on the local WiFi network",
    placeHolder: "e.g., 192.168.1.42",
    validateInput: (value) => {
      if (value.trim().length === 0) return "IP address is required.";
      return isLikelyIpv4(value) ? "" : "Enter a valid IPv4 address (e.g., 192.168.1.42).";
    }
  });
  if (!raw) return null;
  return raw.trim();
}

