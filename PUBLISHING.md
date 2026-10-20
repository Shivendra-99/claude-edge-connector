# Publishing checklist

Publish npm first: the Edge reviewers' test steps use `npx claude-edge-connector`.

## 0. Before the first release

- [ ] Check the name is still free: `npm view claude-edge-connector` should 404, and search Edge Add-ons for "Claude Connector".
- [ ] **Recommended: ask Anthropic about the name.** Anthropic's trademark guidelines don't allow names that imply Anthropic sponsors or is affiliated with a product, and Anthropic's own integrations are also called "connectors". Email marketing@anthropic.com with a link to the repo and the planned store listing, and ask whether "Claude Connector for Edge" is OK. If they say no, or Edge reviewers object, fall back to "Edge Connector for Claude" (rename with a find-and-replace of "Claude Connector"). Keep the "Unofficial … not made by Anthropic" lines in the README, store listing and popup either way.
- [x] GitHub user filled in (Shivendra-99).
- [ ] Add your name to `LICENSE` if you want it there instead of "Claude Connector for Edge contributors".
- [ ] `npm install && npx playwright install chromium && npm test`, all green.
- [ ] Try it for real in Edge: load unpacked, add the server to Claude Desktop, do a task on a real site.

## 1. GitHub

- [ ] Create the repo and push.
- [ ] The CI workflow in `.github/workflows/test.yml` runs the full test suite on each push.

## 2. npm

```sh
cd server
npm login
npm publish --access public
```

Then check from a clean folder: `npx -y claude-edge-connector --version`.

## 3. Edge Add-ons

1. Register as an Edge extension developer in Microsoft Partner Center. It's free, and you can sign in with GitHub.
2. `npm run pack` builds `dist/claude-edge-connector-<version>.zip`.
3. Partner Center → Microsoft Edge → **Create new extension** → upload the zip.
4. **Availability:** Public, all markets (or pick).
5. **Properties:** category, privacy policy URL, website (GitHub repo), support contact. Answer the "uses personal data" questions honestly: the extension reads page content locally and passes it to the user's chosen AI app.
6. **Store listing:** copy from `store/STORE_LISTING.md`; upload `store/logo-300.png` and 1280×800 screenshots.
7. **Submit**, pasting the "Notes for certification" from `store/STORE_LISTING.md`. Reviews can take up to about a week, and the `debugger` permission means a careful review, so expect questions.

## 4. After approval

- [ ] Put the Edge Add-ons link in `README.md`.
- [ ] Note the store extension id. Users can lock their server to it with `EDGE_CONNECTOR_EXTENSION_IDS=<id>`; consider making it the default allow-list in `server/src/index.js` so other extensions cannot pose as Claude Connector.

## Releasing an update

1. Bump the version in `extension/manifest.json` and/or `server/package.json`.
2. `npm test`
3. `cd server && npm publish` for server changes.
4. `npm run pack` and upload the new zip in Partner Center for extension changes.
