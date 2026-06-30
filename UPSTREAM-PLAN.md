# UPSTREAM-PLAN.md — sorting the WASM fork for upstream contribution

## Orientation

- **Branch:** `wasm/upstream-prep`. HEAD tree == the tested sync (the
  result of rebasing ~783 fork commits onto Collabora's `co-25.04`).
- **Base:** `CollaboraOnline/online` `upstream/distro/collabora/co-25.04`
  = commit `3847fbcfe3`. The diff under analysis is
  `upstream/distro/collabora/co-25.04..HEAD` (630 files,
  +115,832 / -1,472).
- **Purpose:** This branch is the full sync, *reorganized by tier* so a
  human can carve clean upstream PRs out of it. Nothing here is meant to
  be merged to `co-25.04` wholesale.
  - **TIER 1** = recommend for upstream (generic WASM value, no
    fork/brand coupling).
  - **TIER 2** = fork-only, never upstream (rebrand, deploy/CI, the
    different product model — relay/viewer-server/V2 encryption — the
    Puppeteer harness, platform-lineage dirs co-25.04 already dropped,
    LO_BUILD_ID pinning, build scaffold).

The big numbers are Tier-2 by construction: the dropped platform dirs
(`macos/` 93, `qt/` 74, `windows/` 48, `ios/` 10, `android/` 5,
`gtk/` 3 = **233 files**) and the test harness (`wasm/tests/` **178
files**) together are ~65% of the changed paths but ~0% of upstream
interest.

---

## Rebrand caveat (read before any upstream PR)

The de-brand is one mechanical pattern plus a few one-liners. Two
classes:

### A. Pure-rebrand files — DROP entirely from upstream PRs
These files match `co-25.04` *except* a brand-string swap. They have
**zero** other changed lines, so upstreaming them = upstreaming nothing
but a regression of Collabora's own branding. Do not include:

| File | The only change |
|---|---|
| `browser/src/map/Clipboard.js` | `'Collabora Online Development Edition (unbranded)'` → `'Development Edition (unbranded)'` |
| `browser/src/layer/marker/ProgressOverlay.js` | same fallback-string swap |
| `browser/src/control/Toolbar.js` | same fallback-string swap |
| `browser/src/control/Control.AboutDialog.ts` | same fallback-string swap |
| `browser/src/map/handler/Map.WOPI.js` | `"Collabora Online not loaded…"` → `"Editor not loaded…"` |
| `browser/src/map/handler/Map.VersionBar.js` | `"Your Collabora Online server needs updating"` → `"Your server needs updating"` |
| `browser/src/control/Control.Zotero.js` | `"…prevent Collabora Online from updating citations…"` → `"…prevent the editor…"` |

### B. Entangled files — STRIP the brand hunks, keep the rest
These mix brand edits into otherwise-upstreamable changes. Strip the
listed hunks before the PR:

| File | Strip | Keep |
|---|---|---|
| `browser/src/app/Socket.ts` | 3× `'Collabora Online Development Edition (unbranded)'` fallback edits **and** the raw `console.log` `DBG_*`/`Cross-type:` trace lines | the hot-switch teardown/rebuild + `_onMessage` WASM raw-event logic (Tier-1) |
| `configure.ac` | version bump `25.04.10.3`→`26.04.0.1` and the `org.collabora.app` package-name hunk (fork-specific) | any genuine WASM build-option additions (review hunk-by-hunk) |
| `browser/html/debug.html` | `<title>` / page text rebrand | n/a (mostly rebrand → likely drop) |
| `browser/admin/adminIntegratorSettings.html.m4` | `<title>Collabora Online - Settings</title>` and `product-name` `<h1>` → `Editor` | n/a — review whether the rest is fork-only admin UI |
| `browser/html/cool.html.m4` | iframe `title="Collabora Online"` rebrand | n/a |
| `browser/html/load.doc.html` | "Load Collabora Online" text | n/a (fork test page) |
| `browser/html/wasm.html` | iframe title rebrand | n/a (fork page) |

> Copyright headers (`Copyright the Collabora Online contributors.`) added
> on **new** files are correct and should stay — they are not a rebrand.

---

## Upstream PR roadmap (Tier 1)

Ordered by dependency. Sizes are rough (S < 150 LOC, M 150–600, L > 600).

### PR-1 — WASM kit single-LO-loop + SECOND_INIT guard  `[TIER 1]`  L
- **Scope:** the single-loop owner gate / SECOND_INIT crash fix and the
  EMSCRIPTEN platform guards in the kit.
- **Paths:** `kit/Kit.cpp`, `kit/Kit.hpp`, `kit/KitWebSocket.cpp`,
  `kit/KitWebSocket.hpp`, `net/FakeSocket.cpp`.
- **Strip first:** none (no brand). Drop pure-debug `std::cerr` noise if any.
- **Deps:** none — foundation for PR-2/PR-3.

### PR-2 — WASM snapshot / warm-restore architecture (server side)  `[TIER 1]`  L
- **Scope:** deferred HEAPU8 snapshot, warm-restore, Plan-C pthread
  quiesce-and-rebuild, `wasm_reset_lo_init_owner` / `wasm_coolwsd_parked`
  / `wasm_quiesce_wake_main` hooks.
- **Paths:** `wsd/COOLWSD.cpp`, `wsd/COOLWSD.hpp`, `wsd/COOLWSDServer.hpp`,
  `wsd/ClientRequestDispatcher.cpp`, `wsd/ClientSession.cpp`,
  `wsd/DocumentBroker.cpp`, `wasm/wasmapp.cpp`, `wasm/wasmapp.hpp`,
  `common/Util-unix.cpp`, `common/Log.hpp`, `common/RenderTiles.hpp`,
  `common/FileUtil.cpp`, `common/Syscall.hpp` (new), `common/NumUtil.hpp`
  (new), `common/SettingsStorage.hpp` (new), `common/ClipboardData.hpp`
  (new).
- **Strip first:** none brand. `wasm/wasmapp.cpp/.hpp` are upstream-tracked
  WASM files (modified, not new) — clean.
- **Deps:** PR-1.

### PR-3 — WASM build scaffold for snapshot  `[TIER 1, with caveat]`  M
- **Scope:** Emscripten link/module changes that the snapshot needs
  (`ALLOW_MEMORY_GROWTH`+`MAXIMUM_MEMORY` under pthreads, KEEPALIVE
  exports). **Caveat:** much of the surrounding scaffold is szsz-specific
  (Tier-2). Upstream only the generic emscripten-flag hunks.
- **Paths (review hunk-by-hunk):** `wasm/Makefile.am`,
  `wasm/emscripten-module.js.m4`, `Makefile.am`, `configure.ac`.
- **Strip first:** `configure.ac` version bump + `org.collabora.app`
  (see Rebrand B). Fork build-id / deploy plumbing in `wasm/Makefile.am`.
- **Deps:** PR-2.

### PR-4 — Hot-switch / cross-type document switching (kit)  `[TIER 1]`  L
- **Scope:** in-place doc switch (`switchdocument`), per-doctype caps,
  the `Batch=true` → `DialogCancelMode::LOKSilent` leak fix.
- **Paths:** `kit/ChildSession.cpp`, `kit/ChildSession.hpp`.
- **Strip first:** none brand.
- **Deps:** PR-1.

### PR-5 — Hot-switch / cross-type teardown (browser)  `[TIER 1]`  M
- **Scope:** idempotent UI re-init and clean handler teardown across a
  cross-type swap.
- **Paths:** `browser/src/app/Socket.ts` (logic only),
  `browser/src/app/TilesMiddleware.ts`, `browser/src/control/Control.UIManager.ts`
  (idempotency refactor only — **strip the `?welcome=` slideshow block**),
  `browser/src/control/Parts.js`, `browser/src/control/Control.SheetsBar.js`,
  `browser/src/control/Control.Notebookbar.js`,
  `browser/src/layer/SplitPanesContext.ts`,
  `browser/src/layer/tile/CalcTileLayer.js`,
  `browser/src/layer/tile/ImpressTileLayer.js`,
  `browser/src/layer/tile/WriterTileLayer.js`,
  `browser/src/global.d.ts`.
- **Strip first:** `Socket.ts` 3 brand strings + `DBG_*`/`Cross-type:`
  `console.log` lines (Rebrand B); `Control.UIManager.ts` welcome block.
- **Deps:** PR-4 (server side enables it).

### PR-6 — Combobox / iconview `commandstatechanged` co-edit sync  `[TIER 1]`  M
- **Scope:** font/style combobox + stylesview reflect remote state via
  `commandstatechanged`; dispatch `CharFontName`/`FontHeight`/`StyleApply`.
- **Paths:** `browser/src/control/jsdialog/Widget.Combobox.js`,
  `browser/src/control/jsdialog/Widget.IconView.ts`,
  `browser/src/control/Control.NotebookbarBase.ts`,
  `browser/src/control/Control.NotebookbarBuilder.js`,
  `browser/src/control/Control.NotebookbarWriter.js`.
- **Strip first:** none brand.
- **Deps:** none.

### PR-7 — Notebookbar font-size list + Impress transition tiles  `[TIER 1]`  S
- **Scope:** canonical font-size list (replaces hardcoded single value);
  `singleclickactivate` + entry sizing so transition tiles render.
- **Paths:** `browser/src/control/Control.NotebookbarCalc.js`,
  `browser/src/control/Control.NotebookbarDraw.js`,
  `browser/src/control/Control.NotebookbarImpress.js`,
  `browser/src/control/Notebookbar.ImpressTransitionTab.ts`,
  `browser/css/notebookbar.css` (verify hunks are layout, not rebrand).
- **Deps:** none.

### PR-8 — Chunked per-locale l10n loading  `[TIER 1, with caveat]`  M
- **Scope:** the per-locale l10n generator + bundle glue.
- **Paths:** `browser/util/create-l10n-all-js.py` (new generator),
  `browser/bundle.js.m4`.
- **Strip first / caveat:** `bundle.js.m4` swaps `L10N_IOS_ALL_JS` →
  `L10N_ALL_JS`, which *removes* the iOS l10n include path. Upstream must
  **reconcile with the iOS path, not replace it** (co-25.04 dropped iOS,
  but upstream main may still ship it).
- **Deps:** none.

### PR-9 — Multi-language UI picker + WASM-spellcheck plumbing (browser side)  `[TIER 1]`  S
- **Scope:** BCP-47 extraction from `LanguageStatus`, reactive dict load
  on locale change, language-status wiring.
- **Paths:** `browser/src/control/Control.StatusBar.js`.
  (Server-side spell plumbing lives in the `kit/ChildSession.cpp` hunks of
  PR-4 — split those spell hunks into their own LO-core PR if cleaner.)
- **Deps:** none. (The runtime `wasm/dict-loader.js` is Tier-2 — coupled
  to the fork's relay-adapter loader, not upstreamable.)

### PR-10 — JSDialog robustness + debug-log gating  `[TIER 1]`  S
- **Scope:** small, independently valuable fixes: gate debug logs behind
  `JSDialog.verbose`, fix `?:`-vs-`+` precedence bug, alt-text from id,
  idempotent navigator rebuild, scrollbarbox handler, null-guards.
- **Paths:** `browser/src/control/Control.JSDialog.js`,
  `browser/src/control/Control.JSDialogBuilder.js`,
  `browser/src/control/Control.NavigatorPanel.ts`,
  `browser/src/control/jsdialog/Component.Base.ts`,
  `browser/src/control/jsdialog/Component.Toolbar.ts`,
  `browser/src/control/jsdialog/Util.Accessibility.ts`,
  `browser/src/control/jsdialog/Util.ModelState.ts`,
  `browser/src/control/jsdialog/Util.OnDemandRenderer.ts`,
  `browser/src/control/jsdialog/Util.ScrollableBar.ts`,
  `browser/src/control/jsdialog/Widget.OverflowGroup.ts`,
  `browser/src/control/jsdialog/Widget.OverflowManager.ts`,
  `browser/src/control/Control.NotebookbarBase.ts` (log-gating hunks only),
  `browser/src/docstatefunctions.js`, `browser/src/app/Events.ts`.
- **Note:** `Widget.OverflowManager.ts` also drops a
  `lastMaxWidth === innerWidth` short-circuit — confirm intended before PR.
- **Deps:** none.

---

## Fork-only (Tier 2) — never upstream

| Group | Paths | Why |
|---|---|---|
| Rebrand (pure) | the 7 files in Rebrand-A | de-brand only, regresses Collabora branding |
| Platform-lineage dirs | `macos/`, `qt/`, `windows/`, `ios/`, `android/`, `gtk/` | co-25.04 already dropped these |
| Puppeteer test harness | `wasm/tests/**` (178), `wasm/lib/**`, `wasm/probes/**`, `test/data/**` (14 fixtures) | fork's E2E sim harness |
| Message-relay / co-edit model | `wasm/message-relay.js`, `wasm/relay-adapter.js`, `wasm/launch-relay*.{sh,example}`, `wasm/CO-EDITING-ARCHITECTURE.md` | different product/co-edit model |
| Viewer-server + V2 encryption | `wasm/viewer-server.js`, `wasm/editor-server.js`, `wasm/editor-static-server.js`, `wasm/sni-router.js`, `wasm/launch-{viewer,sni-router,editor-static}.sh` | different product (V2 encrypted per-file) |
| Viewer-public UI | `wasm/viewer-public/**` (incl. `file-crypto.js`, `journey-recorder.js`, `ui-lang.js`) | fork front-end |
| SW bridge / wasm-loader | `wasm/sw.js`, `wasm/sw-bridge.js`, `wasm/wasm-loader.js`, `wasm/snapshot-inject*.js`, `wasm/patch-snapshot.sh` | `/wasm/` interception + szsz loader |
| Dict/l10n runtime loaders | `wasm/dict-loader.js`, `wasm/l10n-loader.js`, `wasm/build-dicts.sh`, `wasm/DICTIONARIES.md` | coupled to relay-adapter loader (concept is Tier-1; impl is fork) |
| Deploy pipeline | `wasm/deploy*.sh`, `wasm/promote-*.sh`, `wasm/publish-fork.sh`, `wasm/apply-front-door-rules.sh`, `wasm/deploy-front-door.sh`, `wasm/gc-old-deploys.sh`, `wasm/hash-deploy.sh`, `wasm/regen-brotli.sh`, `wasm/fetch-lo-build.sh`, `wasm/.env*.example`, `docs/front-door-rules.json` | Azure / per-deploy folders / Front Door |
| CI | `.github/workflows/*.yml`, `.github/scripts/wasm-ci/**` | fork CI on self-hosted runner |
| Build scaffold (fork) | `wasm/build-wasm.sh`, `wasm/build-split.sh`, `wasm/filter-linkdeps.sh`, `wasm/iterate.sh`, `wasm/poco-1.12.4-emscripten.patch`, `wasm/package.json`, `wasm/package-lock.json`, `wasm/Makefile.am` (fork hunks), `wasm/tools/**` | szsz build scaffold |
| LO_BUILD_ID pin | `wasm/LO_BUILD_ID`, `wasm/fetch-lo-build.sh` | different repo/cycle |
| Single-user-default + journey | `docs/single-user-editor.md`, `wasm/journey-to-test.js`, `wasm/journey-to-report.js`, single-user flip hunks in browser | fork default + recorder |
| Templates | `browser/templates/templates.js` | hardcoded fork template list |
| Reporting / misc infra | `wasm/generate-report.js`, `wasm/generate-junit.sh`, `wasm/profile-collect.js`, `wasm/run-*.sh`, `wasm/ai/**`, `wasm/*.md` (PLAN/PHASE2), `wasm/.gitignore`, root `.gitignore`, `CLAUDE.md`, `wasm/CLAUDE.md` | dev infra/docs |
| Brand-entangled HTML/admin | `browser/html/{debug,wasm,load.doc}.html`, `browser/admin/adminIntegratorSettings.html.m4`, `browser/html/cool.html.m4`, `browser/html/editor.html` | fork pages / strip brand if any hunk reused |

---

## Notes for the executor
- `browser/src/global.js` appears in `--name-only` but has an **empty
  diff** against base — ignore it (rename/no-op artifact).
- Every changed path lands in exactly one group above (Tier-1 PR-1..10 or
  a Tier-2 row). When carving a PR, `git checkout
  upstream/distro/collabora/co-25.04 -- <strip-paths>` is the quickest way
  to revert the brand/debug hunks listed in the Rebrand caveat before
  staging the rest.
