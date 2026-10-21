// End-to-end tests of the MCP server and its WebSocket bridge, with a fake
// extension standing in for Edge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'index.js');
const EXT_ORIGIN = `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startClient(port, name, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, EDGE_CONNECTOR_PORT: String(port), EDGE_CONNECTOR_CONNECT_WAIT_MS: '1500', ...extraEnv },
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** A fake extension that answers bridge requests from a handler map. */
function fakeExtension(port, handlers, { origin = EXT_ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
    const ext = { ws, clients: [], requests: [] };
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', version: 'test', browser: 'Microsoft Edge 141' }));
      resolve(ext);
    });
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('message', async (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'clients') ext.clients = msg.clients;
      if (msg.type !== 'request') return;
      ext.requests.push(msg);
      try {
        const h = handlers[msg.method];
        if (!h) throw new Error(`no fake handler for ${msg.method}`);
        ws.send(JSON.stringify({ type: 'response', id: msg.id, result: await h(msg.params) }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'response', id: msg.id, error: { message: e.message } }));
      }
    });
  });
}

function rawConnect(port, pathname, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', (e) => resolve(e.message));
  });
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
};

const text = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const handlers = {
  list_tabs: () => ({
    browser: 'Microsoft Edge 141',
    allowOpenTabs: true,
    tabs: [{ id: 7, title: 'Inbox', url: 'https://mail.example.com/', active: true, current: true }],
  }),
  snapshot: (p) => ({ tabId: p.tabId ?? 7, snapshot: 'Title: Inbox\n[1] button "Compose"' }),
  click: (p) => ({
    tabId: 7, message: `Clicked ref ${p.ref}.`, title: 'Inbox', url: 'https://mail.example.com/', snapshot: '[1] button "Send"',
  }),
  screenshot: () => ({ tabId: 7, title: 'Inbox', url: 'https://mail.example.com/', data: 'AAAA', mimeType: 'image/jpeg', width: 10, height: 10 }),
  get_text: () => ({ tabId: 7, title: 'Inbox', url: 'https://mail.example.com/', text: 'hello', total: 9, nextOffset: 5 }),
  type: () => {
    throw new Error('The user has blocked Claude Connector on mybank.com.');
  },
};

test('tools round-trip through the bridge to the extension', async () => {
  const port = await freePort();
  const client = await startClient(port, 'claude-ai');
  try {
    const ext = await fakeExtension(port, handlers);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      'browser_click', 'browser_close_tab', 'browser_get_text', 'browser_navigate', 'browser_open_tab',
      'browser_press_key', 'browser_screenshot', 'browser_scroll', 'browser_select_option', 'browser_snapshot',
      'browser_tabs', 'browser_type', 'browser_wait',
    ]);

    assert.match(text(await client.callTool({ name: 'browser_tabs', arguments: {} })), /id 7 \(current\) \(visible\): Inbox/);

    const clicked = text(await client.callTool({ name: 'browser_click', arguments: { ref: 3, tab_id: 7 } }));
    assert.match(clicked, /Clicked ref 3\./);
    assert.match(clicked, /untrusted web data/, 'page content is labelled untrusted');
    assert.deepEqual(ext.requests.at(-1).params, { tabId: 7, ref: 3 }, 'snake_case args become camelCase params');
    assert.equal(ext.requests.at(-1).client, 'Claude Desktop', 'each request names the AI app it comes from');

    const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
    assert.equal(shot.content[0].type, 'image');
    assert.equal(shot.content[0].mimeType, 'image/jpeg');

    assert.match(text(await client.callTool({ name: 'browser_get_text', arguments: {} })), /call again with offset 5/);

    const blocked = await client.callTool({ name: 'browser_type', arguments: { ref: 1, text: 'x' } });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /blocked Claude Connector on mybank\.com/);

    // The extension popup learns which MCP client is connected (friendly name).
    await until(() => ext.clients.includes('Claude Desktop'));
    ext.ws.close();
  } finally {
    await client.close();
  }
});

test('a clear error when the extension is not connected', async () => {
  const port = await freePort();
  const client = await startClient(port, 'claude-code');
  try {
    const res = await client.callTool({ name: 'browser_tabs', arguments: {} });
    assert.equal(res.isError, true);
    assert.match(text(res), /extension is not connected/);
  } finally {
    await client.close();
  }
});

test('web pages and rebinding attacks cannot connect', async () => {
  const port = await freePort();
  const client = await startClient(port, 'claude-ai');
  try {
    // A web page's WebSocket always carries its own origin.
    assert.equal(await rawConnect(port, '/extension', { Origin: 'https://evil.example' }), 403);
    assert.equal(await rawConnect(port, '/peer', { Origin: 'https://evil.example' }), 403);
    assert.equal(await rawConnect(port, '/peer', { Origin: 'null' }), 403);
    // DNS rebinding: right IP, attacker's Host header.
    assert.equal(await rawConnect(port, '/peer', { Host: `evil.example:${port}` }), 403);
    assert.equal(await rawConnect(port, '/extension', { Origin: EXT_ORIGIN, Host: `evil.example:${port}` }), 403);
    assert.equal(await rawConnect(port, '/other', {}), 404);
    // The real extension origin is accepted.
    assert.equal(await rawConnect(port, '/extension', { Origin: EXT_ORIGIN }), 'open');
    // Edge's own scheme name is accepted too.
    assert.equal(await rawConnect(port, '/extension', { Origin: EXT_ORIGIN.replace('chrome-extension', 'extension') }), 'open');
  } finally {
    await client.close();
  }
});

test('EDGE_CONNECTOR_EXTENSION_IDS locks the server to specific extensions', async () => {
  const port = await freePort();
  const client = await startClient(port, 'x', { EDGE_CONNECTOR_EXTENSION_IDS: 'pppppppppppppppppppppppppppppppp' });
  try {
    assert.equal(await rawConnect(port, '/extension', { Origin: EXT_ORIGIN }), 403);
    assert.equal(await rawConnect(port, '/extension', { Origin: 'chrome-extension://pppppppppppppppppppppppppppppppp' }), 'open');
  } finally {
    await client.close();
  }
});

test('a second MCP client relays through the first, and takes over when it exits', async () => {
  const port = await freePort();
  const first = await startClient(port, 'claude-ai');
  const second = await startClient(port, 'gemini-cli-mcp-client');
  try {
    let ext = await fakeExtension(port, handlers);
    await until(() => ext.clients.includes('Claude Desktop') && ext.clients.includes('Gemini CLI'));

    const viaPeer = await second.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.equal(viaPeer.isError, undefined, text(viaPeer));
    assert.match(text(viaPeer), /\[1\] button "Compose"/);
    assert.equal(ext.requests.at(-1).client, 'Gemini CLI', 'relayed requests name the app that sent them, not the hub app');

    // The hub (first client) quits. The second process should take the port.
    await first.close();
    await until(() => ext.ws.readyState === WebSocket.CLOSED);
    await until(async () => {
      try {
        ext = await fakeExtension(port, handlers);
        return true;
      } catch {
        return false;
      }
    }, 8000);
    const afterTakeover = await second.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.match(text(afterTakeover), /\[1\] button "Compose"/);
    assert.equal(ext.requests.at(-1).client, 'Gemini CLI');
    await until(() => ext.clients.includes('Gemini CLI'));
    ext.ws.close();
  } finally {
    await second.close();
    await first.close().catch(() => {});
  }
});
