# claude-edge-connector

MCP server for [Claude Connector](https://github.com/Shivendra-99/claude-edge-connector). It lets Claude Desktop, Claude Code, Cursor and other MCP apps read and control the Microsoft Edge tabs you share through the Claude Connector extension.

This server can't reach your browser on its own: the Claude Connector extension in Edge is what reads and controls the tabs you share. Without it, every browser tool reports that the extension is not connected.

## 1. Install the Edge extension

Pick **one** option.

**Option A: Edge Add-ons store (recommended, no Developer mode)**

1. Open [**Claude Connector for Edge** on Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/claude-connector-for-edge/ljllimlbebgjmknelmbfddoejjbblkii).
2. Click **Get**, then **Add extension**.

That's it. Edge updates it automatically.

**Option B: Manual install (needs Developer mode)**

Only if you can't use the store, or want a build that isn't in the store yet.

1. Download `claude-edge-connector-<version>.zip` from the [latest release](https://github.com/Shivendra-99/claude-edge-connector/releases/latest) and unzip it into its own folder. Keep that folder; Edge loads the extension from it.
2. Open `edge://extensions` and turn on **Developer mode** (bottom left).
3. Click **Load unpacked** and pick the folder with `manifest.json` in it.

## 2. Add this server to your AI app

```sh
# Claude Code
claude mcp add edge -- npx -y claude-edge-connector
```

For Claude Desktop, add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{ "mcpServers": { "edge": { "command": "npx", "args": ["-y", "claude-edge-connector"] } } }
```

Cursor, VS Code and other MCP clients: use the command `npx -y claude-edge-connector`.

## 3. Share a tab and check

Click the Claude Connector icon in Edge and choose **Let AI use this tab**. Then, with Edge open, run:

```sh
npx claude-edge-connector --check
```

It should print `OK: connected to Microsoft Edge …`.

Tools, settings and the security model are in the [main README](https://github.com/Shivendra-99/claude-edge-connector#readme).
