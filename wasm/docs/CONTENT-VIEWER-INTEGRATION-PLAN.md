# Tresorit content-viewer integration — plan

Status: **planning** (no PR until explicitly approved). Progress tracked
via the CI-local lane → https://coolwasmfiles.z6.web.core.windows.net/local-builds/

## Goal

Replace our current viewer with the **Tresorit content-viewer**
(`content-preview`, Bitbucket `tresorit/content-preview`) on the viewer
domain (`viewer.atgpartners.info`), hosted by us. The content-viewer
embeds **our WASM editor** and owns the service worker.

## Confirmed decisions (2026-07-09)

1. **Editor is same-origin to the content-viewer, SW-proxied** (bartha's
   proven model). The editor iframe is served at
   `viewer.atgpartners.info/collabora-<ver>/cool.html`; the content-viewer
   SW (`collabora-sw.js`, scope `/`) proxies the editor bytes from our
   editor Front Door and re-serves them same-origin. "Cross-origin" only
   in the sense that the *bytes originate* from our editor origin.
2. **Single-user** view/edit/save — no co-edit relay / checkpoints.
3. **Documents come from Tresorit storage** — our v2 encryption/storage,
   `message-relay`, and `viewer-server.js` REST API drop out of the path.
4. **Content-viewer replaces our viewer** on `viewer.atgpartners.info`;
   we host it.
5. Any content-viewer code changes branch from **bartha's branch**
   (= `origin/main`; the WEBCLIENT-23015 Collabora integration is merged
   there). Branch: `feature/wasm-editor-embed`.

## Reconciled architecture

```
Tresorit Web Access (host — Tresorit product, out of our scope)
  └─ [cross-origin iframe]  content-preview SPA  @ viewer.atgpartners.info   ← WE HOST
        ├─ Service Worker (collabora-sw.js, scope /)  — proxy editor bytes + stage doc
        └─ [same-origin iframe]  editor  @ viewer.atgpartners.info/collabora-<ver>/cool.html
                (bytes proxied by SW from our editor Front Door)
```

For our **dev/CI** there is no Tresorit host: the content-preview SPA is
itself the top page, driven through its standalone playground route
`/collabora-tester` (a real `<input type=file>` → open → edit → save-to-disk).
Docs come from that file input; in prod they come from Tresorit via the
host's `open-document`/`edit-document` postMessage.

## Repos / branches

| Repo | Branch | Base | Purpose |
|---|---|---|---|
| `szsz/online` | `feat/content-viewer-integration` | `origin/dev` | deployment (static server, systemd unit, build wiring) + any editor-side load-path change |
| `tresorit/content-preview` | `feature/wasm-editor-embed` | `origin/main` (bartha) | SW asset-path rewrite, version/CDN wiring, host-serving config |

## The #1 compatibility risk — editor doc-load contract (spike first)

bartha's content-viewer loads a doc by:
- building the iframe URL `…/cool.html?file_path=/tmp/<name>&localFileId=<id>&NotWOPIButIframe=true&permission=…`
- staging the plaintext bytes into the SW cache at `/local-file/{id}`
  (page → SW `{type:'setFile', id, name, data}`) **before** navigating the iframe.

So the editor build is expected to fetch `/local-file/{localFileId}` and
write it to Emscripten FS at `/tmp/<name>` (the stock Collabora
`NotWOPIButIframe` local-file path). **Our** editor build currently loads
via `/wasm/<id>` through `sw-bridge.js` → parent (the v2 path). We must
confirm whether our build already honors the `localFileId` + `/local-file/`
path, and if not, resolve the gap. Two resolution routes:
- **(A) editor-side**: add the `/local-file/{id}` → `/tmp/<name>` load path
  to our editor build (online repo).
- **(B) SW-side**: make `collabora-sw.js` stage/serve the doc where our
  editor already looks (`/wasm/<id>`) and pass our editor's expected URL
  params. (content-preview change.)

This spike gates everything else — do it in Phase 1.

## Editor asset-path mapping (known mismatch)

The SW proxies the **full pathname** verbatim: `/collabora-<ver>/X` →
`<VITE_COLLABORA_CDN_URL>/collabora-<ver>/X` (query dropped), expecting a
**flat** layout (`cool.html`, `online.js`, `online.wasm`, `soffice.data`,
`bundle.js/css`, `l10n-all.js`, `templates/files/presentation/*` all
directly under `collabora-<ver>/`). Our editor Front Door serves under
`/<APP_BUILD_ID>/browser/dist/*`. Resolve by either:
- **publish-side** (no code change): expose `collabora-<ver>/` on our
  editor CDN whose contents are our `browser/dist/`; set
  `VITE_COLLABORA_CDN_URL=<our editor origin>`, or
- **SW-side** (one-line, content-preview change): rewrite the pathname in
  `proxyRequest` (`collabora-sw.js`): `/collabora-<ver>/<rest>` →
  `<CDN>/<APP_BUILD_ID>/browser/dist/<rest>`.

Version format the content-viewer requires:
`VITE_COLLABORA_WASM_VERSION` = `YYYY-MM-DDTHH-MM-SSZ` (regex-enforced at
build). Our build IDs are `YYYY-MM-DD-<run>` — map/pin explicitly via the
pipeline param `collaboraWasmVersion` + `collaboraCdnUrl` rather than the
hardcoded `latest-collabora.txt` discovery.

## Deployment — content-viewer in place of the current viewer

Current viewer: `viewer-server.js` (Node/Express, serves
`wasm/viewer-public/` + v2 REST API) → `launch-viewer.sh` → systemd
`coolwasm-viewer@online.service` on :6934 (dev) / :7934 (CI), behind the
SNI router on :443 for `viewer.atgpartners.info`.

Replacement (keeps the systemd + SNI pattern):
1. **Build** `content-preview/dist/` with our editor env
   (`VITE_COLLABORA_WASM_VERSION`, `VITE_COLLABORA_CDN_URL`) — Node 20.19 +
   pnpm 9.5 (per their CI pins). `pnpm build` = `tsc -b && vite build`.
2. **Serve** `dist/` via a new small static server
   `wasm/content-viewer-server.js`:
   - static `dist/`, SPA fallback for the content-preview client routes
     (`collabora-tester`, `open-office-document`, `preload`,
     `view-document`, …) → `index.html`,
   - headers: `COOP: same-origin`, `COEP: credentialless`,
     `CORP: cross-origin` (bartha's known-good; `require-corp` was tried
     and reverted),
   - MIME for `.wasm`/`.data`, serve `/collabora-sw.js` at scope `/`.
   The SW's `rewrapForCache` already forces CORP+COEP on proxied editor
   assets, so our editor CDN only needs permissive CORS.
3. **systemd** `coolwasm-content-viewer@.service` replaces
   `coolwasm-viewer@` on the same port; SNI router already routes
   `viewer.atgpartners.info` there — no router change.
4. **Retire from this path**: `message-relay` (single-user) and the
   viewer's v2 REST API (docs come from Tresorit). Keep `editor-static`
   (dev) / Front Door (Azure) serving the editor bytes the SW proxies.

Prod/internal note: content-preview's own Azure pipeline deploys to the
`contentpreview` App Service (IIS/`web.config`). Our hosting replicates the
web.config's header + SPA-fallback rules in the Node static server for the
dev/CI stacks on `viewer.atgpartners.info`.

## Phases

0. **Branches** — DONE.
1. **Spike the editor doc-load contract** (the #1 risk). Point
   `/collabora-tester` at our editor build; determine `/local-file/{id}`
   support; pick resolution route (A editor-side / B SW-side).
2. **Editor asset-path mapping** (publish-side or SW rewrite) + version/CDN
   pinning.
3. **Deploy content-viewer instead of the viewer** — build wiring + static
   server + systemd unit + SNI (dev + CI stacks).
4. **Cross-origin isolation** end-to-end (COOP/COEP/CORP; CSP for our
   editor origin or rely on SW same-origin re-serve). Verify
   SharedArrayBuffer works through the nesting.
5. **Prod doc-flow contract** (host `open-document`/`edit-document`/
   `save-document`) — define; not hosted by us.
6. **E2E + CI-local** — Puppeteer drive `/collabora-tester`
   (open → edit → save round-trip) against our editor; publish to
   `local-builds/`.

## Open items / to confirm

- Bitbucket push auth for content-preview (VS Code askpass returns 500;
  use the saved token) — needed only at PR time.
- Whether "office-editor" (bartha's stated base) is our `szsz/online` or a
  separate Tresorit Collabora fork — determines how close our build is to
  the expected `/local-file/{id}` contract (Phase 1 spike answers this).
