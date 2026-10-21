// Connects MCP server processes to the Claude Connector browser extension.
//
// The first server process to start becomes the "hub": it listens on
// 127.0.0.1:<port> and the extension connects to it. If the port is already
// taken by another Claude Connector server (say Claude Desktop and Claude Code are both
// running), this process becomes a "peer" and relays its requests through the
// hub. When the hub exits, a peer takes over.
//
// Security: the listener binds to loopback only, checks the Host header, and
// only accepts
//   * /extension from a browser-extension origin, and
//   * /peer from non-browser clients (no Origin header).
// Web pages always send an http(s) Origin, so they can never connect.

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const EXTENSION_ORIGIN = /^(chrome-extension|extension):\/\/([a-p]{32})$/;

export const NOT_CONNECTED =
  'The Claude Connector extension is not connected. Check that Microsoft Edge is open, the Claude Connector extension is ' +
  'installed and enabled, and its popup says "Connected".';

export class Bridge {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {string} opts.version   server version, sent to the extension
   * @param {string[]} [opts.allowedExtensionIds]  if set, only these extension ids may connect
   * @param {number} [opts.connectWaitMs]  how long a request waits for the extension to connect
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ port, version, allowedExtensionIds = [], connectWaitMs = 15000, log = () => {} }) {
    this.port = port;
    this.connectWaitMs = connectWaitMs;
    this.version = version;
    this.allowedExtensionIds = allowedExtensionIds;
    this.log = log;
    this.role = null; // 'hub' | 'peer' | null while (re)connecting
    this.clientName = null; // name of the MCP client using this process
    this.extension = null; // hub: the extension socket
    this.extensionInfo = null;
    this.peers = new Map(); // hub: socket -> client name
    this.hubSocket = null; // peer: socket to the hub
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.nextId = 1;
    this.closed = false;
    this.httpServer = null;
    this.wss = null;
  }

  async start() {
    await this.#becomeHubOrPeer();
  }

  async close() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Claude Connector server is shutting down.'));
    }
    this.pending.clear();
    this.hubSocket?.close();
    this.extension?.close();
    for (const ws of this.peers.keys()) ws.close();
    if (this.wss) this.wss.close();
    if (this.httpServer) await new Promise((r) => this.httpServer.close(() => r()));
  }

  /** Tell the bridge which MCP client this process serves (shown in the extension popup). */
  setClientName(name) {
    this.clientName = name;
    if (this.role === 'hub') this.#sendClients();
    else if (this.role === 'peer') this.#send(this.hubSocket, { type: 'hello', clientName: name });
  }

  get extensionConnected() {
    return this.role === 'hub' ? !!this.extension : null;
  }

  /**
   * Send a request to the extension and wait for its answer.
   * Waits a little for the extension to (re)connect before giving up, because
   * Edge may have put its service worker to sleep.
   */
  async request(method, params = {}, { timeoutMs = 60000, connectWaitMs = this.connectWaitMs } = {}) {
    const deadline = Date.now() + connectWaitMs;
    while (!this.closed) {
      if (this.role === 'hub' && this.extension) return this.#call(this.extension, method, params, timeoutMs);
      if (this.role === 'peer' && this.hubSocket?.readyState === WebSocket.OPEN) {
        return this.#call(this.hubSocket, method, params, timeoutMs);
      }
      if (Date.now() > deadline) throw new Error(NOT_CONNECTED);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('Claude Connector server is shutting down.');
  }

  // -------------------------------------------------------------------------

  /** `client` is the AI app the request comes from; the extension shows it on the page and tab group. */
  #call(socket, method, params, timeoutMs, client = this.clientName) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer within ${Math.round(timeoutMs / 1000)}s (${method}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket });
      this.#send(socket, { type: 'request', id, method, params, client });
    });
  }

  #settle(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || 'Unknown error from the browser'));
    else p.resolve(msg.result);
  }

  #failPendingOn(socket, reason) {
    for (const [id, p] of this.pending) {
      if (p.socket !== socket) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  #send(socket, msg) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  async #becomeHubOrPeer() {
    if (this.closed) return;
    try {
      await this.#listen();
      this.role = 'hub';
      this.log(`listening on 127.0.0.1:${this.port} (hub)`);
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      await this.#connectAsPeer();
    }
  }

  #retryLater(ms = 500 + Math.random() * 500) {
    if (this.closed) return;
    setTimeout(() => this.#becomeHubOrPeer().catch((e) => this.log(`reconnect failed: ${e.message}`)), ms);
  }

  // ---- hub ----------------------------------------------------------------

  #listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name: 'claude-edge-connector', version: this.version, extensionConnected: !!this.extension }));
          return;
        }
        res.writeHead(404).end();
      });
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (err) => this.log(`server error: ${err.message}`));
        // Attach the WebSocket server only once we own the port; otherwise it
        // re-emits EADDRINUSE as an unhandled 'error' and crashes the process.
        const wss = new WebSocketServer({ server, verifyClient: (info, cb) => this.#verify(info, cb) });
        wss.on('error', (err) => this.log(`websocket error: ${err.message}`));
        wss.on('connection', (ws, req) => {
          const path = new URL(req.url, 'http://localhost').pathname;
          if (path === '/extension') this.#onExtension(ws);
          else this.#onPeer(ws);
        });
        this.httpServer = server;
        this.wss = wss;
        resolve();
      });
    });
  }

  #verify({ origin, req }, cb) {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return cb(false, 403);
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/extension') {
      const m = EXTENSION_ORIGIN.exec(origin || '');
      if (!m) return cb(false, 403);
      if (this.allowedExtensionIds.length && !this.allowedExtensionIds.includes(m[2])) {
        this.log(`rejected extension ${m[2]} (not in EDGE_CONNECTOR_EXTENSION_IDS)`);
        return cb(false, 403);
      }
      return cb(true);
    }
    if (path === '/peer') return origin ? cb(false, 403) : cb(true);
    return cb(false, 404);
  }

  #onExtension(ws) {
    if (this.extension) {
      // A newer connection (e.g. after the service worker restarted) wins.
      this.extension.close(4000, 'replaced');
    }
    this.extension = ws;
    this.log('extension connected');
    this.#send(ws, { type: 'welcome', serverVersion: this.version });
    this.#sendClients();
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        this.extensionInfo = { version: msg.version, browser: msg.browser };
        this.log(`extension ${msg.version} in ${msg.browser}`);
      } else if (msg.type === 'ping') {
        this.#send(ws, { type: 'pong' });
      } else if (msg.type === 'response') {
        this.#settle(msg);
      }
    });
    ws.on('close', () => {
      if (this.extension !== ws) return;
      this.extension = null;
      this.extensionInfo = null;
      this.log('extension disconnected');
      this.#failPendingOn(ws, 'The Claude Connector extension disconnected while handling the request.');
    });
  }

  #onPeer(ws) {
    this.peers.set(ws, null);
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        this.peers.set(ws, msg.clientName || null);
        this.#sendClients();
        return;
      }
      if (msg.type !== 'request') return;
      try {
        if (!this.extension) throw new Error(NOT_CONNECTED);
        const client = this.peers.get(ws) || msg.client || null;
        const result = await this.#call(this.extension, msg.method, msg.params, msg.timeoutMs || 60000, client);
        this.#send(ws, { type: 'response', id: msg.id, result });
      } catch (e) {
        this.#send(ws, { type: 'response', id: msg.id, error: { message: e.message } });
      }
    });
    ws.on('close', () => {
      this.peers.delete(ws);
      this.#sendClients();
    });
  }

  #sendClients() {
    const names = [this.clientName, ...this.peers.values()].filter(Boolean);
    this.#send(this.extension, { type: 'clients', clients: [...new Set(names)] });
  }

  // ---- peer ---------------------------------------------------------------

  #connectAsPeer() {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/peer`);
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.role = 'peer';
        this.hubSocket = ws;
        this.log(`port ${this.port} is in use by another Claude Connector server; relaying through it (peer)`);
        if (this.clientName) this.#send(ws, { type: 'hello', clientName: this.clientName });
        resolve();
      });
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.type === 'response') this.#settle(msg);
      });
      ws.on('unexpected-response', (_req, res) => {
        this.log(`port ${this.port} is used by something that is not Claude Connector (HTTP ${res.statusCode}). Set EDGE_CONNECTOR_PORT to a free port.`);
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        if (this.hubSocket === ws) {
          this.hubSocket = null;
          this.role = null;
          this.#failPendingOn(ws, 'Lost the connection to the Claude Connector hub; please retry.');
          this.log('hub went away; taking over or reconnecting');
        }
        if (!opened) resolve();
        this.#retryLater(opened ? undefined : 2000);
      });
    });
  }
}
