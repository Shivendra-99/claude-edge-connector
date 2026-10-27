# Claude Connector for Edge

[![npm version](https://img.shields.io/npm/v/claude-edge-connector.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/claude-edge-connector)
[![node version](https://img.shields.io/node/v/claude-edge-connector.svg?style=flat-square)](https://www.npmjs.com/package/claude-edge-connector)
[![GitHub release](https://img.shields.io/github/v/release/Shivendra-99/claude-edge-connector?style=flat-square&color=blue)](https://github.com/Shivendra-99/claude-edge-connector/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)](LICENSE)

**Let Claude (or any MCP app) use your Microsoft Edge tabs.** It works in your real browser with your logins, and only in the tabs you choose.

Claude Connector is an Edge extension plus a small local server. Your AI app talks to the server over [MCP](https://modelcontextprotocol.io); the server passes commands to the extension, which reads and controls the tabs you've shared. It works with Claude Desktop, Claude Code, Cursor, VS Code and any other MCP client.

> **Unofficial.** Claude Connector for Edge is an independent open-source project. It is not made, endorsed or supported by Anthropic or Microsoft. Claude is a trademark of Anthropic, PBC.

```
Claude Desktop / Claude Code / Cursor / …
            │  MCP over stdio
            ▼
     claude-edge-connector  (Node.js, on your computer)
            │  WebSocket, 127.0.0.1 only
            ▼
     Claude Connector extension in Edge
            │  DevTools Protocol (chrome.debugger)
            ▼
     the tabs you shared
```

## Setup

You need Microsoft Edge and [Node.js](https://nodejs.org) 18.20 or newer.

### 1. Install the extension

- **From Edge Add-ons (recommended):** [**Get Claude Connector for Edge**](https://microsoftedge.microsoft.com/addons/detail/claude-connector-for-edge/ljllimlbebgjmknelmbfddoejjbblkii) and click **Get**. Edge keeps it updated.
- **From a GitHub release:**
  1. Download `claude-edge-connector-<version>.zip` from the [latest release](https://github.com/Shivendra-99/claude-edge-connector/releases/latest) and unzip it into its own folder. Keep that folder; Edge loads the extension from it.
  2. Open `edge://extensions` and turn on **Developer mode** (bottom left).
  3. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` in it).

  To update, unzip the new release over the same folder and click **Reload** on the extension card.
- **From source:** download this repo and follow the same steps, picking the `extension` folder.

### 2. Add the server to your AI app

**Claude Desktop:** open Settings → Developer → Edit Config, add Claude Connector to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "edge": {
      "command": "npx",
      "args": ["-y", "claude-edge-connector"]
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add edge -- npx -y claude-edge-connector
```

**Cursor, VS Code and other MCP clients:** use the command `npx -y claude-edge-connector`.

<details>
<summary>Running from a local copy instead of npm</summary>

Run `npm install` in the repo root, then point your app at the file directly:

```json
{
  "mcpServers": {
    "edge": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-edge-connector\\server\\src\\index.js"]
    }
  }
}
```

If `npx` isn't found on Windows, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "claude-edge-connector"]`.
</details>

### 3. Check it works

With Edge open, run:

```sh
npx claude-edge-connector --check
```

It should print `OK: connected to Microsoft Edge …`. The extension popup also shows a green **Connected** dot and the name of your AI app.

## Using it

- **Share a tab:** click the Claude Connector icon and choose **Let AI use this tab**. The icon shows an **AI** badge on shared tabs.
- **Or just ask:** "Open flipkart.com and find phone covers under ₹500." The AI can open its own tabs (you can turn this off in the extension's settings).
- **See what the AI is doing:** everything is labelled with the name of the AI app that is acting (Claude Desktop, Claude Code, Gemini CLI, Cursor, GitHub Copilot, …).
  - Tabs the AI can use sit in an orange tab group named after the app, for example **Gemini CLI**. Its title changes to **Gemini CLI · working** while the app is acting in one of them.
  - While the AI works in a tab, the page gets a soft orange glow, an animated cursor that moves to whatever it clicks or types into, and a **Gemini CLI is working in this tab** pill at the bottom.
  - The cursor, glow and pill are never shown to the AI: they're left out of page outlines, and hidden while it takes screenshots. You can turn them, or the tab group, off in Settings.
  - Tabs that are already in one of your own groups stay where they are.
- **Stop:** click **Stop** on the pill in the page, **Stop** next to a tab in the popup, **Stop all**, or press **Cancel** on Edge's "Claude Connector for Edge started debugging this browser" bar.
- **The debugging bar:** Edge shows it on every tab while the AI is working in one of them, and it goes away about 30 seconds after the AI's last action. The popup marks the tab the AI is working in right now.

### Tools the AI gets

| Tool | What it does |
| --- | --- |
| `browser_tabs` | List the tabs shared with the AI |
| `browser_open_tab` | Open a URL in a new tab |
| `browser_navigate` | Go to a URL, or back / forward / reload |
| `browser_snapshot` | Read the page as a text outline with numbered `[n]` refs for every button, link and field |
| `browser_click` | Click an element by ref |
| `browser_type` | Type into a field by ref, optionally pressing Enter |
| `browser_select_option` | Pick an option in a dropdown |
| `browser_press_key` | Press a key or shortcut (`Enter`, `Escape`, `Ctrl+A`, …) |
| `browser_scroll` | Scroll the page, or scroll an element into view |
| `browser_screenshot` | Screenshot of the visible part of the page |
| `browser_get_text` | Full readable text of the page, in chunks |
| `browser_wait` | Wait for text to appear, or wait a few seconds |
| `browser_close_tab` | Close a shared tab |

A snapshot looks like this:

```
Title: Checkout
URL: https://shop.example.com/checkout
Scroll: 0 of 1840px (viewport 1280x720)

heading1 "Checkout"
[1] textbox "Email address" value=""
[2] textbox "Password" value="••••"
[3] checkbox "I accept the terms" unchecked
[4] combobox "Country" selected="Choose…" options=["Choose…", "India", "United States"]
[5] button "Place order"
```

## Safety

An AI that can click around in your logged-in browser is powerful, so Claude Connector puts you in control:

- **Opt-in per tab.** The AI can only see and control tabs you've shared, plus tabs it opened itself (you can turn that off).
- **Blocked sites.** List domains (your bank, your work email) that Claude Connector will never touch, even if a tab is shared.
- **Always visible.** Edge shows its debugging bar whenever the AI is acting in a tab, and pressing **Cancel** there revokes everything. The extension lets go of a tab 30 seconds after the AI's last action, so the bar isn't left up while nothing is happening.
- **Local only.** The server listens on `127.0.0.1` and refuses connections from web pages (it checks `Origin` and `Host`, so DNS-rebinding tricks don't work either). Set `EDGE_CONNECTOR_EXTENSION_IDS=ljllimlbebgjmknelmbfddoejjbblkii` to allow only the official Edge Add-ons extension (an unpacked copy gets a different id).
- **No telemetry.** Claude Connector itself sends nothing anywhere. Page content goes only to the AI app you connected, which sends it to its model. See [PRIVACY.md](PRIVACY.md).
- **Passwords are masked** in snapshots.
- **Prompt injection is real.** Web pages can contain text written to trick AI agents. Claude Connector labels all page content as untrusted and tells the model to confirm with you before payments, messages, deletions or account changes, but no AI is immune. Keep sensitive sites on the blocked list and watch what the agent does.

## Limitations (v0.1)

- Cross-origin iframes (embedded payment forms, some login widgets) are listed but can't be read or clicked yet.
- Canvas-based apps (spreadsheet grids, design tools) don't expose elements; screenshots work, but clicking by coordinates isn't supported yet.
- No file uploads, downloads or drag-and-drop yet.
- If a background tab doesn't respond, switch to it.
- One Edge profile at a time (the most recently connected one wins).
- Work-managed Edge profiles may block extensions or the debugger API by policy.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `EDGE_CONNECTOR_PORT` | `18765` | Port the extension connects to. If you change it, change it in the extension's settings too. |
| `EDGE_CONNECTOR_EXTENSION_IDS` | *(any)* | Comma-separated extension ids allowed to connect. |
| `EDGE_CONNECTOR_CONNECT_WAIT_MS` | `15000` | How long a tool call waits for the extension to (re)connect. |

If you use several MCP apps at once (say Claude Desktop and Claude Code), they share one connection automatically: the first server to start owns the port and the others relay through it.

## Troubleshooting

**"The Claude Connector extension is not connected"**: make sure Edge is open and the extension is enabled, then run `npx claude-edge-connector --check`. Edge may pause the extension when idle; it reconnects within 30 seconds.

**Port already in use by something else**: pick another port with `EDGE_CONNECTOR_PORT` in your app's config (`"env": { "EDGE_CONNECTOR_PORT": "18766" }`) and set the same port in the extension's settings.

## Development

```sh
npm install
npx playwright install chromium   # for the tests
npm test                          # unit, server and full browser end-to-end tests
npm run pack                      # builds dist/claude-edge-connector-<version>.zip for Edge Add-ons
```

```
extension/        the Edge extension (Manifest V3)
  background.js   connection to the server, tab sharing, request handling
  cdp-actions.js  snapshot / click / type / … over the DevTools Protocol
  popup.*         the toolbar popup
server/           the MCP server, published to npm as claude-edge-connector
  src/bridge.js   WebSocket bridge (hub/peer, origin checks)
  src/tools.js    MCP tool definitions
test/             node:test suites; e2e.test.mjs loads the real extension in Chromium
store/            Edge Add-ons listing text and logo
```

`cdp-actions.js` takes a plain `send(method, params)` function, so the same code runs in the extension and in Node tests against real Chromium.

See [PUBLISHING.md](PUBLISHING.md) for releasing to npm and Edge Add-ons.

## License

MIT
