// Page actions implemented on top of the Chrome DevTools Protocol (CDP).
//
// Every function takes `send(method, params) => Promise<result>`, so the same
// code runs inside the extension (backed by chrome.debugger.sendCommand) and in
// Node tests (backed by a Playwright CDP session).
//
// Functions whose names end in `InPage` are serialized with toString() and run
// inside the page. They must not reference anything outside their own body.

const REF_ATTR = 'data-cec-ref';

// ---------------------------------------------------------------------------
// Helpers that run in the extension / Node
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstLine(text) {
  return String(text || '').split('\n')[0].replace(/^(Uncaught )?Error: /, '');
}

export async function evaluate(send, fn, arg) {
  const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(firstLine(d.exception?.description || d.text || 'Script error'));
  }
  return res.result?.value;
}

export async function pageInfo(send) {
  return evaluate(send, () => ({ title: document.title, url: location.href }));
}

/** Wait until document.readyState is 'complete'. Never throws on timeout. */
export async function waitForLoad(send, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(send, () => document.readyState);
      if (state === 'complete') return true;
    } catch {
      // Execution context was destroyed mid-navigation; keep polling.
    }
    await sleep(200);
  }
  return false;
}

/** After an input event: give the page a moment, then wait for any navigation. */
async function settle(send) {
  await sleep(350);
  await waitForLoad(send, 10000);
}

export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL is empty.');
  if (raw === 'about:blank') return raw;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Only http and https URLs are allowed (got ${url.protocol}).`);
  }
  return url.href;
}

// ---------------------------------------------------------------------------
// Snapshot: a compact text outline of the page with numbered refs
// ---------------------------------------------------------------------------

function snapshotInPage(opts) {
  const REF = 'data-cec-ref';
  const maxChars = opts.maxChars;
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox',
    'slider', 'spinbutton', 'listbox', 'treeitem',
  ]);
  // CEC-OVERLAY is our own on-page cursor/glow overlay (overlay.js).
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'CEC-OVERLAY']);
  const clean = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };

  // Remove refs from any previous snapshot (document, shadow roots, same-origin frames).
  (function clear(root) {
    root.querySelectorAll(`[${REF}]`).forEach((el) => el.removeAttribute(REF));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) clear(el.shadowRoot);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try { if (el.contentDocument) clear(el.contentDocument); } catch {}
      }
    });
  })(document);

  const lines = [];
  let used = 0;
  let truncated = false;
  let nextRef = 1;
  const push = (line) => {
    if (truncated) return false;
    if (used + line.length + 1 > maxChars) { truncated = true; return false; }
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  function roleOf(el, tag) {
    const explicit = (el.getAttribute('role') || '').split(' ')[0];
    if (explicit) return explicit;
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (t === 'file') return 'file-upload';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return '';
  }

  function nameOf(el, tag) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode();
      const t = by.split(/\s+/).map((id) => {
        const n = (root.getElementById && root.getElementById(id)) || el.ownerDocument.getElementById(id);
        return n ? n.innerText || n.textContent : '';
      }).join(' ').trim();
      if (t) return t;
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.labels && el.labels.length) {
        const t = Array.from(el.labels).map((l) => l.innerText || l.textContent).join(' ').trim();
        if (t) return t;
      }
      if (el.placeholder) return el.placeholder;
      if (tag === 'input' && ['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value;
      if (tag === 'input' && el.type === 'image' && el.alt) return el.alt;
    }
    const text = (el.innerText || '').trim();
    if (text) return text;
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img && img.alt.trim()) return img.alt;
    return el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
  }

  function stateOf(el, tag, role) {
    const parts = [];
    if (tag === 'input' || tag === 'textarea') {
      const t = (el.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
      else if (t === 'password') parts.push(el.value ? 'value="••••"' : 'value=""');
      else if (t !== 'submit' && t !== 'button' && t !== 'reset' && t !== 'file') parts.push(`value="${clean(el.value, 60)}"`);
    } else if (tag === 'select') {
      const sel = Array.from(el.selectedOptions || []).map((o) => clean(o.text, 40));
      parts.push(`selected="${sel.join(', ')}"`);
      const opts = Array.from(el.options).slice(0, 12).map((o) => clean(o.text, 30));
      parts.push(`options=[${opts.map((o) => `"${o}"`).join(', ')}${el.options.length > 12 ? ', …' : ''}]`);
    } else if (role === 'textbox' && el.isContentEditable) {
      parts.push(`value="${clean(el.innerText, 60)}"`);
    }
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked && tag !== 'input') parts.push(ariaChecked === 'true' ? 'checked' : 'unchecked');
    if (el.getAttribute('aria-expanded')) parts.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (tag === 'a' && el.href && !el.href.startsWith('javascript:')) parts.push(`href="${clean(el.getAttribute('href'), 80)}"`);
    return parts.join(' ');
  }

  function isHidden(el, style) {
    if (el.checkVisibility && !el.checkVisibility()) return true;
    if (style.display === 'none') return true;
    return false;
  }

  function visit(node, ctx) {
    if (truncated) return;
    if (node.nodeType !== 1) return;
    const el = node;
    if (SKIP.has(el.tagName.toUpperCase())) return;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (isHidden(el, style)) return;
    const tag = el.tagName.toLowerCase();
    const shown = style.visibility !== 'hidden' && style.visibility !== 'collapse';
    const rect = el.getBoundingClientRect();
    const hasBox = rect.width > 0 && rect.height > 0;

    // Same-origin iframes are walked; cross-origin ones are reported.
    if (tag === 'iframe' || tag === 'frame') {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      if (doc && doc.body) {
        const fname = clean(el.title || el.name || '', 60);
        push(fname ? `frame "${fname}":` : 'frame:');
        visit(doc.body, ctx);
      } else if (hasBox) {
        push(`frame (cross-origin, not accessible) src="${clean(el.src, 80)}"`);
      }
      return;
    }

    const role = roleOf(el, tag);
    const nativeInteractive =
      (tag === 'a' && el.hasAttribute('href')) ||
      ['button', 'select', 'textarea', 'summary'].includes(tag) ||
      (tag === 'input' && (el.type || '').toLowerCase() !== 'hidden') ||
      INTERACTIVE_ROLES.has(role) ||
      (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable));
    let heuristic = false;
    if (!nativeInteractive && shown && hasBox) {
      const parentCursor = el.parentElement
        ? el.ownerDocument.defaultView.getComputedStyle(el.parentElement).cursor : '';
      const tabindex = el.getAttribute('tabindex');
      heuristic =
        el.hasAttribute('onclick') ||
        (tabindex !== null && tabindex !== '-1' && tag !== 'html' && tag !== 'body') ||
        (style.cursor === 'pointer' && parentCursor !== 'pointer');
    }

    if ((nativeInteractive || heuristic) && shown && (hasBox || tag === 'input')) {
      const ref = nextRef++;
      el.setAttribute(REF, String(ref));
      const name = clean(nameOf(el, tag), 80);
      const st = stateOf(el, tag, role);
      const label = role || (heuristic ? 'clickable' : tag);
      if (!push(`[${ref}] ${label} "${name}"${st ? ' ' + st : ''}`)) return;
      // Native controls are leaves; heuristic containers may hold real controls.
      if (!heuristic) return;
      ctx = { ...ctx, suppressText: true };
    } else if (/^h[1-6]$/.test(tag) && shown) {
      const t = clean(el.innerText, 160);
      if (t) push(`heading${tag[1]} "${t}"`);
      ctx = { ...ctx, suppressText: true };
    } else if (tag === 'img' && shown && hasBox && rect.width >= 32 && rect.height >= 32 && (el.alt || '').trim()) {
      push(`img "${clean(el.alt, 80)}"`);
    } else if (!ctx.suppressText && shown && !(tag === 'label' && el.control)) {
      // (Labels tied to a control are skipped: the control line already carries the label.)
      let direct = '';
      for (const c of el.childNodes) if (c.nodeType === 3) direct += c.textContent;
      direct = clean(direct, 300);
      if (direct.length > 1) push(`text "${direct}"`);
    }

    if (el.shadowRoot) for (const c of el.shadowRoot.children) visit(c, ctx);
    for (const c of el.children) visit(c, ctx);
  }

  visit(document.body || document.documentElement, { suppressText: false });

  const se = document.scrollingElement || document.documentElement;
  const header = [
    `Title: ${document.title}`,
    `URL: ${location.href}`,
    `Scroll: ${Math.round(se.scrollTop)} of ${Math.max(0, Math.round(se.scrollHeight - innerHeight))}px (viewport ${innerWidth}x${innerHeight})`,
    '',
  ];
  if (truncated) {
    lines.push(`… snapshot truncated at ${maxChars} chars. Scroll and snapshot again, or use get_text.`);
  }
  return { text: header.concat(lines).join('\n'), refs: nextRef - 1, truncated };
}

export async function snapshot(send, { maxChars = 20000 } = {}) {
  return evaluate(send, snapshotInPage, { maxChars });
}

// ---------------------------------------------------------------------------
// Finding an element by ref and computing where to click it
// ---------------------------------------------------------------------------

function locateInPage(arg) {
  const REF = 'data-cec-ref';
  function find(root) {
    const hit = root.querySelector(`[${REF}="${arg.ref}"]`);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const r = find(el.shadowRoot);
        if (r) return r;
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try {
          const d = el.contentDocument;
          if (d) { const r = find(d); if (r) return r; }
        } catch {}
      }
    }
    return null;
  }
  const el = find(document);
  if (!el) throw new Error(`No element with ref ${arg.ref} on the page. The page probably changed; take a new snapshot.`);

  const describe = (e) => {
    const t = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || '').replace(/\s+/g, ' ').trim();
    return `${e.tagName.toLowerCase()}${t ? ` "${t.slice(0, 60)}"` : ''}`;
  };

  if (arg.mode === 'focus') {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') throw new Error('This is a dropdown (<select>). Use select_option instead of type.');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.focus();
    if (arg.clear) {
      if (tag === 'input' || tag === 'textarea') {
        el.select();
      } else if (el.isContentEditable) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        const sel = el.ownerDocument.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    const active = el.ownerDocument.activeElement;
    return { focused: active === el || el.contains(active), desc: describe(el) };
  }

  if (arg.mode === 'select') {
    if (el.tagName.toLowerCase() !== 'select') {
      throw new Error('Element is not a <select> dropdown. Click it and then click the option instead.');
    }
    const want = String(arg.option).toLowerCase().trim();
    const options = Array.from(el.options);
    const match =
      options.find((o) => o.value.toLowerCase() === want) ||
      options.find((o) => o.text.trim().toLowerCase() === want) ||
      options.find((o) => o.text.toLowerCase().includes(want));
    if (!match) {
      throw new Error(`No option matching "${arg.option}". Options: ${options.map((o) => o.text.trim()).join(', ')}`);
    }
    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: match.text.trim(), desc: describe(el) };
  }

  if (arg.mode === 'scrollIntoView') {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { desc: describe(el) };
  }

  // mode === 'point': where to click
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) {
    return { zeroSize: true, desc: describe(el) };
  }
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  let win = el.ownerDocument.defaultView;
  while (win && win.frameElement) {
    const fr = win.frameElement.getBoundingClientRect();
    x += fr.left + win.frameElement.clientLeft;
    y += fr.top + win.frameElement.clientTop;
    win = win.parent;
  }
  let covered = null;
  if (el.ownerDocument === document) {
    let hit = el.getRootNode().elementFromPoint
      ? el.getRootNode().elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      : document.elementFromPoint(x, y);
    if (hit && hit.tagName !== 'CEC-OVERLAY' && hit !== el && !el.contains(hit) && !hit.contains(el)) covered = describe(hit);
  }
  return { x, y, covered, desc: describe(el) };
}

function jsClickInPage(arg) {
  const el = (function find(root) {
    const hit = root.querySelector(`[data-cec-ref="${arg.ref}"]`);
    if (hit) return hit;
    for (const e of root.querySelectorAll('*')) {
      if (e.shadowRoot) { const r = find(e.shadowRoot); if (r) return r; }
    }
    return null;
  })(document);
  if (!el) throw new Error(`No element with ref ${arg.ref}.`);
  el.click();
  return true;
}

// ---------------------------------------------------------------------------
// Input actions
// ---------------------------------------------------------------------------

/**
 * `onPoint(x, y)` (optional) is awaited just before the mouse goes down, e.g.
 * to animate the on-page cursor to the click point.
 */
export async function click(send, { ref, button = 'left', doubleClick = false, onPoint }) {
  const pt = await evaluate(send, locateInPage, { ref, mode: 'point' });
  if (pt.zeroSize) {
    // Visually hidden controls (e.g. styled checkboxes): fall back to a DOM click.
    await evaluate(send, jsClickInPage, { ref });
    await settle(send);
    return `Clicked ${pt.desc} (element has no visible box; used a DOM click).`;
  }
  if (onPoint) await onPoint(pt.x, pt.y);
  const base = { x: pt.x, y: pt.y, button, modifiers: 0 };
  const buttonsMask = { left: 1, right: 2, middle: 4 }[button] || 1;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
  const clicks = doubleClick ? [1, 2] : [1];
  for (const clickCount of clicks) {
    await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', clickCount, buttons: buttonsMask });
    await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', clickCount, buttons: 0 });
  }
  await settle(send);
  let msg = `${doubleClick ? 'Double-clicked' : 'Clicked'} ${pt.desc}.`;
  if (pt.covered) msg += ` Note: the click point was covered by ${pt.covered}; if nothing happened, close that overlay first.`;
  return msg;
}

const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODIFIERS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

function parseKey(combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Key is empty.');
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${m}". Use Ctrl, Alt, Shift or Meta.`);
    modifiers |= bit;
  }
  const last = parts[parts.length - 1];
  let def = KEYS[last.toLowerCase()];
  if (!def) {
    if (last.length !== 1) {
      throw new Error(`Unknown key "${last}". Use a single character or one of: ${Object.keys(KEYS).join(', ')}.`);
    }
    const upper = last.toUpperCase();
    const isLetter = /[A-Z]/.test(upper);
    const isDigit = /[0-9]/.test(last);
    // "Ctrl+K" means the K key: browsers report e.key "k" unless Shift is held.
    const ch = isLetter ? (modifiers & 8 ? upper : last.toLowerCase()) : last;
    def = {
      key: ch,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${last}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: ch,
    };
  }
  // With Ctrl/Alt/Meta held, a key produces a shortcut, not text.
  const text = modifiers & (1 | 2 | 4) ? undefined : def.text;
  return { ...def, text, modifiers };
}

export async function pressKey(send, { key }) {
  const k = parseKey(key);
  const common = {
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
    modifiers: k.modifiers,
  };
  await send('Input.dispatchKeyEvent', {
    ...common,
    type: k.text ? 'keyDown' : 'rawKeyDown',
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
  await settle(send);
  return `Pressed ${key}.`;
}

export async function type(send, { ref, text, clear = true, submit = false, onPoint }) {
  if (onPoint) {
    const pt = await evaluate(send, locateInPage, { ref, mode: 'point' });
    if (!pt.zeroSize) await onPoint(pt.x, pt.y);
  }
  const res = await evaluate(send, locateInPage, { ref, mode: 'focus', clear });
  if (!res.focused) {
    // Some widgets only take focus from a real click.
    await click(send, { ref });
  }
  if (text) {
    await send('Input.insertText', { text: String(text) });
  } else if (clear) {
    await pressKey(send, { key: 'Backspace' });
  }
  if (submit) await pressKey(send, { key: 'Enter' });
  else await sleep(150);
  return `Typed ${text ? `${String(text).length} characters` : 'nothing (cleared)'} into ${res.desc}${submit ? ' and pressed Enter' : ''}.`;
}

export async function selectOption(send, { ref, option }) {
  const res = await evaluate(send, locateInPage, { ref, mode: 'select', option });
  await settle(send);
  return `Selected "${res.selected}" in ${res.desc}.`;
}

export async function scroll(send, { direction = 'down', amount, ref } = {}) {
  if (ref != null) {
    const res = await evaluate(send, locateInPage, { ref, mode: 'scrollIntoView' });
    await sleep(200);
    return `Scrolled ${res.desc} into view.`;
  }
  const vp = await evaluate(send, () => ({ w: innerWidth, h: innerHeight }));
  const step = amount || Math.round((direction === 'left' || direction === 'right' ? vp.w : vp.h) * 0.8);
  const delta = {
    down: [0, step], up: [0, -step], right: [step, 0], left: [-step, 0],
  }[direction];
  if (!delta) throw new Error('direction must be up, down, left or right.');
  // A wheel event at the viewport centre scrolls whatever is under it, which
  // also works for apps whose content lives in an inner scrolling panel.
  await evaluate(send, () => {
    window.__cecScrolled = false;
    document.addEventListener('scroll', () => { window.__cecScrolled = true; }, { capture: true, once: true });
  });
  const cx = Math.round(vp.w / 2);
  const cy = Math.round(vp.h / 2);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: delta[0], deltaY: delta[1] });
  await sleep(300);
  // If the wheel landed on something that swallowed it (e.g. a cross-origin
  // iframe) nothing scrolls; fall back to scrolling the window directly.
  await evaluate(send, (d) => { if (!window.__cecScrolled) window.scrollBy(d[0], d[1]); }, delta);
  const pos = await evaluate(send, () => {
    const se = document.scrollingElement || document.documentElement;
    return { top: Math.round(se.scrollTop), max: Math.max(0, Math.round(se.scrollHeight - innerHeight)) };
  });
  return `Scrolled ${direction}. Page scroll is now ${pos.top} of ${pos.max}px.`;
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

export async function screenshot(send, { maxWidth = 1280, quality = 70 } = {}) {
  const m = await send('Page.getLayoutMetrics', {});
  const vv = m.cssVisualViewport || m.visualViewport;
  const width = vv.clientWidth;
  const height = vv.clientHeight;
  const scale = width > maxWidth ? maxWidth / width : 1;
  const res = await send('Page.captureScreenshot', {
    format: 'jpeg',
    quality,
    clip: { x: vv.pageX, y: vv.pageY, width, height, scale },
  });
  return { data: res.data, mimeType: 'image/jpeg', width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function getText(send, { offset = 0, maxChars = 20000 } = {}) {
  return evaluate(send, (a) => {
    const full = (document.body ? document.body.innerText : '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const chunk = full.slice(a.offset, a.offset + a.maxChars);
    return {
      title: document.title,
      url: location.href,
      text: chunk,
      total: full.length,
      nextOffset: a.offset + chunk.length < full.length ? a.offset + chunk.length : null,
    };
  }, { offset, maxChars });
}

export async function navigate(send, { url }) {
  const target = String(url || '').trim().toLowerCase();
  if (target === 'back' || target === 'forward') {
    await evaluate(send, (dir) => { dir === 'back' ? history.back() : history.forward(); }, target);
    await settle(send);
    return `Went ${target}.`;
  }
  if (target === 'reload') {
    await send('Page.reload', {});
    await settle(send);
    return 'Reloaded the page.';
  }
  const href = normalizeUrl(url);
  const res = await send('Page.navigate', { url: href });
  if (res.errorText) throw new Error(`Navigation to ${href} failed: ${res.errorText}`);
  const loaded = await waitForLoad(send, 15000);
  return loaded ? `Opened ${href}.` : `Opened ${href} (page is still loading).`;
}

export async function waitFor(send, { text, timeoutMs = 10000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = await evaluate(send, (t) => !!document.body && document.body.innerText.includes(t), text);
      if (found) return `Found "${text}" on the page.`;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for "${text}".`);
}

export const _internal = { parseKey, REF_ATTR };
