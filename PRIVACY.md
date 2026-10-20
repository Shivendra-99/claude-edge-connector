# Claude Connector for Edge: privacy policy

*Last updated: October 2026*

Claude Connector is an open-source browser extension and local server that let AI apps you choose (for example Claude Desktop) read and control Microsoft Edge tabs you share with them.

## What Claude Connector accesses

When you share a tab, or allow the AI to open tabs, Claude Connector can read that tab's content (text, form fields, page structure and screenshots) and act in it (click, type, navigate). It does this only for tabs you've shared or tabs the AI opened, and never for sites on your blocked list.

Password fields are masked in the page outlines Claude Connector produces.

## Where data goes

- The extension sends page data only to the Claude Connector server running on your own computer (`127.0.0.1`).
- The server passes it only to the AI app that started it. That app sends it to its AI model under its own privacy policy (for Claude, Anthropic's).
- Claude Connector has no servers of its own. It collects no analytics, telemetry or personal data, and it does not sell or share data with anyone.

## What is stored

- Your settings (port, blocked sites, whether the AI may open tabs) are saved in Edge's extension storage on your computer.
- The list of shared tabs is kept only until Edge closes.

## Contact

Questions or concerns: open an issue at <https://github.com/Shivendra-99/claude-edge-connector/issues>.
