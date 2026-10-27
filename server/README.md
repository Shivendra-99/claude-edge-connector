# claude-edge-connector

MCP server for [Claude Connector](https://github.com/Shivendra-99/claude-edge-connector). It lets Claude Desktop, Claude Code, Cursor and other MCP apps read and control the Microsoft Edge tabs you share through the Claude Connector extension.

```sh
# Claude Code
claude mcp add edge -- npx -y claude-edge-connector

# check the extension can connect
npx claude-edge-connector --check
```

For Claude Desktop, add this to `claude_desktop_config.json`:

```json
{ "mcpServers": { "edge": { "command": "npx", "args": ["-y", "claude-edge-connector"] } } }
```

## You also need the Edge extension

This server can't reach your browser on its own: the Claude Connector extension in Edge is what reads and controls the tabs you share. Without it, every browser tool reports that the extension is not connected.

- **Edge Add-ons (recommended):** [**Get Claude Connector for Edge**](https://microsoftedge.microsoft.com/addons/detail/claude-connector-for-edge/ljllimlbebgjmknelmbfddoejjbblkii), click **Get**, then open its popup and share a tab. Edge keeps it updated.
- **Or from a GitHub release:**
  1. Download `claude-edge-connector-<version>.zip` from the [latest release](https://github.com/Shivendra-99/claude-edge-connector/releases/latest) and unzip it into its own folder. Keep that folder; Edge loads the extension from it.
  2. Open `edge://extensions` and turn on **Developer mode** (bottom left).
  3. Click **Load unpacked** and pick the unzipped folder (the one with `manifest.json` in it).
  4. Open the extension's popup, share a tab, and run `npx claude-edge-connector --check`.

Setup, tools and the security model are in the [main README](https://github.com/Shivendra-99/claude-edge-connector#readme).
