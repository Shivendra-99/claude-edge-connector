// Claude Connector service worker.
//
// Connects to the local Claude Connector MCP server over ws://127.0.0.1:<port>/extension
// and carries out its requests on tabs the user has shared, using the
// chrome.debugger (Chrome DevTools Protocol) API.

import * as actions from './cdp-actions.js';
import * as overlay from './overlay.js';

// idleSeconds: release the debugger this long after the AI's last action on a tab,
// so Edge's "started debugging this browser" bar only shows while the AI is working.
// showOverlay: glow + cursor + "<AI app> is working" pill on the page while working.
// groupTabs: put tabs the AI can use into an orange tab group named after the AI app.
const DEFAULTS = {
  port: 18765, allowOpenTabs: true, blockedSites: [], idleSeconds: 30, showOverlay: true, groupTabs: true,
};
const UNKNOWN_AI = 'AI'; // shown until we know which AI app is using a tab
const SNAPSHOT_CHARS = 20000;

let settings = { ...DEFAULTS };
const shared = new Set(); // tab ids the AI may control
const attached = new Set(); // tab ids with our debugger attached
const busy = new Map(); // tab id -> number of requests in progress
const idleTimers = new Map(); // tab id -> pending idle-release timer
const lastCursor = new Map(); // tab id -> last on-page cursor position
const tabClient = new Map(); // tab id -> name of the AI app that last acted in it (e.g. "Gemini CLI")
const groupedByUs = new Set(); // tab ids we moved into our AI tab group
let ourGroups = {}; // window id -> id of our AI tab group
let lastTabId = null;

let ws = null;
let connected = false;
let clients = [];
let serverVersion = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let pingTimer = null;

const ready = init();

// ---------------------------------------------------------------------------
// Startup and persistence
// ---------------------------------------------------------------------------

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  const saved = await chrome.storage.session.get({ shared: [], lastTabId: null, groupedByUs: [], ourGroups: {}, tabClient: {} });
  const alive = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const id of saved.shared) if (alive.has(id)) shared.add(id);
  for (const id of saved.groupedByUs) if (alive.has(id)) groupedByUs.add(id);
  for (const [id, name] of Object.entries(saved.tabClient)) if (alive.has(Number(id))) tabClient.set(Number(id), name);
  ourGroups = saved.ourGroups || {};
  lastTabId = alive.has(saved.lastTabId) ? saved.lastTabId : null;
  for (const id of shared) {
    updateBadge(id);
    // Drop any debugger session left over from before the service worker restarted;
    // the next action re-attaches.
    chrome.debugger.detach({ tabId: id }).catch(() => {});
  }
  chrome.alarms.create('cec-reconnect', { periodInMinutes: 0.5 });
  connect();
}

async function persist() {
  await chrome.storage.session.set({
    shared: [...shared], lastTabId, groupedByUs: [...groupedByUs], ourGroups, tabClient: Object.fromEntries(tabClient),
  });
}

/** Remember which AI app is acting in a tab, so the page and tab group can name it. */
function setTabClient(tabId, name) {
  if (!name || tabClient.get(tabId) === name) return;
  tabClient.set(tabId, name);
  persist();
  updateGroupTitles();
}

function browserName() {
  const ua = navigator.userAgent;
  const edge = ua.match(/Edg\/([\d.]+)/);
  if (edge) return `Microsoft Edge ${edge[1]}`;
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  return chrome ? `Chromium ${chrome[1]}` : 'Unknown browser';
}

// ---------------------------------------------------------------------------
// Connection to the MCP server
// ---------------------------------------------------------------------------

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${settings.port}/extension`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    connected = true;
    reconnectDelay = 1000;
    sendToServer({ type: 'hello', version: chrome.runtime.getManifest().version, browser: browserName() });
    // Regular traffic keeps the service worker alive while connected.
    pingTimer = setInterval(() => sendToServer({ type: 'ping' }), 20000);
    broadcastState();
  };
  sock.onmessage = (ev) => onServerMessage(ev.data);
  sock.onerror = () => {};
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    connected = false;
    clients = [];
    clearInterval(pingTimer);
    broadcastState();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function onServerMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'welcome' || msg.type === 'clients') {
    if (msg.serverVersion) serverVersion = msg.serverVersion;
    if (Array.isArray(msg.clients)) clients = msg.clients;
    broadcastState();
    return;
  }
  if (msg.type !== 'request') return;
  try {
    await ready;
    const handler = handlers[msg.method];
    if (!handler) throw new Error(`Unknown method: ${msg.method}`);
    const result = await handler({ ...msg.params, client: msg.client });
    sendToServer({ type: 'response', id: msg.id, result });
  } catch (e) {
    sendToServer({ type: 'response', id: msg.id, error: { message: e?.message || String(e) } });
  }
}

// ---------------------------------------------------------------------------
// Tab access rules
// ---------------------------------------------------------------------------

const NO_TABS =
  'No tabs are shared with Claude Connector yet. Open one with browser_open_tab, or ask the user to click the ' +
  'Claude Connector icon in Edge and choose "Let AI use this tab".';

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function checkAllowed(url) {
  if (!url) return;
  if (/^(edge|chrome|about|devtools|chrome-extension|extension|view-source):/i.test(url) && url !== 'about:blank') {
    throw new Error('Browser-internal pages (like edge://settings) and extension pages cannot be controlled.');
  }
  const host = hostOf(url);
  const hit = settings.blockedSites.find((d) => host === d || host.endsWith(`.${d}`));
  if (hit) {
    throw new Error(`The user has blocked Claude Connector on ${hit}. Do not try to work around this; ask the user to do this part themselves.`);
  }
}

async function resolveTab(tabId) {
  let id = tabId ?? null;
  if (id == null) {
    if (lastTabId != null && shared.has(lastTabId)) id = lastTabId;
    else if (shared.size === 1) [id] = shared;
    else {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && shared.has(active.id)) id = active.id;
    }
  }
  if (id == null) {
    if (shared.size === 0) throw new Error(NO_TABS);
    throw new Error(`Several tabs are shared; pass tab_id. Shared tab ids: ${[...shared].join(', ')}.`);
  }
  if (!shared.has(id)) {
    throw new Error(`Tab ${id} is not shared with Claude Connector. ${NO_TABS}`);
  }
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab) {
    await setShared(id, false);
    throw new Error(`Tab ${id} was closed.`);
  }
  checkAllowed(tab.pendingUrl || tab.url);
  if (lastTabId !== id) {
    lastTabId = id;
    await persist();
  }
  return tab;
}

async function ensureAttached(tabId) {
  if (!shared.has(tabId)) throw new Error('The user stopped the AI using this tab.');
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const m = e?.message || String(e);
    if (/another debugger/i.test(m)) {
      throw new Error('Another extension or tool is already debugging this tab. Close it (or DevTools remote debugging) and try again.');
    }
    if (!/already attached/i.test(m)) throw new Error(`Could not control this tab: ${m}`);
  }
  attached.add(tabId);
  broadcastState();
  updateGroupTitles();
  // Lets the page behave as focused even when it is a background tab.
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

async function releaseTab(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  // Take the glow/cursor off the page while we can still reach it.
  await overlay.removeOverlay((method, params) => chrome.debugger.sendCommand({ tabId }, method, params));
  await chrome.debugger.detach({ tabId }).catch(() => {});
  broadcastState();
  updateGroupTitles();
}

// ---- on-page overlay ------------------------------------------------------

function overlayOpts(tabId) {
  const idle = Math.max(1, Number(settings.idleSeconds) || DEFAULTS.idleSeconds);
  return { ttlMs: (idle + 5) * 1000, cursor: lastCursor.get(tabId), label: `${tabClient.get(tabId) || UNKNOWN_AI} is working in this tab` };
}

async function refreshOverlay(tabId, send, op = 'show') {
  if (!settings.showOverlay) return;
  await (op === 'ping' ? overlay.pingOverlay : overlay.showOverlay)(send, overlayOpts(tabId));
}

/** Hook for actions.click/type: glide the on-page cursor to the target first. */
function cursorHook(tabId, send) {
  if (!settings.showOverlay) return undefined;
  return async (x, y) => {
    lastCursor.set(tabId, { x, y });
    await overlay.moveCursor(send, x, y, overlayOpts(tabId));
  };
}

// ---- AI tab group (titled with the AI app's name) ---------------------------

async function groupTab(tabId) {
  if (!settings.groupTabs || !chrome.tabGroups) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    let groupId = ourGroups[tab.windowId];
    if (groupId != null) groupId = await chrome.tabGroups.get(groupId).then((g) => g.id, () => null);
    if (tab.groupId !== -1) {
      // Leave tabs in the user's own groups where they are.
      if (tab.groupId === groupId) groupedByUs.add(tabId);
      return;
    }
    if (groupId != null) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      ourGroups[tab.windowId] = groupId;
      await chrome.tabGroups.update(groupId, { title: tabClient.get(tabId) || UNKNOWN_AI, color: 'orange' });
    }
    groupedByUs.add(tabId);
  } catch {
    // Tab closed, dragged, or groups unsupported: not important.
  } finally {
    await persist();
    updateGroupTitles();
  }
}

async function ungroupTab(tabId) {
  if (!groupedByUs.delete(tabId)) return;
  await persist();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (Object.values(ourGroups).includes(tab.groupId)) await chrome.tabs.ungroup(tabId);
  } catch {}
}

let groupTitleTimer = null;
function updateGroupTitles() {
  if (!chrome.tabGroups) return;
  clearTimeout(groupTitleTimer);
  groupTitleTimer = setTimeout(async () => {
    for (const [windowId, groupId] of Object.entries(ourGroups)) {
      try {
        const tabs = await chrome.tabs.query({ groupId });
        const working = tabs.filter((t) => attached.has(t.id));
        // Name whoever is working right now; when idle, whoever used these tabs last.
        const names = [...new Set((working.length ? working : tabs).map((t) => tabClient.get(t.id)).filter(Boolean))];
        const who = names.join(' + ') || UNKNOWN_AI;
        const title = working.length ? `${who} · working` : who;
        const group = await chrome.tabGroups.get(groupId);
        if (group.title !== title) await chrome.tabGroups.update(groupId, { title });
      } catch {
        delete ourGroups[windowId]; // the group is gone (all its tabs closed or ungrouped)
      }
    }
  }, 100);
}

function markBusy(tabId) {
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  busy.set(tabId, (busy.get(tabId) || 0) + 1);
}

function markIdle(tabId) {
  const left = (busy.get(tabId) || 1) - 1;
  if (left > 0) {
    busy.set(tabId, left);
    return;
  }
  busy.delete(tabId);
  clearTimeout(idleTimers.get(tabId));
  const ms = Math.max(1, Number(settings.idleSeconds) || DEFAULTS.idleSeconds) * 1000;
  idleTimers.set(tabId, setTimeout(() => {
    idleTimers.delete(tabId);
    if (!busy.get(tabId)) releaseTab(tabId);
  }, ms));
}

function sender(tabId) {
  return async (method, params) => {
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (e) {
      if (/not attached/i.test(e?.message || '')) {
        attached.delete(tabId);
        await ensureAttached(tabId);
        return chrome.debugger.sendCommand({ tabId }, method, params);
      }
      throw e;
    }
  };
}

/**
 * Run `fn` with the debugger attached to a tab. The tab is released again
 * after `settings.idleSeconds` without any further requests.
 */
async function useAttached(tab, fn, client) {
  setTabClient(tab.id, client);
  markBusy(tab.id);
  let keepAlive = null;
  try {
    await ensureAttached(tab.id);
    const send = sender(tab.id);
    await refreshOverlay(tab.id, send);
    // Keep the overlay up during long actions (it removes itself if not refreshed).
    keepAlive = setInterval(() => refreshOverlay(tab.id, send, 'ping'), 5000);
    return await fn({ tab, send });
  } finally {
    clearInterval(keepAlive);
    markIdle(tab.id);
  }
}

async function useTab(params, fn) {
  return useAttached(await resolveTab(params.tabId), fn, params.client);
}

/** Common result: what happened, where we are now, and (optionally) a fresh snapshot. */
async function finish(tabId, send, message, withSnapshot) {
  const info = await actions.pageInfo(send).catch(() => ({}));
  const out = { tabId, message, title: info.title, url: info.url };
  try {
    checkAllowed(info.url);
  } catch (e) {
    out.message += ` ${e.message}`;
    return out;
  }
  await refreshOverlay(tabId, send, 'ping'); // the action may have loaded a new page
  if (withSnapshot) out.snapshot = (await actions.snapshot(send, { maxChars: SNAPSHOT_CHARS })).text;
  return out;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// Request handlers (method names match the server's bridge calls)
// ---------------------------------------------------------------------------

const handlers = {
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return {
      browser: browserName(),
      allowOpenTabs: settings.allowOpenTabs,
      tabs: tabs
        .filter((t) => shared.has(t.id))
        .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, current: t.id === lastTabId })),
    };
  },

  async open_tab({ url, background = false, snapshot = true, client }) {
    if (!settings.allowOpenTabs) {
      throw new Error('The user turned off "Let AI open new tabs" in Claude Connector. Ask them to share a tab instead.');
    }
    const href = actions.normalizeUrl(url);
    checkAllowed(href);
    const created = await chrome.tabs.create({ url: 'about:blank', active: !background });
    setTabClient(created.id, client); // before grouping, so a new group gets the right title
    await setShared(created.id, true);
    lastTabId = created.id;
    await persist();
    return useAttached(created, async ({ tab, send }) => {
      const message = await actions.navigate(send, { url: href });
      return finish(tab.id, send, `Opened a new tab (id ${tab.id}). ${message}`, snapshot);
    }, client);
  },

  navigate: (params) =>
    useTab(params, async ({ tab, send }) => {
      if (!['back', 'forward', 'reload'].includes(String(params.url).trim().toLowerCase())) {
        checkAllowed(actions.normalizeUrl(params.url));
      }
      const message = await actions.navigate(send, { url: params.url });
      return finish(tab.id, send, message, params.snapshot ?? true);
    }),

  snapshot: (params) =>
    useTab(params, async ({ tab, send }) => {
      const snap = await actions.snapshot(send, { maxChars: params.maxChars || SNAPSHOT_CHARS });
      return { tabId: tab.id, snapshot: snap.text };
    }),

  click: (params) =>
    useTab(params, async ({ tab, send }) => {
      const message = await actions.click(send, {
        ref: params.ref, button: params.button || 'left', doubleClick: !!params.doubleClick,
        onPoint: cursorHook(tab.id, send),
      });
      return finish(tab.id, send, message, params.snapshot ?? true);
    }),

  type: (params) =>
    useTab(params, async ({ tab, send }) => {
      const message = await actions.type(send, {
        ref: params.ref, text: params.text ?? '', clear: params.clear ?? true, submit: !!params.submit,
        onPoint: cursorHook(tab.id, send),
      });
      return finish(tab.id, send, message, params.snapshot ?? true);
    }),

  press_key: (params) =>
    useTab(params, async ({ tab, send }) => {
      const message = await actions.pressKey(send, { key: params.key });
      return finish(tab.id, send, message, params.snapshot ?? true);
    }),

  select_option: (params) =>
    useTab(params, async ({ tab, send }) => {
      const message = await actions.selectOption(send, { ref: params.ref, option: params.option });
      return finish(tab.id, send, message, params.snapshot ?? true);
    }),

  scroll: (params) =>
    useTab(params, async ({ tab, send }) => {
      const message = await actions.scroll(send, { direction: params.direction, amount: params.amount, ref: params.ref });
      return finish(tab.id, send, message, params.snapshot ?? true);
    }),

  screenshot: (params) =>
    useTab(params, async ({ tab, send }) => {
      let shot;
      // The AI should see the page, not our glow and cursor.
      await overlay.hideOverlay(send);
      try {
        shot = await withTimeout(actions.screenshot(send, {}), 8000, 'Screenshot');
      } catch {
        // Background tabs may not paint; bring the tab forward and retry once.
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        shot = await withTimeout(actions.screenshot(send, {}), 8000, 'Screenshot');
      } finally {
        await overlay.unhideOverlay(send);
      }
      const info = await actions.pageInfo(send).catch(() => ({}));
      return { tabId: tab.id, title: info.title, url: info.url, ...shot };
    }),

  get_text: (params) =>
    useTab(params, async ({ tab, send }) => {
      const res = await actions.getText(send, { offset: params.offset || 0, maxChars: params.maxChars || 20000 });
      return { tabId: tab.id, ...res };
    }),

  wait: (params) =>
    useTab(params, async ({ tab, send }) => {
      const timeoutMs = Math.min(Math.max(params.seconds ?? 5, 0), 60) * 1000;
      let message;
      if (params.text) {
        message = await actions.waitFor(send, { text: params.text, timeoutMs });
      } else {
        await new Promise((r) => setTimeout(r, timeoutMs));
        message = `Waited ${timeoutMs / 1000}s.`;
      }
      return finish(tab.id, send, message, params.snapshot ?? false);
    }),

  async close_tab(params) {
    const tab = await resolveTab(params.tabId);
    await setShared(tab.id, false);
    await chrome.tabs.remove(tab.id);
    return { tabId: tab.id, message: `Closed tab ${tab.id}.` };
  },
};

// ---------------------------------------------------------------------------
// Sharing state, badge and popup
// ---------------------------------------------------------------------------

async function setShared(tabId, on) {
  if (on) {
    shared.add(tabId);
    await groupTab(tabId);
  } else {
    shared.delete(tabId);
    await releaseTab(tabId);
    await ungroupTab(tabId);
    lastCursor.delete(tabId);
    tabClient.delete(tabId);
    if (lastTabId === tabId) lastTabId = null;
  }
  await persist();
  updateBadge(tabId);
  broadcastState();
}

function updateBadge(tabId) {
  const on = shared.has(tabId);
  chrome.action.setBadgeText({ tabId, text: on ? 'AI' : '' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: '#0f766e' }).catch(() => {});
  chrome.action
    .setTitle({ tabId, title: on ? 'Claude Connector: AI can use this tab' : 'Claude Connector' })
    .catch(() => {});
}

async function getState() {
  const tabs = await chrome.tabs.query({});
  return {
    connected,
    clients,
    serverVersion,
    browser: browserName(),
    settings,
    shared: tabs
      .filter((t) => shared.has(t.id))
      .map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl, inUse: attached.has(t.id) })),
  };
}

function broadcastState() {
  getState()
    .then((state) => chrome.runtime.sendMessage({ cmd: 'state', state }))
    .catch(() => {}); // popup not open
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg.cmd) {
      case 'getState':
        return getState();
      case 'setShared':
        await setShared(msg.tabId, !!msg.on);
        return getState();
      case 'stopAll':
        for (const id of [...shared]) await setShared(id, false);
        return getState();
      case 'saveSettings': {
        const portChanged = msg.settings.port && msg.settings.port !== settings.port;
        const before = settings;
        settings = { ...settings, ...msg.settings };
        await chrome.storage.local.set(settings);
        if (before.groupTabs !== settings.groupTabs) {
          for (const id of shared) await (settings.groupTabs ? groupTab(id) : ungroupTab(id));
        }
        if (before.showOverlay && !settings.showOverlay) {
          for (const id of attached) {
            await overlay.removeOverlay((m, p) => chrome.debugger.sendCommand({ tabId: id }, m, p));
          }
        }
        if (portChanged && ws) ws.close();
        if (portChanged) {
          reconnectDelay = 1000;
          setTimeout(connect, 100);
        }
        return getState();
      }
      case 'reconnect':
        reconnectDelay = 1000;
        connect();
        return getState();
      default:
        throw new Error(`Unknown command ${msg.cmd}`);
    }
  })().then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true;
});

// ---------------------------------------------------------------------------
// Browser events
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cec-reconnect') ready.then(connect);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  busy.delete(tabId);
  lastCursor.delete(tabId);
  tabClient.delete(tabId);
  if (groupedByUs.delete(tabId)) persist();
  clearTimeout(idleTimers.get(tabId));
  idleTimers.delete(tabId);
  if (shared.delete(tabId)) {
    if (lastTabId === tabId) lastTabId = null;
    persist();
    broadcastState();
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && shared.has(tabId)) updateBadge(tabId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  // The user pressed "Cancel" on Edge's "started debugging this browser" bar:
  // treat that as "stop everything".
  if (reason === 'canceled_by_user') {
    for (const id of [...shared]) setShared(id, false);
  }
});

// The "Stop" button in the on-page pill calls this page binding (overlay.js).
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Runtime.bindingCalled' && params?.name === overlay.STOP_BINDING && source.tabId != null) {
    ready.then(() => setShared(source.tabId, false));
  }
});
