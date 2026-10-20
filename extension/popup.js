const $ = (id) => document.getElementById(id);
let currentTab = null;

const call = (msg) =>
  chrome.runtime.sendMessage(msg).then((res) => {
    if (res && res.error) throw new Error(res.error);
    return res;
  });

function canShare(url) {
  return /^https?:/i.test(url || '') || url === 'about:blank';
}

function host(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function render(state) {
  const status = $('status');
  status.classList.toggle('on', state.connected);
  if (state.connected) {
    const who = state.clients && state.clients.length ? state.clients.join(', ') : 'your AI app';
    $('statusText').textContent = `Connected to ${who}`;
  } else {
    $('statusText').textContent = 'Not connected. Start an AI app that has Claude Connector set up.';
  }

  if (currentTab) {
    const isShared = state.shared.some((t) => t.id === currentTab.id);
    const blocked = state.settings.blockedSites.find((d) => {
      const h = host(currentTab.url);
      return h === d || h.endsWith(`.${d}`);
    });
    const toggle = $('toggle');
    toggle.textContent = isShared ? 'Stop AI using this tab' : 'Let AI use this tab';
    toggle.classList.toggle('stop', isShared);
    toggle.disabled = !isShared && (!canShare(currentTab.url) || !!blocked);
    $('curNote').textContent = !canShare(currentTab.url)
      ? 'Browser pages like edge://settings cannot be shared.'
      : blocked
        ? `${blocked} is on your blocked list.`
        : isShared
          ? 'While the AI is working here, Edge shows a "started debugging this browser" bar. It goes away about 30 seconds after the AI stops. Press Cancel on it to stop everything.'
          : '';
  }

  const list = $('sharedList');
  list.replaceChildren();
  for (const t of state.shared) {
    const li = document.createElement('li');
    const icon = document.createElement('img');
    icon.width = 16;
    icon.height = 16;
    icon.alt = '';
    icon.src = t.favIconUrl && /^https?:|^data:/.test(t.favIconUrl) ? t.favIconUrl : 'icons/icon-16.png';
    icon.onerror = () => { icon.src = 'icons/icon-16.png'; };
    const text = document.createElement('div');
    text.className = 'tabtext';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = t.title || t.url;
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = (host(t.url) || t.url) + (t.inUse ? ' · AI working now' : '');
    text.append(title, url);
    const stop = document.createElement('button');
    stop.className = 'link danger';
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => call({ cmd: 'setShared', tabId: t.id, on: false }).then(render));
    li.append(icon, text, stop);
    list.append(li);
  }
  $('emptyShared').style.display = state.shared.length ? 'none' : '';
  $('stopAll').style.visibility = state.shared.length ? 'visible' : 'hidden';

  if (!document.activeElement || document.activeElement === document.body) {
    $('allowOpen').checked = state.settings.allowOpenTabs;
    $('groupTabs').checked = state.settings.groupTabs;
    $('showOverlay').checked = state.settings.showOverlay;
    $('blocked').value = state.settings.blockedSites.join('\n');
    $('port').value = state.settings.port;
  }
}

async function main() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (currentTab) {
    $('curTitle').textContent = currentTab.title || 'Untitled';
    $('curUrl').textContent = currentTab.url || '';
    const icon = $('curIcon');
    icon.src = currentTab.favIconUrl && /^https?:|^data:/.test(currentTab.favIconUrl) ? currentTab.favIconUrl : 'icons/icon-16.png';
    icon.onerror = () => { icon.src = 'icons/icon-16.png'; };
  }

  render(await call({ cmd: 'getState' }));

  $('toggle').addEventListener('click', async () => {
    const state = await call({ cmd: 'getState' });
    const isShared = state.shared.some((t) => t.id === currentTab.id);
    render(await call({ cmd: 'setShared', tabId: currentTab.id, on: !isShared }));
  });

  $('stopAll').addEventListener('click', async () => render(await call({ cmd: 'stopAll' })));

  $('save').addEventListener('click', async () => {
    const port = Number($('port').value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      $('saved').textContent = 'Port must be 1024–65535';
      return;
    }
    const blockedSites = $('blocked').value
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, ''))
      .filter(Boolean);
    const state = await call({
      cmd: 'saveSettings',
      settings: {
        port,
        allowOpenTabs: $('allowOpen').checked,
        groupTabs: $('groupTabs').checked,
        showOverlay: $('showOverlay').checked,
        blockedSites,
      },
    });
    $('saved').textContent = 'Saved';
    setTimeout(() => ($('saved').textContent = ''), 1500);
    render(state);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.cmd === 'state') render(msg.state);
  });
}

main().catch((e) => {
  $('statusText').textContent = `Error: ${e.message}`;
});
