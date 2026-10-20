// Runs the extension's CDP page actions against a real Chromium through
// Playwright's CDP session (the same protocol chrome.debugger speaks).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import * as actions from '../extension/cdp-actions.js';
import { startStaticServer } from './helpers.mjs';

let browser, page, send, site;

const refFor = (snap, pattern) => {
  const line = snap.text.split('\n').find((l) => pattern.test(l));
  assert.ok(line, `no snapshot line matching ${pattern}\n${snap.text}`);
  return Number(line.match(/^\[(\d+)\]/)[1]);
};
const resultText = () => page.textContent('#result');

before(async () => {
  site = await startStaticServer();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const cdp = await page.context().newCDPSession(page);
  send = (method, params) => cdp.send(method, params);
  await page.goto(`${site.url}/form.html`);
});

after(async () => {
  await browser?.close();
  await site?.close();
});

test('snapshot lists interactive elements with refs and skips hidden ones', async () => {
  const snap = await actions.snapshot(send, {});
  const t = snap.text;
  assert.match(t, /^Title: Connector test form/m);
  assert.match(t, /heading1 "Checkout"/);
  assert.match(t, /text "Fill in the form below and press Place order\."/);
  assert.match(t, /\[\d+\] link "Go to page two" href="\/page2\.html"/);
  assert.match(t, /\[\d+\] textbox "Email address" value=""/);
  assert.match(t, /\[\d+\] textbox "Password" value="••••"/, 'password must be masked');
  assert.doesNotMatch(t, /secret123/);
  assert.match(t, /\[\d+\] checkbox "I accept the terms" unchecked/);
  assert.match(t, /\[\d+\] combobox "Country" selected="Choose…" options=\["Choose…", "India", "United States"\]/);
  assert.match(t, /\[\d+\] textbox "Order notes"/);
  assert.match(t, /\[\d+\] textbox "Rich editor" value="old text"/);
  assert.match(t, /\[\d+\] clickable "Plan: Pro ₹499 \/ month"/);
  assert.match(t, /\[\d+\] button "Shadow button"/, 'open shadow DOM is walked');
  assert.match(t, /\[\d+\] button "Inside iframe"/, 'same-origin iframe is walked');
  assert.match(t, /frame \(cross-origin, not accessible\)/);
  assert.doesNotMatch(t, /Invisible button/);
  assert.ok(snap.refs >= 12);
});

test('type, select, check and submit a form', async () => {
  let snap = await actions.snapshot(send, {});
  await actions.type(send, { ref: refFor(snap, /textbox "Email address"/), text: 'test@example.com' });
  await actions.selectOption(send, { ref: refFor(snap, /combobox "Country"/), option: 'India' });
  await actions.click(send, { ref: refFor(snap, /checkbox "I accept the terms"/) });
  await actions.click(send, { ref: refFor(snap, /button "Place order"/) });
  assert.equal(await resultText(), 'Submitted: test@example.com / in / true');

  // Typing again with clear=true replaces the old value.
  snap = await actions.snapshot(send, {});
  assert.match(snap.text, /textbox "Email address" value="test@example\.com"/);
  await actions.type(send, { ref: refFor(snap, /textbox "Email address"/), text: 'new@example.com', submit: true });
  assert.equal(await page.inputValue('#email'), 'new@example.com');
  assert.equal(await resultText(), 'Submitted: new@example.com / in / true', 'Enter submits the form');
});

test('contenteditable typing replaces content', async () => {
  const snap = await actions.snapshot(send, {});
  await actions.type(send, { ref: refFor(snap, /textbox "Rich editor"/), text: 'hello editor' });
  assert.equal((await page.textContent('#editor')).trim(), 'hello editor');
});

test('clicks reach custom divs, shadow DOM, iframes and hidden inputs', async () => {
  let snap = await actions.snapshot(send, {});
  await actions.click(send, { ref: refFor(snap, /clickable "Plan: Pro/) });
  assert.equal(await resultText(), 'Card clicked');

  await actions.click(send, { ref: refFor(snap, /button "Shadow button"/) });
  assert.equal(await resultText(), 'Shadow clicked');

  await actions.click(send, { ref: refFor(snap, /button "Inside iframe"/) });
  assert.equal(await resultText(), 'iframe clicked');

  snap = await actions.snapshot(send, {});
  const msg = await actions.click(send, { ref: refFor(snap, /checkbox "Fancy toggle"/) });
  assert.match(msg, /DOM click/);
  assert.equal(await resultText(), 'Fancy is true');
});

test('stale refs give a clear error', async () => {
  await assert.rejects(actions.click(send, { ref: 9999 }), /take a new snapshot/);
});

test('key presses, including shortcuts', async () => {
  // The previous test left focus inside the iframe; keys go to the focused document.
  await page.focus('#email');
  await actions.pressKey(send, { key: 'Ctrl+K' });
  assert.equal(await page.textContent('#keys'), 'ctrl+k pressed');
  await actions.pressKey(send, { key: 'Escape' });
  assert.equal(await page.textContent('#keys'), 'escape pressed');
  await assert.rejects(actions.pressKey(send, { key: 'Hyper+X' }), /Unknown modifier/);
});

test('scroll moves the page and reports position', async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  const msg = await actions.scroll(send, { direction: 'down' });
  assert.match(msg, /Page scroll is now [1-9]\d* of \d+px/);
  const top = await page.evaluate(() => scrollY);
  assert.ok(top > 300, `expected to scroll, got ${top}`);
});

test('screenshot returns a jpeg of the viewport', async () => {
  const shot = await actions.screenshot(send, { maxWidth: 800 });
  assert.equal(shot.mimeType, 'image/jpeg');
  const buf = Buffer.from(shot.data, 'base64');
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  // JPEG SOF0 marker carries the real height/width; check the downscale happened.
  const sof = buf.indexOf(Buffer.from([0xff, 0xc0]));
  const height = buf.readUInt16BE(sof + 5);
  const width = buf.readUInt16BE(sof + 7);
  assert.equal(width, 800);
  assert.equal(height, 560);
});

test('get_text pages through long text', async () => {
  const first = await actions.getText(send, { maxChars: 50 });
  assert.equal(first.text.length, 50);
  assert.ok(first.nextOffset === 50 && first.total > 50);
  const second = await actions.getText(send, { offset: first.nextOffset, maxChars: 50 });
  assert.notEqual(second.text, first.text);
});

test('navigate, follow links, go back and wait for text', async () => {
  let snap = await actions.snapshot(send, {});
  await actions.click(send, { ref: refFor(snap, /link "Go to page two"/) });
  assert.match((await actions.pageInfo(send)).url, /page2\.html$/);

  snap = await actions.snapshot(send, {});
  await actions.click(send, { ref: refFor(snap, /button "Load more"/) });
  assert.match(await actions.waitFor(send, { text: 'Loaded later', timeoutMs: 5000 }), /Found/);
  await assert.rejects(actions.waitFor(send, { text: 'never appears', timeoutMs: 600 }), /Timed out/);

  await actions.navigate(send, { url: 'back' });
  assert.match((await actions.pageInfo(send)).url, /form\.html$/);

  const msg = await actions.navigate(send, { url: `${site.url}/page2.html` });
  assert.match(msg, /^Opened /);
  assert.equal((await actions.pageInfo(send)).title, 'Page two');
});

test('URL normalisation blocks dangerous schemes', () => {
  assert.equal(actions.normalizeUrl('example.com'), 'https://example.com/');
  assert.throws(() => actions.normalizeUrl('javascript:alert(1)'), /Only http and https/);
  assert.throws(() => actions.normalizeUrl('file:///etc/passwd'), /Only http and https/);
  assert.throws(() => actions.normalizeUrl('data:text/html,hi'), /Only http and https/);
});
