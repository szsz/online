#!/usr/bin/env bash
# run-all-tests.sh — Run all WASM co-editing tests, generate per-test HTML
# reports and a summary index page.
#
# Usage:  bash wasm/run-all-tests.sh

set -uo pipefail

# Prevent MSYS/Git-Bash from rewriting Unix-style paths when we pass them
# to Node. Without this, `node foo.js --shots /tmp/...` arrives in node
# as a Windows path the test scripts don't write to, and every report
# says "No screenshots found".
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The test scripts (node) write screenshots with paths like
# '/tmp/static-deploy/public/shots-…' which, on Windows, node resolves
# to C:\tmp\static-deploy\public\shots-…. On Linux the same literal path
# resolves to /tmp/… — so we just need to pick a consistent base for
# THIS script (bash) that matches what node sees, then pass it through.
#
# On MSYS/Git-Bash, `/tmp` is mounted to %TEMP% (AppData\Local\Temp),
# which is NOT the same as what node sees. Use `cygpath` to resolve the
# Windows path the shell will also see if it exists; fall back to /tmp.
if command -v cygpath >/dev/null 2>&1; then
    # /tmp/… resolved the way node sees it on Windows
    TEST_OUTPUT_ROOT="${TEST_OUTPUT_ROOT:-C:/tmp/static-deploy/public}"
else
    TEST_OUTPUT_ROOT="${TEST_OUTPUT_ROOT:-/tmp/static-deploy/public}"
fi

REPORTS_DIR="$TEST_OUTPUT_ROOT/reports"
SHOTS_BASE="$TEST_OUTPUT_ROOT"
GENERATOR="$SCRIPT_DIR/generate-report.js"

mkdir -p "$REPORTS_DIR"
echo "Test output root: $TEST_OUTPUT_ROOT"

# ── Test definitions ────────────────────────────────────────────────────
# Each entry:  slug | script | human name | description | shots_dir_name
TESTS=(
    "regression-editor-static-fresh|tests/regression/test-regression-editor-static-fresh.js|Regression: editor-static-server serves /browser/dist/|catches stale editor-static-server processes that predate PR #78's /browser/dist/<x> → /browser/<x> rewrite. Symptom of staleness: viewer cold-open 404s on cool.html → kit never starts → ~40-test cluster fails with frame-detach. Fast (<1s) gate at top of suite so red herrings don't fill other test logs.|none"
    "regression-editor-fd-wasm-fetchable|tests/regression/test-regression-editor-fd-wasm-fetchable.js|Regression: editor FD per-deploy WASM assets reachable|catches the case where cool.html loads but online.wasm + soffice.data return 404/HTML from the per-deploy folder. Symptom diagnosed on build 2026-05-16-113700: kit fires 47 reqs / 0.05 MB total instead of expected 96 MB; kit never starts → ~60-test cluster fails. Fast (~2s) HEAD + range-GET probe.|none"
    "regression-jobs-scale-watchdog|tests/regression/test-regression-jobs-scale-watchdog.js|Regression: JOBS_SCALE watchdog wiring|viewer-public/index.html cross-type canvas-paint watchdog must scale with window.__JOBS_SCALE (read from ?ws= URL param). lib/open-via-viewer.js must inject ?ws=\$JOBS_SCALE when JOBS_SCALE>1. Without this widening, JOBS=2 runs hit the 180s watchdog before kit paints heavy docs and the iframe gets torn down mid-test.|none"
    "regression-cool-html-substitution|tests/regression/test-regression-cool-html-substitution.js|Regression: cool.html template substitution in editor-static-server|editor-static-server.js must substitute %ACCESS_TOKEN%, %ACCESS_TOKEN_TTL%, %BRANDING_THEME% etc. at read time. Without it the kit reads cool.html, finds literal %ACCESS_TOKEN%, appends it to /wasm/[fileId]?access_token=%ACCESS_TOKEN%&amp;access_token_ttl=%ACCESS_TOKEN_TTL%, gets 404, exits at COOLWSD::run() entry — every kit-paint test (chart, caching, e2e-upload, singleuser, pptx-viewer, snapshot-milestones, ~25 more) hangs with shield-up. deploy-front-door.sh does the same substitution via sed at FD upload time.|none"
    "regression-snapshot-injection|tests/regression/test-regression-snapshot-injection.js|Regression: Snapshot Injection|deploy.sh HEAPU8 restore injection must be present in online.js — missing → warm visits re-run full init|none"
    "regression-wopi-ready|tests/regression/test-regression-wopi-ready.js|Regression: Viewer arms WOPI postMessage gate|viewer-public/index.html sends Host_PostmessageReady to the editor iframe on load — fix for window.WOPIPostmessageReady never flipping true in cool.html and Map.WOPI.js:541 dropping every parent postMessage with 'PostMessage ignored: not ready.' log spam. Mirrors framed.html's canonical pattern.|none"
    "regression-print-button|tests/regression/test-regression-print-button.js|Regression: Print button → blob URL|WASM-mode print short-circuits the dead /<urlPrefix>/<doc>/download/<id> HTTP route and reads print.pdf from Module.FS directly (CanvasTileLayer._onDownloadAsMsg). Asserts iframe.contentWindow.print() fires with a blob: URL whose body starts with %PDF-.|none"
    "regression-console-noise-budget|tests/regression/test-regression-console-noise-budget.js|Regression: Console-noise budget|Tripwire for the single-user cold-open console-log floor. Opens new.docx in ?singleuser, captures every console + pageerror, asserts total < 600 lines / 80 KB. Today ~1748 / 145 KB → test FAILS until Phases 1+2 of the cleanup (delete OverflowManager/OverflowGroup debug + gate JSDialog chatter behind ?debug=jsdialog) land. See ai/tasks/todo/console-log-cleanup.md.|shots-regression-console-noise-budget"
    "regression-editing-session-spam|tests/regression/test-regression-editing-session-spam.js|Regression: Editing-session console spam|Sibling of console-noise-budget but covers the LIVE-EDITING path the user actually triggers: open new.docx, click, type ~150 chars, scroll 10 ticks, quiesce 5s, count every console + pageerror. User-reported 2026-06-07 saw 500000+ lines of __emscripten_thread_mailbox_await stack-trace spam over a multi-hour session; cold-open test (1748→379 lines) totally missed it because per-layout-tick chatter (OverflowManager.onResize ~10/s) only stacks up during editing. Asserts total <650 lines / 90 KB.|shots-regression-editing-session-spam"
    "regression-writer-navigator-flash|tests/regression/test-regression-writer-navigator-flash.js|Regression: Writer Navigator does not flash|Clicks the floating Navigator icon; asserts the navigation-sidebar stays visible after a 2 s settle. Pre-fix createFloatingNavigatorBtn bound the click listener twice (initializeImpl runs twice on cold open), so one user click dispatched .uno:Navigator twice → kit toggled open then closed → panel flashed. Locks the Control.NavigatorPanel.ts idempotency guard.|shots-regression-writer-navigator-flash"
    "regression-snapshot-survival|tests/regression/test-regression-snapshot-survival.js|Regression: Snapshot Survival across watchdog cycle|Heavy 50-slide pptx that exceeds the cross-type canvas-paint watchdog: snapshot must survive in Cache Storage so the next visit can warm-restore (was previously wiped by ?planc=0 path, putting the user in a permanent cold-loop). See incident 2026-05-06.|shots-regression-snapshot-survival"
    "regression-checkpoint-cursor-delete|tests/regression/test-regression-checkpoint-cursor-delete.js|Regression: Checkpoint Rotation + Cursor + Late-Join Delete|A inserts, B selects, A saves → checkpoint rotates with cursor snapshot, C joins and sees B's selection, B deletes and all three converge|shots-regression-checkpoint-cursor"
    "regression-insert-table|tests/regression/test-regression-insert-table.js|Regression: Insert Table (LO Core crash)|SvxAutoFormatData copy-ctor OOB in .uno:InsertTable — single-browser repro. Expected to FAIL until the LO Core fix lands.|shots-regression-insert-table"
    "relay|tests/misc/test-relay.js|Relay Test|WebSocket relay message ordering and delivery|none"
    "2browser|tests/diag/test-cursor-debug.js|2-Browser Co-Edit|Two browsers co-editing with cursor sync|shots"
    "3browser|tests/misc/test-3browsers.js|3-Browser Co-Edit|Three browsers simultaneous co-editing|shots3"
    "formats|tests/misc/test-formats.js|Format Tests|Opening multiple document formats|shots-formats"
    "pptx|tests/misc/test-pptx.js|PPTX / Impress|PowerPoint presentation opening in Impress|shots-pptx"
    "pptx-coedit|tests/misc/test-pptx-coedit.js|PPTX Co-Editing|Two browsers co-editing a PowerPoint presentation|shots-pptx-coedit"
    "latejoin|tests/misc/test-late-join.js|Late Join|Late-joining user receives current document state|shots-latejoin"
    "stress|tests/misc/test-stress.js|Stress Test|Rapid concurrent edits under load|shots-stress"
    "caching|tests/misc/test-caching.js|Caching Test|WASM module caching and reuse|shots-caching"
    "chart|tests/misc/test-chart.js|Chart Rendering|Writer docx and Calc xlsx with embedded charts|shots-chart"
    "fonts|tests/misc/test-fonts.js|Font Lazy Loading|Rare fonts, browser font access, server fallback, VFS injection|shots-fonts"
    "e2e-upload|tests/misc/test-e2e-upload.js|E2E Upload & Co-Edit|Upload file, background preload, open, co-edit with 2nd browser|shots-e2e-upload"
    # extreme|test-extreme.js — disabled: 18+ min wall clock on Azure, net
    # signal is covered by latejoin + stress + 3browser tests. Re-enable
    # with an opt-in flag if we need it.
    "pptx-viewer|tests/misc/test-pptx-viewer.js|PPTX via Viewer|Slide rendering, navigation, and Slide Show via viewer cold-reload|shots-pptx-viewer"
    "prewarm|tests/misc/test-prewarm.js|Pre-Warm|Viewer pre-warms editor in background; document open near-instant|shots-prewarm"
    "regression-sidebar|tests/regression/test-regression-sidebar.js|Regression: Sidebar Collapse|Sidebar collapses to thin bar on file open; hover/click re-expands|shots-regression-sidebar"
    "regression-sab-context|tests/regression/test-regression-sab-context.js|Regression: SAB Browser Context|Same-context co-edit corrupts state; separate contexts converge|shots-regression-sab"
    "regression-room-switch|tests/regression/test-regression-room-switch.js|Regression: Hot-Switch Room Change|Activation poll restart + stale WS handler cleanup after room switch|shots-regression-room-switch"
    "regression-checkpoint-timing|tests/regression/test-regression-checkpoint-timing.js|Regression: Checkpoint Timing|Late joiners receive fresh checkpoint within 1.5s save budget|shots-regression-checkpoint"
    "regression-xlsx-hotswitch|tests/regression/test-regression-xlsx-hotswitch.js|Regression: xlsx → xlsx Hot-Switch|Hot-switch between two similar xlsx files (identical status text) must not hang|shots-regression-xlsx-hotswitch"
    "regression-iframe-pool|tests/regression/test-regression-iframe-pool.js|Regression: Iframe Pool Cross-Type Revive|Cross-type to a previously-warm doctype reuses parked iframe (≪ 3s) instead of cold reload|none"
    "regression-samedoc-flicker|tests/regression/test-regression-samedoc-flicker.js|Regression: Same-Doctype Title Flicker|A↔B document-name flicker on same-type hot-switch caused by parallel setInterval writers in wasm-loader.js|shots-regression-samedoc-flicker"
    "regression-stylesview-overlap|tests/regression/test-regression-stylesview-overlap.js|Regression: Stylesview Layout|Notebookbar Styles entries occupy distinct grid cells (no overlap)|shots-regression-stylesview-overlap"
    "regression-stylesview-preview|tests/regression/test-regression-stylesview-preview.js|Regression: Stylesview Visual Preview|Ribbon Styles entries visually preview their effect — Title bigger+bolder than Body Text; H1 > H2 > H3; Block Quotation italic. Custom styles fixture (test/data/custom-styles.docx) checked for kit enumeration; visual-preview for custom styles is EXPECTED FAIL until phase 2 (LO core manifest). Includes screenshots of ribbon + each entry + dropdown.|shots-regression-stylesview-preview"
    "regression-ui-lang|tests/regression/test-regression-ui-lang.js|Regression: Viewer UI Language Detect + Switcher|navigator.languages → iframe ?lang=<code>; localStorage cool-ui-lang pin overrides; dropdown switcher reloads viewer; English fallback for unsupported. Screenshots of switcher visible, after switch, after pin clear.|shots-regression-ui-lang"
    "regression-brotli-sidecar|tests/regression/test-regression-brotli-sidecar.js|Regression: Brotli Sidecar Coverage|every cool.html __assetMap entry has a served .br with <60% ratio (catches missing/stale sidecars — incident 2026-05-06 build-92 shipped 265 MB uncompressed)|none"
    "regression-csp-frame-ancestors|tests/regression/test-regression-csp-frame-ancestors.js|Regression: CSP frame-ancestors|cool.html serves frame-ancestors 'self' + viewer origin only — locks down clickjacking surface against silent header-policy drift|none"
    "regression-l10n-manifest|tests/regression/test-regression-l10n-manifest.js|Regression: l10n chunks manifest|deployed l10n-chunks/l10n-manifest.json contains all 38 expected locales, total_bytes 5-15 MB, every locale > 30 KB; sampled chunk byte-matches manifest declaration|none"
    "regression-l10n-manifest-ui-lang-sync|tests/regression/test-regression-l10n-manifest-ui-lang-sync.js|Regression: l10n manifest ↔ viewer ui-lang.js AVAILABLE sync|deployed manifest's locale set === ui-lang.js's hardcoded AVAILABLE array (after underscore→hyphen normalization) AND every AVAILABLE code has a NAMES entry — catches drift between create-l10n-all-js.py and the viewer dropdown that would silently leave new locales unselectable or dropped locales 404'ing|none"
    "regression-viewer-config-pointer|tests/regression/test-regression-viewer-config-pointer.js|Regression: viewer /config.js exposes EDITOR_DEPLOY_ID|deployed viewer's /config.js + /config endpoints surface window.__CONFIG.EDITOR_DEPLOY_ID / editorDeployId (possibly empty) — the substrate for per-deploy editor folders (Phase 1). Locks down that the viewer-side machinery is wired before Phase 2 flips the editor side to per-deploy URLs|none"
    "regression-editor-deploy-folder|tests/regression/test-regression-editor-deploy-folder.js|Regression: editor per-deploy folder + build-info.json|when env.EDITOR_DEPLOY_ID is set, asserts that \${EDITOR}/<id>/build-info.json is reachable + matches the id, AND that the explicit-prefix /<id>/browser/cool.html resolves (locks down editor-server's per-deploy middleware + deploy-azure.sh's <id>/ subfolder staging). Skips with pass when EDITOR_DEPLOY_ID empty (flat editor or pre-Phase-2)|none"
    "regression-metadata-brotli-build|tests/regression/test-regression-metadata-brotli-build.js|Regression: build-time *.metadata brotli|finalize-build.sh's Step 6 brotli step still globs *.metadata + the original *.js/*.wasm/*.data/*.css under browser/dist (locks down the iter 11 fix at the source)|none"
    "regression-launcher-env-vars|tests/regression/test-regression-launcher-env-vars.js|Regression: launcher env-var guards|every wasm/launch-*.sh has its is-unset guard intact AND test-env.js required[] is a superset of launch-viewer.sh's required vars — drift catches tests booting with new vars unset|none"
    "regression-coop-coep-corp|tests/regression/test-regression-coop-coep-corp.js|Regression: COOP/COEP/CORP triple|editor-static serves the cross-origin-isolation triple required for SharedArrayBuffer (COOP=same-origin, COEP=require-corp, CORP=cross-origin) — losing any one breaks the iframe|none"
    "regression-sw-fingerprint|tests/regression/test-regression-sw-fingerprint-substitution.js|Regression: SW fingerprint substituted|deployed sw.js has __WASM_BUILD_FINGERPRINT__ replaced with a real 16-hex md5; CACHE_NAME is per-build-unique so activate handler evicts old caches|none"
    "regression-v2-file-api-shape|tests/regression/test-regression-v2-file-api-shape.js|Regression: v2 file API shape|GET /api/v2/file/<fileId> returns {ciphertext, encName, size, updatedAt} exactly; size is ciphertext bytes; updatedAt is ISO 8601 — locks the contract that openFileBySecret + change-detection depend on|none"
    "regression-immutable-cache-control|tests/regression/test-regression-immutable-cache-control.js|Regression: hashed assets immutable Cache-Control|every cache-bust hashed asset is served with 'public, max-age=31536000, immutable' exactly — losing 'immutable' silently doubles request count from active users|none"
    "regression-sw-bridge|tests/regression/test-regression-sw-bridge.js|Regression: SW bridge architecture|deployed /sw-bridge.js intercepts /wasm/ + /api/blobs/ + /api/v2/file/ + /api/files/ and routes via postMessage to the viewer; wasm-loader.js gates Kit on __swBridgeReady; editor-bridge.js handles sw-bridge-request in the viewer — locks down the post-FD-migration architecture where editor↔viewer comm is in-browser only, no HTTP between origins|none"
    "regression-bundle-js-prepend|tests/regression/test-regression-bundle-js-prepend.js|Regression: bundle.js l10n-all prepend|deployed bundle.js starts with 'var onlylang' (l10n-all marker) within first 256 bytes — catches cache-bust step regressing the prepend|none"
    "regression-cool-html-script-tags|tests/regression/test-regression-cool-html-script-tags.js|Regression: cool.html mandatory script tags|deployed cool.html contains <script src=...> for global.js, templates/templates.js, and bundle.js — catches m4-template regression that drops a tag|none"
    "regression-cool-html-lang-init|tests/regression/test-regression-cool-html-lang-init.js|Regression: cool.html window.LANG init shim|deployed cool.html has the inject-block markers + Object.defineProperty(window, 'LANG'...) shim that reads ?lang= from URLSearchParams — catches the iter 26 bug class where cache-bust idempotency froze the shim and the LANG init was never updated|none"
    "regression-ui-lang-resolve|tests/regression/test-regression-ui-lang-resolve.js|Regression: resolveBrowserPref English-primary|viewer-public/lib/ui-lang.js's resolveBrowserPref returns 'en' when the user's PRIMARY navigator.languages entry is some flavor of English, even when a secondary preference is in AVAILABLE — without this fix, navigator.languages=['en-US','de'] returned 'de'|none"
    "regression-lang-switcher-click|tests/regression/test-regression-lang-switcher-click.js|Regression: language switcher click changes editor lang|click-driven sub-test of the language switcher — selects 'de' via page.select(), waits for viewer reload, asserts editor iframe URL has &lang=de AND inside-iframe window.LANG === 'de' AND LOCALIZATIONS has > 100 German keys (catches the iter 26 bug where URL had &lang=de but window.LANG was en-US)|shots-regression-lang-switcher-click"
    "regression-dict-multi-lang|tests/regression/test-regression-dict-multi-lang.js|Regression: dict-loader multi-language reactive load|exercises window.loadDictionary across 3 langs; asserts state.loaded grows AND second-call short-circuits to {cached:true} with no new fetch — locks the multi-language spellcheck substrate (task #196)|shots-regression-dict-multi-lang"
    "regression-dict-locale-resolve|tests/regression/test-regression-dict-locale-resolve.js|Regression: dict-loader BCP 47 resolver|loadDictionaryForLocale maps runtime locale tags (en-US, fr-CA, de_AT, pt-BR…) to the manifest's actually-shipped lang via 4-tier match (exact → primary exact → primary-prefix → skipped); StatusBar's LanguageStatus handler depends on this for paragraph-language reactive dict loads|shots-regression-dict-locale-resolve"
    "regression-mixed-lang-spellcheck|tests/regression/test-regression-mixed-lang-spellcheck.js|Regression: mixed-language paragraph spellcheck plumbing|opens a docx with en-US/de-DE/fr-FR paragraphs; clicks into each in turn; asserts kit's .uno:LanguageStatus event flows through StatusBar → loadDictionaryForLocale → idempotent loadDictionary; verifies state.loaded grows on cross-paragraph cursor moves AND no new fetch on re-entry to a previously-loaded paragraph (locks iter 43 e2e)|shots-regression-mixed-lang-spellcheck"
    "regression-sidebar-deck-iconview-lang|tests/regression/test-regression-sidebar-deck-iconview-lang.js|Regression: Writer Styles sidebar iconview tiles render German|opens viewer with navigator.language=de-DE, dispatches showstylelistdeck, samples stylesview_NN entries in right pane; asserts at least 3 of the well-known paragraph styles render in German (Überschrift 1, Aufzählung, Fußzeile, …) AND no English fallback like 'Heading N' appears — locks LO PR chain #8/#9/#10 (lo-builds 2026-05-19-26 → 2026-05-20-28). NOTE: treeview_NN tree-list still English; tracked separately.|shots-regression-sidebar-deck-lang"
    "regression-spellcheck-squiggle|tests/regression/test-regression-spellcheck-squiggle.js|Regression: red spell-error squiggle paints on canvas|types three deliberate misspellings (Schmettrling fhsdkj qweryt) at top of an English paragraph; samples a 1200x140 band around the cursor row for red-channel pixels matching the squiggle color signature (r>150 g<90 b<90); asserts >=30 red pixels appear. Locks libreoffice-core-wasm PR #12 inftxt.cxx OnWin/LOK gate — pre-fix redPx==0, post-fix paints proper squiggles in tile rendering.|shots-regression-spellcheck-squiggle"
    "regression-spell-rightclick-suggest|tests/regression/test-regression-spell-rightclick-suggest.js|Regression: right-click spelling suggestions (en/de/fr)|opens mixed-lang docx; for English (manuscrit) right-clicks the misspelled word and asserts a spelling context menu with hunspell suggestions appears, picks one, and confirms a re-right-click no longer flags the word; then primes the German + French paragraphs (cursor entry → lazy dict load), right-clicks a misspelled word in each (Woerter→Wörter, francais→français) and verifies suggestions + correction. Locks the LO LOK spell-menu emit + runtime dict registration/re-spell chain.|shots-regression-spell-rightclick-suggest"
    "regression-dict-manifest-coverage|tests/regression/test-regression-dict-manifest-coverage.js|Regression: dict manifest minimum-coverage|deployed /dicts/manifest.json contains all required languages (Western+Eastern Europe + Nordic + Iberian variants) AND total deploy is 5-350 MB (DEFAULT_LANGS now ships all upstream dicts, lazy-loaded) AND a sampled .tar.gz HEAD matches the manifest's declared size — catches build-dicts.sh DEFAULT_LANGS regressions before deploy|none"
    "regression-language-picker-multilang|tests/regression/test-regression-language-picker-multilang.js|Regression: language picker offers non-English languages|opens a docx, opens the status-bar language menu and asserts a non-English language (German/French/Italian/…) is offered — directly inline or via the More… dialog. Pre-fix getLanguages() returned only installed (English) dictionary locales so the user could never pick another language to trigger its lazy dict load; locks the LO getLanguages full-table emit + client manifest-narrowing.|shots-regression-language-picker-multilang"
    "regression-spell-language-switch|tests/regression/test-regression-spell-language-switch.js|Regression: switching language re-spells with lazy dict (red squiggles appear)|types English-valid words, then switches the document to Spanish (inline favourite) and Hungarian (Set Language for Selection → More…), asserting red squiggle pixels appear on the canvas after each switch (the words are misspelled in both). Covers both menu paths + two languages. Pre-fix the lazily-loaded dict arrived after the spell pass and nothing re-checked the clean text; locks the LO re-spell-on-dict-install + SPELL_CORRECT_WORDS_AGAIN fix (LO 2026-06-27-110).|shots-regression-spell-language-switch"
    "regression-sw-activate-eviction|tests/regression/test-regression-sw-activate-eviction.js|Regression: SW activate-handler cache eviction|deployed sw.js's activate listener still has the caches.keys() → .filter(n !== CACHE_NAME) → caches.delete(...) chain that GCs old build caches; without this, repeated deploys exhaust the browser's per-origin Cache Storage quota|none"
    "regression-relay-adapter-protocol|tests/regression/test-regression-relay-adapter-protocol.js|Regression: relay-adapter frame-type protocol|deployed relay-adapter.js source has sendToRelay(0x00) (user input) AND sendToRelay(0x06) (checkpoint register) call sites + ENCRYPTED_TYPES map includes 0x00 — locks the protocol byte numbers + the E2E-encrypt list against silent refactors|none"
    "regression-app-build-artifacts|tests/regression/test-regression-app-build-artifacts.js|Regression: app-build artefact bundle|coolwasmfiles app-builds/<latest>/ has viewer.zip + relay.zip + editor.zip with non-zero Content-Length; tests/summary.json conditionally checked when listed in the index. Catches the partial-publish class where build succeeded but a zip didn't make it through|none"
    "regression-iconview-rendercache-diag|tests/regression/test-regression-iconview-rendercache-diag.js|Diag: Iconview rendersCache delivery|Captures Util.OnDemandRenderer cache-state distribution per controlId (gated by window.__l10nIconviewDebug from iter 10) — data for the ribbon-style preview fix (#195/iter 6 deferred)|none"
    "regression-html-304|tests/regression/test-regression-html-304.js|Regression: HTML routes 304|viewer index.html, singleuser.html, help, cool.html, /config.js emit ETag and 304 on If-None-Match|none"
    "regression-hot-switch-watchdog|tests/regression/test-regression-hot-switch-watchdog.js|Regression: Hot-switch Watchdog|wasm-loader emits bridge:hot_switch_watchdog + HotSwitchFailed; viewer handles HotSwitchFailed (iter 195)|none"
    "regression-cluster-c|tests/regression/test-regression-cluster-c.js|Regression: Cluster C wires|wasm-loader doctype-strict docPoll + viewer cross-type cold-reload watchdog + planc=0 latch (iter 202)|none"
    "regression-jobs-scale|tests/regression/test-regression-jobs-scale.js|Regression: JOBS_SCALE wiring|env.scaleTimeout exported, parallel runners export JOBS_SCALE, 9 contention-flaky tests route patience timeouts through it|none"
    "regression-cross-format-matrix|tests/regression/test-regression-cross-format-matrix.js|Regression: Cross-Format Hot-Switch Matrix|Phase 1.2 — single tab walking through cross-format hot-switches and validating each transition|shots-regression-cross-format-matrix"
    "regression-first-client-overwrite|tests/regression/test-regression-first-client-overwrite.js|Regression: First Client Overwrite|First client's activation checkpoint must not save stale/blank content over a newer relay state|shots-regression-first-client-overwrite"
    "regression-fontsize-dropdown|tests/regression/test-regression-fontsize-dropdown.js|Regression: Font-Size Dropdown|Bug 1 single-tab — font-size dropdown shows the full size list (not just one option)|shots-regression-fontsize-dropdown"
    "regression-heading-styles|tests/regression/test-regression-heading-styles.js|Regression: Heading Style Picker|Bug 2 single-tab — clicking Heading 1 / Title / Body Text in the Notebookbar applies the style|shots-regression-heading-styles"
    "regression-latejoin-offline-unsaved|tests/regression/test-regression-latejoin-offline-unsaved.js|Regression: Late Join — A Offline + Unsaved|A types unsaved, A goes offline, B joins; B sees A's edits via relay history|shots-regression-latejoin-offline-unsaved"
    "regression-latejoin-overwrite|tests/regression/test-regression-latejoin-overwrite.js|Regression: Late Join Overwrite|Late joiner must NOT overwrite document with blank/stale content during checkpoint|shots-regression-latejoin-overwrite"
    "regression-latejoin-prewarm-race|tests/regression/test-regression-latejoin-prewarm-race.js|Regression: Late Join Prewarm Race|Late joiner with prewarmed Kit (still on blank doc) must not commit a blank checkpoint|shots-regression-latejoin-prewarm-race"
    "regression-latejoin-unsaved|tests/regression/test-regression-latejoin-unsaved.js|Regression: Late Join Unsaved|Late joiner with UNSAVED edits (no Ctrl+S from first browser) must converge|shots-regression-latejoin-unsaved"
    "regression-real-copypaste|tests/regression/test-regression-real-copypaste.js|Regression: Real Copy/Paste|REAL Ctrl+C/V flow (no JS-injected paste); validates clipboard wiring end-to-end|shots-regression-real-copypaste"
    "regression-search|tests/regression/test-regression-search.js|Regression: Search Functionality|Bug 3 single-tab — Ctrl+F search finds matches in the document|shots-regression-search"
    "regression-viewer-hot-switch|tests/regression/test-regression-viewer-hot-switch.js|Regression: Viewer Hot-Switch (3 cross-types)|Upload 3 files (different types) via viewer UI; click-switch between them; validate hot-switch path|shots-regression-viewer-hot-switch"
    "regression-viewer-hot-switch-report|tests/regression/test-regression-viewer-hot-switch-report.js|Regression: Viewer Hot-Switch (with report)|E2E viewer hot-switch with screenshots + per-switch measurements + visual report|shots-regression-viewer-hot-switch-report"
    "regression-viewer-same-type-hot-switch|tests/regression/test-regression-viewer-same-type-hot-switch.js|Regression: Viewer Same-Type Hot-Switch|Upload 3 same-type docx, click-switch between them; validate same-type hot-switch (kInPlaceCap path)|shots-regression-viewer-same-type-hot-switch"
    "regression-calc-impress-edits|tests/regression/test-regression-calc-impress-edits.js|Regression: Calc/Impress Edit Propagation|Calc cell edits and Impress text edits fire invalidatetiles AND propagate to remote peers|shots-regression-calc-impress"
    "regression-shield-timing|tests/regression/test-regression-shield-timing.js|Regression: Loading Shield Timing|Viewer shield must stay up until the new doc's canvas pixels actually paint, never before|shots-regression-shield-timing"
    "regression-hash-deeplink|tests/regression/test-regression-hash-deeplink.js|Regression: Hash Deep Link|Per-file URL fragment: clicking a file updates #file=<name>; /#file=X opens X directly; back/forward navigates|shots-regression-hash-deeplink"
    "regression-shield-prewarm-race|tests/regression/test-regression-shield-prewarm-race.js|Regression: Shield Prewarm Race|Loading shield must stay up across prewarm/click race; deep-link and click-during-prewarm|shots-regression-shield-prewarm-race"
    "regression-prewarm-ready-signal|tests/regression/test-regression-prewarm-ready-signal.js|Regression: Prewarm-Ready Signal Ordering|Viewer's prewarmReady must gate on the late WasmPrewarmReady from wasm-loader, not the early App_LoadingStatus from COOL Map.js|none"
    "regression-event-driven-docready|tests/regression/test-regression-event-driven-docready.js|Regression: Event-Driven Doc-Ready|kit emits docready: text frame from kit/ChildSession.cpp at 3 sites (cold, hot-switch, warm-restore re-attach); wasm-loader fireDocReady() routes through existing fan-out. Asserts hook installed + [event-vs-poll] race mark observed. Phase 1: polling stays in parallel, Phase 4 deletes it.|shots-regression-event-driven-docready"
    "regression-wasm-cache-crosstype|tests/regression/test-regression-wasm-cache-crosstype.js|Regression: WASM Cache Cross-Type|online.wasm + soffice.data must come from cache (not the wire) on writer→calc→impress switches and after page reload|shots-regression-wasm-cache-crosstype"
    "regression-wasm-cache-revisit|tests/regression/test-regression-wasm-cache-revisit.js|Regression: WASM Cache Revisit|Close browser entirely and re-launch (persistent userDataDir) — heavy assets must come from disk cache, not the wire|shots-regression-wasm-cache-revisit"
    "regression-viewer-cache|tests/regression/test-regression-viewer-cache.js|Regression: Viewer Document Cache|/api/files/<doc> + /blank.docx must send ETag/Last-Modified and answer 304 on conditional GET (covers the doc storage path)|none"
    "regression-wasm-cache-pressure|tests/regression/test-regression-wasm-cache-pressure.js|Regression: WASM Cache Under Pressure|Heavy WASM survives Chrome disk-cache LRU eviction (limited --disk-cache-size=50MB) thanks to the Service Worker / Cache Storage fallback|shots-regression-wasm-cache-pressure"
    "regression-incognito-warm-cache|tests/regression/test-regression-incognito-warm-cache.js|Regression: Incognito Warm-Tab Cache|Second tab in same incognito context must hit Cache Storage for online.wasm + soffice.data + soffice.data.js.metadata; SW HEAVY_PATTERNS must match hashed filenames (regression after iter 27 cache-bust)|none"
    "regression-select-delete-coedit|tests/regression/test-regression-select-delete-coedit.js|Regression: Select+Delete Co-Edit|A double-clicks a word + presses Delete; B must converge to the same shorter doc (deletion must propagate)|shots-regression-select-delete"
    "regression-delete-key-coedit|tests/regression/test-regression-delete-key-coedit.js|Regression: Delete Key Co-Edit|Delete key generates removetextcontext (not key); the relay-adapter must recognize it as user-input and forward to peers|shots-regression-delete-key"
    "regression-user-save-checkpoint|tests/regression/test-regression-user-save-checkpoint.js|Regression: User Save → Checkpoint + Storage|.uno:Save (Ctrl+S) creates a fresh relay checkpoint AND uploads the saved file to /api/files; both hashes must match|none"
    "regression-docname-switch|tests/regression/test-regression-docname-switch.js|Regression: Doc Name Updates on Switch|Hot-switch to a different doc must update the title bar from the old name to the new one|shots-regression-docname-switch"
    "regression-image-insert|tests/regression/test-regression-image-insert.js|Regression: Image Insert into docx|Insert a 1x1 PNG via postMobileMessage insertfile; saved docx must grow (image embedded in the zip)|shots-regression-image-insert"
    "regression-paste-coedit|tests/regression/test-regression-paste-coedit.js|Regression: Paste Co-Edit|Text and image paste in 2-browser co-edit (docx); text in both browsers, image embedded in saved file|shots-regression-paste-coedit"
    "coedit-convergence-churn|tests/coedit/test-coedit-convergence-churn.js|Co-edit: convergence + churn|Multi-browser co-edit: A/B/C/D join, type, paste, leave, late-join; every live browser converges on char count at each step, no checkpoint mismatch/abort|shots-coedit-convergence-churn"
    "coedit-concurrent|tests/coedit/test-coedit-concurrent.js|Co-edit: concurrent edits|Two/three browsers type SIMULTANEOUSLY (no wait) with C joining + B leaving mid-stream; summed char count must converge everywhere|none"
    "coedit-feature-shape|tests/coedit/test-coedit-feature-shape.js|Co-edit: insert-shape propagation|A inserts a rectangle → B's canvas changes; B inserts → A's changes; C late-joins and renders both shapes|shots-coedit-feature-shape"
    "coedit-feature-table|tests/coedit/test-coedit-feature-table.js|Co-edit: insert-table propagation|A inserts a 3x3 table → B renders it; B inserts 2x2 → A renders it; C late-joins and renders both tables|shots-coedit-feature-table"
    "coedit-formatting|tests/coedit/test-coedit-formatting.js|Co-edit: formatting propagation|Bold/italic/font-size applied in one browser render in the peer; late-joiner inherits formatting|shots-coedit-formatting"
    "coedit-rejoin-storm|tests/coedit/test-coedit-rejoin-storm.js|Co-edit: rejoin storm|A edits continuously while a participant repeatedly leaves + rejoins across checkpoint rotations; every rejoin converges|none"
    "coedit-spell-correct|tests/coedit/test-coedit-spell-correct.js|Co-edit: language + spellcheck + spell-correct|German paragraph spell-checks in German; both browsers show the spelling menu; A picks a suggestion and the correction converges to B|shots-coedit-spell-correct"
    "e2e-copypaste|tests/misc/test-e2e-copypaste.js|E2E Copy/Paste|Real keyboard Ctrl+C/V from viewer: type, internal copy/paste, external text paste, external image paste, internal after external. Auto-generates detailed HTML report with screenshots + clipboard state at every step|shots-e2e-copypaste"
    "latejoin-copypaste|tests/misc/test-late-join-copypaste.js|Late Join + Copy/Paste|Late joiner receives all paste content (internal, external text, external image) from first browser|shots-latejoin-copypaste"
    "regression-plaintext-paste|tests/regression/test-regression-plaintext-paste.js|Regression: Plain Text Paste|Pasting unformatted text/plain (no HTML) from terminal or Notepad must work via all paths: blob, string, and paste event|shots-regression-plaintext-paste"
    "regression-hard-refresh|tests/regression/test-regression-hard-refresh.js|Regression: Hard Refresh|Type without saving, hard refresh, content preserved via relay message replay|shots-regression-hard-refresh"
    "regression-hard-refresh-slow|tests/regression/test-regression-hard-refresh-slow.js|Regression: Hard Refresh (Slow)|Type without saving, wait >60s for room cleanup, content preserved|shots-regression-hard-refresh-slow"
    "regression-mouse-select-copypaste|tests/regression/test-regression-mouse-select-copypaste.js|Regression: Mouse Select + Copy/Paste|Mouse click/double-click selection + copy/paste between 2 browsers|shots-regression-mouse-select-copypaste"
    "regression-rightclick-copypaste|tests/regression/test-regression-rightclick-copypaste.js|Regression: Right-click Copy + Paste|First E2E coverage of the right-click context menu's Copy path. Real puppeteer right-mouse-click on selected canvas text, real-click on the Copy menu item, then Ctrl+V to confirm the kit-side clipboard chain works. Documents the smoking gun where navigator.clipboard.readText() returns empty after right-click Copy (external clipboard write silently fails due to unhandled GET /cool/clipboard in wasm-loader.js)|shots-regression-rightclick-copypaste"
    "regression-xlsx-sheet-nav|tests/regression/test-regression-xlsx-sheet-nav.js|Regression: Calc Sheet Navigation|Calc bottom-toolbar buttons: insertsheet (+), firstrecord, prevrecord, nextrecord, lastrecord. Each must not throw and must perform its sheet-strip action. Catches the docdispatcher.ts regression where #spreadsheet-tab-scroll dereference crashed before the tab strip was lazily created|shots-regression-xlsx-sheet-nav"
    "regression-xlsx-sheet-tabs-rename|tests/regression/test-regression-xlsx-sheet-tabs-rename.js|Regression: Calc Sheet TABS visibility + rename|Each sheet must have a visible, clickable tab in the bottom strip. Real-click on tab #2 activates that sheet. Double-click on tab #1 opens the rename input modal. Right-click on tab #1 → 'Rename Sheet…' opens the same modal. Catches the bug where SheetsBar (Control.SheetsBar.js:95 parentContainer.replaceChildren()) wipes the spreadsheet-tabs-container that Control.Tabs._initialize() just appended to #spreadsheet-toolbar — SheetsBar is constructed twice via initializeSpecializedUI('spreadsheet'), the second construction wipes the tab DOM, leaving only the nav arrows (|< < > >| + the +) visible|shots-regression-xlsx-sheet-tabs-rename"
    "regression-pptx-transitions-iconview|tests/regression/test-regression-pptx-transitions-iconview.js|Regression: PPTX Transitions iconview|Each tile in the Impress Transition tab's iconview must have a real (>=30 px) height. Catches the Notebookbar.ImpressTransitionTab.ts regression where ondemand entries lacked width/height and collapsed to 2-pixel flat strips, leaving the entire transitions ribbon visually empty|shots-regression-pptx-transitions-iconview"
    "regression-impress-transition-click|tests/regression/test-regression-impress-transition-click.js|Regression: PPTX Transition click applies|Clicking a transition tile in the Impress Transitions tab must apply the transition (not just select the tile). Catches the Notebookbar.ImpressTransitionTab.ts regression where the iconview lacked singleclickactivate, so the click handler in Widget.IconView.ts only fired the 'select' builderCallback and never the 'activate' that propagates to the kit|shots-regression-impress-transition-click"
    "regression-pptx-save-no-abort|tests/regression/test-regression-pptx-save-no-abort.js|Regression: PPTX Save must not abort kit|.uno:Save through relay-adapter must trigger saveAndUploadCheckpoint() WITHOUT also forwarding to the kit. The kit's wsd/DocumentBroker.cpp:5284 has an assertion that aborts on uno .uno:Save; the user-visible symptom was 'save fails, only Discard available' after any edit + Ctrl+S|shots-regression-pptx-save-no-abort"
    "regression-impress-area-dialog|tests/regression/test-regression-impress-area-dialog.js|Regression: Impress Area dialog must not crash kit|Right-click → Area → pick colour → OK in Impress must not trigger 'memory access out of bounds' from Browser_mainLoop. Hypothesis: sd/source/ui/func/fuarea.cxx:62 StartExecuteAsync callback captures pView+pViewShell by raw pointer and runs after FuArea has unwound. Three deterministic cycles to attest reproduction rate.|shots-regression-impress-area-dialog"
    "regression-writer-insert-shape-area|tests/regression/test-regression-writer-insert-shape-area.js|Regression: Writer insert-shape + Area dialog|Two bugs: (A) Insert→Shapes popup must contain Rounded Rectangle + Rounded Square entries; (B) right-click Area → colour → OK on an inserted shape must not crash kit with memory-OOB. Bug B same LO trap signature as impress-shape-area-cant-be-saved; Writer dispatch site is sw/source/uibase/shells/drawdlg.cxx:121 (SwDrawShell::ExecDrawDlg SID_ATTRIBUTES_AREA, StartExecuteAsync captures pSh+pView by raw pointer). Three deterministic cycles.|shots-regression-writer-insert-shape-area"
    "regression-writer-shape-area-oom|tests/regression/test-regression-writer-shape-area-oom.js|Regression: Writer shape Area dialog must not OOM kit|Right-click → Area... on an inserted shape in Writer must not trigger Aborted(Cannot enlarge memory arrays …) → Uncaught RuntimeError: unreachable. WASM is pinned at TOTAL_MEMORY=1GB (solenv/gbuild/platform/EMSCRIPTEN_INTEL_GCC.mk:18) with no ALLOW_MEMORY_GROWTH; the SvxAreaTabDialog ctor allocates past the 1 GB cap. User-reported 2026-06-02 on internal editor build 2026-06-02-174734. Tripwire test — expected FAIL until the OOM is fixed (raise TOTAL_MEMORY, enable ALLOW_MEMORY_GROWTH, or fix the LO codepath).|shots-regression-writer-shape-area-oom"
    "regression-docswitch-dialogs|tests/regression/test-regression-docswitch-dialogs.js|Regression: 2nd doc in same tab keeps notebookbar/dialogs working|User-reported 2026-06-19: after opening a SECOND doc in the SAME tab (doc-switch via #file= hashchange) the notebookbar tab switching broke — clicking Insert no longer activated the Insert ribbon, Shapes unreachable, right-click → Area palette never appeared. FIXED 2026-06-21 (kit switchdocument Batch=true leaked DialogCancelMode::LOKSilent + missing notebookbar refresh on same-type switch). Opens DOC A (Insert→rectangle→right-click→Area→palette as a sanity gate), switches to DOC B in the same tab, repeats — both must PASS. Live regression guard (no longer a tripwire); pure visible-UI input.|shots-regression-docswitch-dialogs"
    "regression-area-palette|tests/regression/test-regression-area-palette.js|Regression: Area dialog Colors tab shows real palettes|After the PaletteManager OOB fix the Area dialog opens but the colour grid is blank and the Palette dropdown lists only the 3 dynamic palettes (Custom/Theme/Document). Root cause: static/CustomTarget_emscripten_fs_image.mk packaged colorpage.ui but not share/palette/*.soc, so PaletteManager loaded zero built-in palettes (LO PR #40 adds them to the emscripten preload list). Inserts a rectangle, right-click → Area → reads the rendered palette <select> options and asserts >3 options incl. a built-in (standard/libreoffice/html/material/tonal), then selects one + clicks a swatch and asserts the New colour changes. Tripwire — FAILS pre-fix.|shots-regression-area-palette"
    "regression-copy-paste-suite|tests/regression/test-regression-copy-paste-suite.js|Regression: Copy/paste suite (phase 1)|Unified copy/paste regression suite consolidating the 9 previously-separate clipboard tests. Phase 1 (2026-06-01): 1 ported use-case (Ctrl+A→C→End→V baseline) + 13 TODO placeholders enumerating the remaining migration work. Each subsequent phase ports another use-case from its source test file; eventually replaces test-{regression-real-copypaste, regression-mouse-select-copypaste, regression-plaintext-paste, regression-paste-coedit, regression-rightclick-copypaste, regression-paste-table, singleuser-copy-paste, e2e-copypaste, late-join-copypaste}. Per-use-case pass/fail in the report.|shots-regression-copy-paste-suite"
    "pptx-viewer-slides|tests/misc/test-pptx-viewer-slides.js|PPTX Viewer Slides|Real pptx via viewer: Impress UI, slide panel, navigation, content rendering|shots-pptx-viewer-slides"
    "singleuser|tests/misc/test-singleuser.js|Single-User Mode|Open/edit/save docx, xlsx, pptx without relay in one session|shots-singleuser"
    "regression-coediting-mode-toggle|tests/regression/test-regression-coediting-mode-toggle.js|Regression: Co-editing mode toggle|Single-user is the default viewer mode; co-editing is opt-in via ?co-editing and the #coedit-toggle button. Asserts default open has no &relay=, coEditing:true adds it, and the real-UI button click reloads into co-editing.|shots-coediting-toggle"
    "regression-journey-recorder|tests/regression/test-regression-journey-recorder.js|Regression: User-journey recorder (Phase 1)|?record session captures uploads + chrome/canvas input into a downloadable journey JSON. Real-UI: click canvas + type, then Stop&Download; asserts the bundle has the fixture (bytes round-trip) + in-canvas keydowns forwarded from the editor iframe.|shots-journey-recorder"
    "singleuser-viewer|tests/misc/test-singleuser-viewer.js|Single-User via Viewer|Full viewer flow for /singleuser.html: redirect, no relay WS, type + save|shots-singleuser-viewer"
    "cold-open|tests/misc/test-cold-open.js|Cold Start File Open|Deep-link file open on cold start must use cold-reload, not hot-switch|shots-cold-open"
    "viewer-e2e|tests/misc/test-viewer-e2e.js|Viewer E2E|Full viewer flow: deep-link cold start, return visit, cross-type file switch via sidebar|shots-viewer-e2e"
    "folder-api|tests/misc/test-folder-api.js|Folder API|Create folders, upload nested files, download, path traversal rejection|none"
    "snapshot-stale|tests/snapshot/test-snapshot-stale.js|Snapshot Stale Rejection|Tampered fingerprint causes snapshot to be discarded on reload|none"
    "save-conflict|tests/misc/test-save-conflict.js|Save Conflict|External file modification during editing — conflict detection behavior|none"
    "snapshot-milestones|tests/snapshot/test-snapshot-milestones.js|Snapshot Milestones|Per-doc-type cold/warm × N=3 trial milestone report; iframe DOM verifies content rendered; screenshots at every milestone. Replaces the old timing-report — same cold-vs-warm signal plus per-doc-type breakdown and a warm-time budget that fails the run when warm regresses.|none"
    "snapshot-cross-type|tests/snapshot/test-snapshot-cross-type.js|Snapshot Cross-Type|Warm-restore across writer/calc/impress hot-switch combinations. WARM PHASES ARE XFAIL (2026-05-31, ai/proposals/promoted/triage-snapshot-cross-type.md) — they hang in relay mode because the viewer+relay-adapter checkpoint handshake never produces text on canvas after HEAPU8 restore. Cold-writer still hard-gates. snapshot-milestones (singleuser) remains the authoritative warm gate.|none"
    "regression-font-change-ui|tests/regression/test-regression-font-change-ui.js|Regression: Font Change via UI|Single-user, double-click word + change font via notebookbar dropdown — UNO command dispatched and font value updates|shots-regression-font-change-ui"
    "regression-writer-header-footer-remove|tests/regression/test-regression-writer-header-footer-remove.js|Regression: Writer header/footer remove via Page Style|Smoke round-trip: Format → Page Style → Header tab → tick + Apply → Ctrl+S → unzip saved docx, assert <w:headerReference> + word/header*.xml present. Re-open dialog, untick + Apply → Ctrl+S → assert both removed. Pre-LO-PR-#30, ChangeHeaderOrFooter ran DeleteHeaderDialog(null).run() in LOK mode (GetFrameWeld() returns null), got RET_CANCEL → bExecute=false → SetFormatAttr that flips header off was skipped → header survived. Drives entirely through real puppeteer mouse + keyboard (no sendUnoCommand / no app.dispatcher.dispatch / no page.evaluate(()=>el.click())).|shots-regression-writer-header-footer-remove"
    "regression-shape-area-allocation-suspects|tests/regression/test-regression-shape-area-allocation-suspects.js|Regression: shape Area allocation suspects (tripwire)|Static-source tripwire for the three Area-dialog allocation sites in ai/proposals/promoted/shape-area-dialog-allocation-profile.md — SvxPresetListBox::FillPresetListBoxImpl + PaletteManager::LoadPalettes + SvxAreaTabDialog ctor. Reads ~/libreoffice-core-wasm (or \$LO_SOURCE_ROOT) and grep-asserts each function still exists at its expected path. LO refactors that rename / relocate any of these surface as a CI failure → forces a re-profile before the proposal's mitigation lands. EXIT 0 with skip: log when LO source isn't bind-mounted (typical CI test job).|none"
    "regression-double-click-word-copypaste|tests/regression/test-regression-double-click-word-copypaste.js|Regression: double-click word → copy → paste|Smoke port of singleuser-copy-paste case 3 into the regression suite. Type 'hello world', double-click a word, Ctrl+C → Ctrl+End → Ctrl+V; assert StateWordCount grew (some text pasted). Isolates the kit-side word-select + clipboard chain from the multi-case singleuser run where prior cases pre-populate the clipboard.|shots-regression-double-click-word-copypaste"
    "regression-external-image-paste|tests/regression/test-regression-external-image-paste.js|Regression: external image paste (PNG) routes to local Kit|Smoke port of singleuser-copy-paste case 7 into the regression suite. Single-user mode, real puppeteer Ctrl+V on canvas with a 1x1 PNG on the OS clipboard. Asserts the relay-adapter dispatched insertfile to local Kit (NOT through WS) and Kit's handleMessage saw insertfile graphic. Tripwire for the iter9 bug where insertfile was incorrectly relayed in single-user mode.|shots-regression-external-image-paste"
    "regression-mouse-drag-copypaste|tests/regression/test-regression-mouse-drag-copypaste.js|Regression: mouse-drag select → copy → paste|Smoke port of singleuser-copy-paste case 4 into the regression suite. Type 'drag-target', Ctrl+Home, mouse-drag horizontally across the text, Ctrl+C → Ctrl+End → Ctrl+V; assert StateWordCount grew (some text pasted). Isolates the kit-side drag-select + clipboard chain. Known coord-pitfall: drag-coords must be computed BEFORE any Ctrl+End scroll, hence drag at top.|shots-regression-mouse-drag-copypaste"
    "regression-ctrl-x-cut-restore|tests/regression/test-regression-ctrl-x-cut-restore.js|Regression: Ctrl+X cut → Ctrl+V restores (TRIPWIRE)|Tripwire for the LO-side kit .uno:Cut bug (proposal ai/proposals/promoted/ctrl-x-isolated-single-user-clipboard.md). Type 'cut-test-abc', Ctrl+Home + Shift+ArrowRight ×3, Ctrl+X, Ctrl+V; assert doc restored to before-cut count. EXPECTED to FAIL until LO fix lands: in the multi-case singleuser run this passes accidentally (prior case left OS clipboard valid); ISOLATED, the kit's .uno:Cut doesn't write the cut bytes to the OS clipboard, so Ctrl+V has nothing to restore.|shots-regression-ctrl-x-cut-restore"
    "regression-flake-budget|tests/regression/test-regression-flake-budget.js|Regression: KNOWN_FLAKE / LO_BLOCKED budget|Tripwire that guards .github/scripts/wasm-ci/test-and-publish.sh's KNOWN_FLAKE_TESTS and LO_BLOCKED_TESTS arrays against silent growth. Counts entries and asserts they're under the budgets in test-regression-flake-budget.js. Adding a new flake/block entry requires bumping the budget in the SAME commit — keeps the lists honest. Static check, ~50ms wall time.|none"
    "regression-bulk-open-ignored|tests/regression/test-regression-bulk-open-ignored.js|Regression: Bulk Open (test/samples/ignored)|Discovers every file in test/samples/ignored/, opens them sequentially in a single Chromium, types 'hello world' at the top via real keyboard, verifies via canvas pixel-diff + StateWordCount delta. Produces an HTML report with per-file open times + before/after screenshots at /tmp/static-deploy/public/reports/regression-bulk-open-ignored.html. Corpus is gitignored — local-only test; exits 0 regardless of per-file verify result so the run never blocks the suite.|shots-regression-bulk-open-ignored"
    "regression-open-progress-stages|tests/regression/test-regression-open-progress-stages.js|Feature: multi-stage open progress on the shield|The viewer shield shows a live stage checklist (#shield-stages) during file open, driven by WasmOpenStage postMessages from the iframe wasm-loader's mark() stream + the kit's statusindicator import %. Asserts >=5 stages flip to done before the shield drops, the bar is monotonically non-decreasing, and the doc still opens.|shots-regression-open-progress-stages"
)

# ── Run tests one by one ───────────────────────────────────────────────
declare -A RESULTS   # slug -> pass|fail
declare -A DURATIONS # slug -> elapsed seconds
TOTAL=0
PASSED=0
FAILED=0

for entry in "${TESTS[@]}"; do
    IFS='|' read -r slug script title description shots_name <<< "$entry"
    shots_dir="$SHOTS_BASE/$shots_name"
    report_file="$REPORTS_DIR/$slug.html"

    echo "========================================"
    echo "  Running: $title  ($script)"
    echo "========================================"

    t_start=$SECONDS
    status="pass"
    if node "$SCRIPT_DIR/$script" 2>&1; then
        echo "  => PASS"
    else
        # One-time retry. Many of these tests fail under sequential
        # load due to accumulated state in the editor-static / relay
        # broker (Cache Storage quota, /wasm/ files, room state) but
        # pass cleanly solo. A single retry catches transient flakes
        # without masking real regressions: if the test fails twice
        # in a row, that's a real signal.
        echo "  => first attempt failed, retrying once..."
        if node "$SCRIPT_DIR/$script" 2>&1; then
            echo "  => PASS (on retry)"
        else
            status="fail"
            echo "  => FAIL (both attempts, exit code $?)"
        fi
    fi
    elapsed=$((SECONDS - t_start))
    DURATIONS[$slug]="$elapsed"
    echo "  Duration: ${elapsed}s"

    RESULTS[$slug]="$status"
    TOTAL=$((TOTAL + 1))
    if [ "$status" = "pass" ]; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
    fi

    # Generate individual report
    node "$GENERATOR" \
        --name "$title" \
        --desc "$description" \
        --shots "$shots_dir" \
        --output "$report_file" \
        --status "$status"
done

# ── Generate summary index page ────────────────────────────────────────
TIMESTAMP="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

cat > "$REPORTS_DIR/index.html" <<HTMLEOF
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WASM Co-Editing Test Suite — Summary</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fff; color: #1a1a1a;
    line-height: 1.5;
  }
  .container { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .summary-bar {
    display: flex; gap: 1rem; margin-bottom: 1.5rem;
    font-weight: 600; font-size: 1rem;
  }
  .summary-bar .total { color: #444; }
  .summary-bar .pass  { color: #16a34a; }
  .summary-bar .fail  { color: #dc2626; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.6rem 0.75rem; }
  th { border-bottom: 2px solid #e5e7eb; font-size: 0.85rem; color: #888; text-transform: uppercase; letter-spacing: 0.04em; }
  td { border-bottom: 1px solid #f0f0f0; }
  tr:last-child td { border-bottom: none; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .badge {
    display: inline-block; padding: 0.15rem 0.6rem; border-radius: 4px;
    color: #fff; font-weight: 600; font-size: 0.85rem;
  }
  .badge-pass { background: #16a34a; }
  .badge-fail { background: #dc2626; }
</style>
</head>
<body>
<div class="container">
  <h1>WASM Co-Editing Test Suite</h1>
  <div class="meta">${TIMESTAMP}</div>
  <div class="summary-bar">
    <span class="total">Total: ${TOTAL}</span>
    <span class="pass">Passed: ${PASSED}</span>
    <span class="fail">Failed: ${FAILED}</span>
  </div>
  <table>
    <thead><tr><th>Status</th><th>Test</th><th>Time</th><th>Description</th></tr></thead>
    <tbody>
HTMLEOF

for entry in "${TESTS[@]}"; do
    IFS='|' read -r slug script title description shots_name <<< "$entry"
    st="${RESULTS[$slug]}"
    if [ "$st" = "pass" ]; then
        badge='<span class="badge badge-pass">PASS</span>'
    else
        badge='<span class="badge badge-fail">FAIL</span>'
    fi
    dur="${DURATIONS[$slug]}"
    if [ "$dur" -ge 60 ] 2>/dev/null; then
        dur_fmt="$((dur / 60))m $((dur % 60))s"
    else
        dur_fmt="${dur}s"
    fi
    cat >> "$REPORTS_DIR/index.html" <<ROW
      <tr>
        <td>${badge}</td>
        <td><a href="${slug}.html">${title}</a></td>
        <td style="color:#888;font-size:0.85rem;white-space:nowrap">${dur_fmt}</td>
        <td>${description}</td>
      </tr>
ROW
done

cat >> "$REPORTS_DIR/index.html" <<'HTMLEOF'
    </tbody>
  </table>
</div>
</body>
</html>
HTMLEOF

echo ""
echo "========================================"
echo "  Summary: ${PASSED}/${TOTAL} passed, ${FAILED} failed"
echo "  Report:  ${REPORTS_DIR}/index.html"
echo "========================================"
