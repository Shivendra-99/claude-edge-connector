// Full end-to-end test: the real extension loaded into Chromium, the real MCP
// server, and an MCP client calling tools. Edge runs the same Chromium
// extension platform, so this exercises the same code paths.
//
// Uses port 18765 (the extension's default). Skips if it is busy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startStaticServer } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'extension');
const PORT = 18765;

const portFree = () =>
  new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).listen(PORT, '127.0.0.1', () => s.close(() => resolve(true)));
  });

let site, client, context, extPage, userDataDir;
const text = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const refFor = (output, pattern) => {
  const line = output.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in:\n${output}`);
  return Number(line.match(/^\[(\d+)\]/)[1]);
};
const popup = (msg) => extPage.evaluate((m) => chrome.runtime.sendMessage(m), msg);

const skip = !(await portFree()) && `port ${PORT} is busy`;

before(async () => {
  if (skip) return;
  site = await startStaticServer();
  client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'server', 'src', 'index.js')],
      env: { ...process.env, EDGE_CONNECTOR_PORT: String(PORT), EDGE_CONNECTOR_CONNECT_WAIT_MS: '3000' },
      stderr: 'pipe',
    }),
  );
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cec-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 750 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
});

after(async () => {
  await context?.close();
  await client?.close();
  await site?.close();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
});

test('extension connects to the server', { skip }, async () => {
  const deadline = Date.now() + 15000;
  let res;
  do {
    res = await call('browser_tabs');
  } while (res.isError && Date.now() < deadline);
  assert.equal(res.isError, undefined, text(res));
  assert.match(text(res), /No tabs are shared yet/);
  const state = await popup({ cmd: 'getState' });
  assert.equal(state.connected, true);
  assert.deepEqual(state.clients, ['Claude Code']);
});

test('--check reports a healthy setup while an AI app is running', { skip }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js'), '--check'], {
    env: { ...process.env, EDGE_CONNECTOR_PORT: String(PORT) },
    timeout: 30000,
  });
  assert.match(stdout, /Another Claude Connector server is already running/);
  assert.match(stdout, /OK: connected to Chromium/);
});

test('a tab the user shares can be read and filled in', { skip }, async () => {
  const page = await context.newPage();
  await page.goto(`${site.url}/form.html`);
  const before = await call('browser_snapshot');
  assert.equal(before.isError, true, 'unshared tabs are off limits');

  const [{ id: tabId }] = await extPage.evaluate((u) => chrome.tabs.query({ url: u }), `${site.url}/form.html`);
  await popup({ cmd: 'setShared', tabId, on: true });

  assert.match(text(await call('browser_tabs')), new RegExp(`id ${tabId}.*Connector test form`));

  let snap = text(await call('browser_snapshot'));
  assert.match(snap, /untrusted web data/);
  await call('browser_type', { ref: refFor(snap, /textbox "Email address"/), text: 'shiv@example.com', snapshot: false });
  await call('browser_select_option', { ref: refFor(snap, /combobox "Country"/), option: 'United States', snapshot: false });
  await call('browser_click', { ref: refFor(snap, /checkbox "I accept the terms"/), snapshot: false });
  const after = text(await call('browser_click', { ref: refFor(snap, /button "Place order"/) }));
  assert.match(after, /Submitted: shiv@example\.com \/ us \/ true/);
  assert.equal(await page.textContent('#result'), 'Submitted: shiv@example.com / us / true');

  const shot = await call('browser_screenshot');
  assert.equal(shot.content[0].type, 'image');
  assert.ok(shot.content[0].data.length > 1000);

  // Turning sharing off locks the AI out again.
  await popup({ cmd: 'setShared', tabId, on: false });
  const locked = await call('browser_snapshot', { tab_id: tabId });
  assert.equal(locked.isError, true);
  assert.match(text(locked), /not shared/);
  await page.close();
});

test('the AI can open its own tab and navigate', { skip }, async () => {
  const opened = text(await call('browser_open_tab', { url: `${site.url}/form.html` }));
  assert.match(opened, /Opened a new tab \(id \d+\)/);
  assert.match(opened, /heading1 "Checkout"/);
  const link = refFor(opened, /link "Go to page two"/);
  const nav = text(await call('browser_click', { ref: link }));
  assert.match(nav, /Welcome to page two/);

  const waited = text(await call('browser_click', { ref: refFor(nav, /button "Load more"/), snapshot: false }));
  assert.match(waited, /Clicked/);
  assert.match(text(await call('browser_wait', { text: 'Loaded later', seconds: 5 })), /Found "Loaded later"/);
  assert.match(text(await call('browser_navigate', { url: 'back' })), /form\.html/);
  const full = text(await call('browser_get_text'));
  assert.match(full, /Bottom of the page/);
});

test('blocked sites and the "open tabs" switch are enforced', { skip }, async () => {
  let state = await popup({ cmd: 'saveSettings', settings: { blockedSites: ['127.0.0.1'] } });
  assert.deepEqual(state.settings.blockedSites, ['127.0.0.1']);
  const blocked = await call('browser_snapshot');
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /blocked Claude Connector on 127\.0\.0\.1/);
  const blockedOpen = await call('browser_open_tab', { url: `${site.url}/page2.html` });
  assert.match(text(blockedOpen), /blocked Claude Connector/);

  state = await popup({ cmd: 'saveSettings', settings: { blockedSites: [], allowOpenTabs: false } });
  const noOpen = await call('browser_open_tab', { url: `${site.url}/page2.html` });
  assert.match(text(noOpen), /turned off "Let AI open new tabs"/);
  await popup({ cmd: 'saveSettings', settings: { allowOpenTabs: true } });
});

test('the debugger is released when the AI goes idle and re-attached on its next action', { skip }, async () => {
  await popup({ cmd: 'saveSettings', settings: { idleSeconds: 1 } });
  const opened = text(await call('browser_open_tab', { url: `${site.url}/form.html`, snapshot: false }));
  const tabId = Number(opened.match(/tab \(id (\d+)\)/)[1]);
  const inUse = async () => (await popup({ cmd: 'getState' })).shared.find((t) => t.id === tabId)?.inUse;
  const debuggerState = () =>
    extPage.evaluate(
      (id) => chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', { expression: '1' }).then(() => 'attached', (e) => e.message),
      tabId,
    );

  assert.equal(await inUse(), true, 'attached while the AI is working');
  assert.equal(await debuggerState(), 'attached');

  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await inUse(), false, 'released after going idle');
  assert.match(await debuggerState(), /not attached/i, 'Edge would hide its debugging bar now');
  assert.ok((await popup({ cmd: 'getState' })).shared.some((t) => t.id === tabId), 'the tab stays shared');

  // The next action re-attaches without the AI noticing.
  assert.match(text(await call('browser_snapshot', { tab_id: tabId })), /heading1 "Checkout"/);
  assert.equal(await inUse(), true);

  // A long action is never cut off by the idle timer.
  const waited = await call('browser_wait', { tab_id: tabId, seconds: 2 });
  assert.equal(waited.isError, undefined, text(waited));
  assert.equal(await inUse(), true);

  await popup({ cmd: 'saveSettings', settings: { idleSeconds: 30 } });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageFor = async (fragment) => {
  for (let i = 0; i < 50; i++) {
    const p = context.pages().find((pg) => pg.url().includes(fragment));
    if (p) return p;
    await sleep(100);
  }
  throw new Error(`no page with ${fragment}`);
};
const overlayOn = (page) =>
  page.evaluate(() => {
    const h = document.querySelector('cec-overlay[data-cec-overlay]');
    return h ? { x: Number(h.dataset.x), y: Number(h.dataset.y), visibility: h.style.visibility } : null;
  });
const tabInfo = (tabId) =>
  extPage.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    const group = tab.groupId === -1 ? null : await chrome.tabGroups.get(tab.groupId);
    return { groupId: tab.groupId, title: group?.title, color: group?.color };
  }, tabId);
const openedId = (out) => Number(out.match(/tab \(id (\d+)\)/)[1]);

test('AI tabs go into an orange group named after the AI app, showing when it is working', { skip }, async () => {
  await popup({ cmd: 'stopAll' }); // tabs from earlier tests would share the group
  await popup({ cmd: 'saveSettings', settings: { idleSeconds: 2 } });
  const tabId = openedId(text(await call('browser_open_tab', { url: `${site.url}/form.html?t=group`, snapshot: false })));
  await sleep(300);
  let info = await tabInfo(tabId);
  assert.notEqual(info.groupId, -1, 'grouped');
  assert.equal(info.color, 'orange');
  assert.equal(info.title, 'Claude Code · working');

  await sleep(3000);
  info = await tabInfo(tabId);
  assert.equal(info.title, 'Claude Code', 'back to just the app name once idle');

  // A second AI tab joins the same group.
  const second = openedId(text(await call('browser_open_tab', { url: `${site.url}/page2.html?t=group2`, snapshot: false })));
  assert.equal((await tabInfo(second)).groupId, info.groupId);

  await popup({ cmd: 'setShared', tabId, on: false });
  await popup({ cmd: 'setShared', tabId: second, on: false });
  assert.equal((await tabInfo(tabId)).groupId, -1, 'ungrouped when no longer shared');
  await popup({ cmd: 'saveSettings', settings: { idleSeconds: 30 } });
});

test('tabs already in the user\'s own group are left where they are', { skip }, async () => {
  const page = await context.newPage();
  await page.goto(`${site.url}/form.html?t=usergroup`);
  const [{ id: tabId }] = await extPage.evaluate((u) => chrome.tabs.query({ url: u }), `${site.url}/form.html?t=usergroup`);
  const userGroup = await extPage.evaluate((id) => chrome.tabs.group({ tabIds: [id] }), tabId);
  await popup({ cmd: 'setShared', tabId, on: true });
  assert.equal((await tabInfo(tabId)).groupId, userGroup);
  await popup({ cmd: 'setShared', tabId, on: false });
  assert.equal((await tabInfo(tabId)).groupId, userGroup);
  await page.close();
});

test('the page shows a glow, a cursor that follows clicks, and hides them from the AI', { skip }, async () => {
  await popup({ cmd: 'saveSettings', settings: { idleSeconds: 2 } });
  const opened = text(await call('browser_open_tab', { url: `${site.url}/form.html?t=overlay` }));
  const tabId = openedId(opened);
  const page = await pageFor('t=overlay');
  assert.ok(await overlayOn(page), 'overlay shown while working');
  assert.doesNotMatch(opened, /is working in this tab/, 'overlay is not in the snapshot');
  assert.doesNotMatch(text(await call('browser_get_text', { tab_id: tabId })), /is working in this tab/);

  const ref = refFor(opened, /button "Place order"/);
  await call('browser_click', { tab_id: tabId, ref, snapshot: false });
  const box = await page.evaluate(() => {
    const r = document.querySelector('button[type=submit]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const o = await overlayOn(page);
  assert.ok(Math.abs(o.x - box.x) <= 2 && Math.abs(o.y - box.y) <= 2, `cursor at ${o.x},${o.y}, button at ${box.x},${box.y}`);
  assert.match(await page.textContent('#result'), /Submitted/, 'the click still reached the page');

  const shot = await call('browser_screenshot', { tab_id: tabId });
  assert.equal(shot.content[0].type, 'image');
  assert.equal((await overlayOn(page)).visibility, 'visible', 'overlay comes back after the screenshot');

  // Navigating keeps the overlay (re-created on the new page).
  const nav = text(await call('browser_navigate', { tab_id: tabId, url: `${site.url}/page2.html?t=overlay` }));
  assert.match(nav, /Welcome to page two/);
  assert.ok(await overlayOn(await pageFor('page2.html?t=overlay')));

  await sleep(3000);
  assert.equal(await overlayOn(await pageFor('page2.html?t=overlay')), null, 'removed once the AI goes idle');
  await popup({ cmd: 'setShared', tabId, on: false });
  await popup({ cmd: 'saveSettings', settings: { idleSeconds: 30 } });
});

test('the Stop button on the page takes the tab away from the AI', { skip }, async () => {
  const tabId = openedId(text(await call('browser_open_tab', { url: `${site.url}/form.html?t=stop`, snapshot: false })));
  const page = await pageFor('t=stop');
  assert.ok(await overlayOn(page));
  await page.evaluate(() => window.__cecStop('stop')); // what the pill's Stop button calls
  await sleep(500);
  const state = await popup({ cmd: 'getState' });
  assert.ok(!state.shared.some((t) => t.id === tabId), 'no longer shared');
  assert.equal(await overlayOn(page), null, 'overlay removed');
  assert.equal((await tabInfo(tabId)).groupId, -1, 'ungrouped');
  const res = await call('browser_snapshot', { tab_id: tabId });
  assert.equal(res.isError, true);
  assert.match(text(res), /not shared/);
});

test('the overlay and tab group can be switched off', { skip }, async () => {
  await popup({ cmd: 'saveSettings', settings: { showOverlay: false, groupTabs: false } });
  const tabId = openedId(text(await call('browser_open_tab', { url: `${site.url}/form.html?t=off`, snapshot: false })));
  assert.equal(await overlayOn(await pageFor('t=off')), null);
  assert.equal((await tabInfo(tabId)).groupId, -1);
  await popup({ cmd: 'setShared', tabId, on: false });
  await popup({ cmd: 'saveSettings', settings: { showOverlay: true, groupTabs: true } });
});

test('stop all un-shares every tab', { skip }, async () => {
  const state = await popup({ cmd: 'stopAll' });
  assert.equal(state.shared.length, 0);
  assert.match(text(await call('browser_tabs')), /No tabs are shared yet/);
});
