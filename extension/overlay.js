// The on-page overlay shown while the AI is working in a tab: a soft glow
// around the page, an animated cursor that moves to where the AI clicks or
// types, and a "<AI app> is working" pill with a Stop button.
//
// It lives in a closed shadow root on <html>, ignores pointer events (except
// the pill), sits in the browser's top layer above dialogs, and builds its
// DOM without innerHTML so it works on pages with strict CSP / Trusted Types.
// Nothing here may break an action, so every helper swallows its errors.

import { evaluate } from './cdp-actions.js';

export const STOP_BINDING = '__cecStop';

function overlayInPage(cmd) {
  const ATTR = 'data-cec-overlay';
  let host = document.querySelector(`cec-overlay[${ATTR}]`);

  if (cmd.op === 'remove') {
    if (host) {
      clearTimeout(host.__cecTtl);
      host.remove();
    }
    return true;
  }
  if (cmd.op === 'hide' || cmd.op === 'unhide') {
    if (host) host.style.visibility = cmd.op === 'hide' ? 'hidden' : 'visible';
    return true;
  }

  const created = !host;
  if (created) {
    host = document.createElement('cec-overlay');
    host.setAttribute(ATTR, '');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = [
      'all: initial', 'display: block', 'position: fixed', 'inset: 0', 'width: 100vw', 'height: 100vh',
      'margin: 0', 'padding: 0', 'border: 0', 'background: transparent', 'overflow: visible',
      'pointer-events: none', 'z-index: 2147483647', 'visibility: visible',
    ].join(';');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { --c: #e8743b; }
      .glow { position: fixed; inset: 0; pointer-events: none;
        box-shadow: inset 0 0 0 2px rgba(232,116,59,.85), inset 0 0 28px 6px rgba(232,116,59,.40);
        animation: glow 2.4s ease-in-out infinite; }
      @keyframes glow { 50% { box-shadow: inset 0 0 0 2px rgba(232,116,59,.55), inset 0 0 40px 12px rgba(232,116,59,.22); } }
      .cursor { position: fixed; left: 0; top: 0; width: 24px; height: 24px; pointer-events: none;
        transition: transform .38s cubic-bezier(.22,.8,.24,1); filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      .cursor svg { display: block; width: 24px; height: 24px; overflow: visible; }
      .ripple { position: fixed; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
        border-radius: 50%; border: 2px solid var(--c); pointer-events: none; animation: ripple .55s ease-out forwards; }
      @keyframes ripple { from { transform: var(--at) scale(.3); opacity: 1; } to { transform: var(--at) scale(1.4); opacity: 0; } }
      .pill { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 8px; padding: 5px 5px 5px 12px;
        background: #1d1d1f; color: #fff; border-radius: 999px; box-shadow: 0 4px 18px rgba(0,0,0,.28);
        font: 500 13px/1.2 "Segoe UI", system-ui, -apple-system, sans-serif; white-space: nowrap;
        pointer-events: auto; user-select: none; }
      .pill.passthrough { pointer-events: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); animation: blink 1.2s ease-in-out infinite; }
      @keyframes blink { 50% { opacity: .35; } }
      button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px; background: #3a3a3c; color: #fff; }
      button:hover { background: #4f4f52; }
      button:focus-visible { outline: 2px solid var(--c); outline-offset: 1px; }
      @media (prefers-reduced-motion: reduce) {
        .glow, .dot, .ripple { animation: none; } .ripple { display: none; } .cursor { transition: none; }
      }
    `);
    root.adoptedStyleSheets = [sheet];

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    };
    const glow = el('div', 'glow');
    const cursor = el('div', 'cursor');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M3 2 L3 19 L7.6 14.8 L10.6 21.4 L13.6 20 L10.7 13.6 L17 13.4 Z');
    path.setAttribute('fill', '#e8743b');
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    cursor.append(svg);
    const pill = el('div', 'pill');
    const stop = el('button', '', 'Stop');
    stop.type = 'button';
    stop.title = 'Stop the AI using this tab';
    stop.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof window[cmd.binding] === 'function') window[cmd.binding]('stop');
    });
    const label = el('span', 'label');
    pill.append(el('span', 'dot'), label, stop);
    root.append(glow, cursor, pill);
    host.__cec = { root, cursor, pill, label };
    document.documentElement.append(host);
    // Start the cursor where it last was (it survives page navigations).
    const start = cmd.cursor || { x: innerWidth / 2, y: innerHeight / 2 };
    cursor.style.transition = 'none';
    cursor.style.transform = `translate(${start.x}px, ${start.y}px)`;
    host.dataset.x = String(Math.round(start.x));
    host.dataset.y = String(Math.round(start.y));
    cursor.getBoundingClientRect();
    cursor.style.transition = '';
  }

  // Keep the overlay above modal dialogs by (re)entering the top layer.
  if (created || cmd.op === 'show') {
    try {
      host.setAttribute('popover', 'manual');
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {}
  }

  // Remove itself if the extension stops refreshing it (e.g. the user pressed
  // Cancel on Edge's debugging bar, which cuts the extension off).
  clearTimeout(host.__cecTtl);
  host.__cecTtl = setTimeout(() => host.remove(), cmd.ttlMs || 35000);

  const { root, cursor, pill, label } = host.__cec;
  // Name the AI app that is acting now (another app may take over the same tab).
  const text = cmd.label || 'AI is working in this tab';
  if (label.textContent !== text) label.textContent = text;
  if (cmd.op === 'move') {
    cursor.style.transform = `translate(${cmd.x}px, ${cmd.y}px)`;
    host.dataset.x = String(Math.round(cmd.x));
    host.dataset.y = String(Math.round(cmd.y));
    // Let the AI's click reach the page even if it lands under the pill.
    pill.classList.add('passthrough');
    clearTimeout(host.__cecPass);
    host.__cecPass = setTimeout(() => pill.classList.remove('passthrough'), 1200);
  }
  if (cmd.op === 'ripple') {
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.setProperty('--at', `translate(${cmd.x}px, ${cmd.y}px)`);
    r.style.transform = `translate(${cmd.x}px, ${cmd.y}px)`;
    root.append(r);
    setTimeout(() => r.remove(), 700);
  }
  return true;
}

const quiet = (p) => p.then(() => true, () => false);

function addStopBinding(send) {
  // Bindings vanish when the page navigates, so add it every time (it's idempotent).
  return send('Runtime.addBinding', { name: STOP_BINDING }).catch(() => {});
}

export async function showOverlay(send, { ttlMs, cursor, label } = {}) {
  await addStopBinding(send);
  return quiet(evaluate(send, overlayInPage, { op: 'show', ttlMs, cursor, label, binding: STOP_BINDING }));
}

/** Refresh the overlay's self-removal timer (and re-create it after a navigation). */
export async function pingOverlay(send, { ttlMs, cursor, label } = {}) {
  await addStopBinding(send);
  return quiet(evaluate(send, overlayInPage, { op: 'ping', ttlMs, cursor, label, binding: STOP_BINDING }));
}

export async function moveCursor(send, x, y, { ttlMs, label } = {}) {
  await quiet(evaluate(send, overlayInPage, { op: 'move', x, y, ttlMs, label, binding: STOP_BINDING }));
  await new Promise((r) => setTimeout(r, 400)); // let the cursor glide there
  quiet(evaluate(send, overlayInPage, { op: 'ripple', x, y, ttlMs, label, binding: STOP_BINDING }));
}

export const hideOverlay = (send) => quiet(evaluate(send, overlayInPage, { op: 'hide' }));
export const unhideOverlay = (send) => quiet(evaluate(send, overlayInPage, { op: 'unhide' }));
export const removeOverlay = (send) => quiet(evaluate(send, overlayInPage, { op: 'remove' }));
