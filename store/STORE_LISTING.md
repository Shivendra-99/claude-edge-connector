# Edge Add-ons listing (copy into Partner Center)

Check the current character limits in Partner Center; they occasionally change.

## Name

Claude Connector for Edge

## Short description

Unofficial open-source connector: let Claude and other MCP apps read and act in the Edge tabs you choose. Runs locally.

## Description

Unofficial, open-source connector. Not made, endorsed or supported by Anthropic.

Claude Connector lets AI apps like Claude Desktop, Claude Code, Cursor and VS Code use your Microsoft Edge browser: reading pages, clicking, typing and filling in forms, in your real browser with your existing logins.

You can always see which AI is doing what, labelled with the app's name (Claude, Gemini CLI, Cursor, GitHub Copilot, …):
• Tabs the AI can use go into an orange tab group named after the app.
• While the AI works in a tab, the page glows and an animated cursor shows where it is clicking and typing.
• A "Claude Code is working in this tab" pill (with the name of whichever app is acting) and a Stop button sits at the bottom of the page.

You stay in control:
• The AI can only use tabs you share (click the Claude Connector icon → "Let AI use this tab"), plus tabs it opens itself, which you can turn off.
• Block sites like your bank so Claude Connector never touches them.
• Edge shows a bar whenever the AI is working in a tab, and it disappears shortly after the AI stops. Press Cancel there to stop everything at once.
• Password fields are masked in what the AI sees.

How it works: Claude Connector connects to a small open-source MCP server (claude-edge-connector) that runs on your own computer and that your AI app starts. Claude Connector has no servers of its own and collects no data. Page content goes only to the AI app you connected.

What the AI can do:
• Open tabs and navigate
• Read a page as a compact outline of headings, text, links, buttons and form fields
• Click, type, choose dropdown options, press keys and scroll
• Take screenshots and read full page text

Setup takes two minutes:
1. Install this extension.
2. Add claude-edge-connector to your AI app, e.g. for Claude Code: claude mcp add edge -- npx -y claude-edge-connector
3. Run "npx claude-edge-connector --check" to confirm the connection.

Full instructions, source code and the security model: https://github.com/Shivendra-99/claude-edge-connector

Claude Connector for Edge is an independent open-source project, not made, endorsed or supported by Anthropic or Microsoft. Claude is a trademark of Anthropic, PBC.

## Category

Developer tools (alternative: Productivity)

## Search terms (up to 7)

1. AI agent
2. Claude
3. MCP
4. browser automation
5. AI browser control
6. Claude Desktop
7. Model Context Protocol

## Assets

- Logo (300×300): `store/logo-300.png`
- Screenshot (1280×800): `store/screenshot-1.png`
- Small promotional tile (440×280): `store/promo-small-440x280.png`
- Large promotional tile (1400×560): `store/promo-large-1400x560.png`

## Privacy policy URL

https://github.com/Shivendra-99/claude-edge-connector/blob/main/PRIVACY.md

## Permission justifications

**debugger**: The core feature. Claude Connector uses the DevTools Protocol to read the structure of pages the user has shared and to send real clicks and key presses to them, the same way Edge's DevTools does. It attaches only to tabs the user has shared (or that the AI opened when the user allows it), and Edge shows its standard "started debugging this browser" bar while attached. The extension detaches 30 seconds after the AI's last action, so it is only attached while the AI is actually working. While attached it also draws a visible indicator on the page (a glow, a cursor showing where the AI clicks, and a "Claude is working" pill with a Stop button) so the user always knows when the AI is acting; this indicator is hidden from the AI's own screenshots and page reads.

**tabs**: To list shared tabs with their titles and URLs, open new tabs when the user's AI app asks for one, close tabs, and enforce the user's blocked-site list.

**tabGroups**: To put the tabs the AI can use into a clearly labelled tab group named after the AI app, so the user can always see which tabs the AI has access to and when it is working. Tabs already in the user's own groups are never moved. Can be turned off in settings.

**storage**: To save the user's settings (port, blocked sites, whether the AI may open tabs, overlay and tab-group switches) and to remember which tabs are shared while the browser is open.

**alarms**: To reconnect to the local Claude Connector server after Edge suspends the extension's service worker.

Remote code: none. All code ships in the package; the extension connects only to ws://127.0.0.1 on the user's own machine.

## Notes for certification

Claude Connector needs a local companion server that the user's AI app normally starts. To test without an AI app:

1. Install Node.js 18.20 or newer.
2. With Edge open and Claude Connector installed, run in a terminal: `npx claude-edge-connector --demo`
3. The extension connects (the toolbar popup shows a green "Connected" dot). Claude Connector opens https://example.com in a new tab and the terminal prints the page outline an AI would receive.

To test sharing manually: open any website, click the Claude Connector icon and choose "Let AI use this tab". The icon shows an "AI" badge. When the AI acts in the tab, Edge shows its debugging bar, which disappears about 30 seconds after the last action. "Stop all" in the popup, or Cancel on the bar, revokes access.

Source code: https://github.com/Shivendra-99/claude-edge-connector
