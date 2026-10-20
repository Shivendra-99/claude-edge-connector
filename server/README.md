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

You also need the Claude Connector extension in Edge. Setup, tools and the security model are in the [main README](https://github.com/Shivendra-99/claude-edge-connector#readme).
