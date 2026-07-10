# Full-suite migration to the Tresorit content viewer

Decision record (2026-07-10, user-approved): every test whose SUBJECT is
editor behavior migrates to run end-to-end through the content viewer
(`/collabora-tester` upload; co-edit via the tester's Co-edit checkbox +
join link), and the legacy-viewer version is RETIRED. Tests whose subject
is legacy-viewer machinery itself (v2 storage API, shield, prewarm,
hot-switch UI, deploy tripwires) stay on the legacy suite — the content
viewer has no equivalent surface.

CV co-edit gained SAVE-ROTATION first (relay-adapter CV save branch →
/shared-file overwrite + 0x07) so the rotation-dependent co-edit tests
port 1:1.

Status legend: [ ] pending · [x] migrated+verified · (kept) stays legacy.

## MIGRATE-SINGLE (54) — single-user editor behavior

- [ ] regression-print-button
- [ ] regression-console-noise-budget
- [ ] regression-editing-session-spam
- [ ] regression-writer-navigator-flash
- [ ] regression-insert-table
- [ ] pptx
- [ ] chart
- [ ] fonts
- [ ] regression-sidebar
- [ ] regression-samedoc-flicker
- [ ] regression-stylesview-overlap
- [ ] regression-stylesview-preview
- [ ] regression-ui-lang-resolve
- [ ] regression-lang-switcher-click
- [ ] regression-dict-multi-lang
- [ ] regression-dict-locale-resolve
- [ ] regression-mixed-lang-spellcheck
- [ ] regression-sidebar-deck-iconview-lang
- [ ] regression-spellcheck-squiggle
- [ ] regression-spell-rightclick-suggest
- [ ] regression-language-picker-multilang
- [ ] regression-spell-language-switch
- [ ] regression-iconview-rendercache-diag
- [ ] regression-fontsize-dropdown
- [ ] regression-heading-styles
- [ ] regression-real-copypaste
- [ ] regression-search
- [ ] regression-calc-impress-edits
- [ ] regression-docname-switch
- [ ] regression-image-insert
- [ ] e2e-copypaste
- [ ] regression-plaintext-paste
- [ ] regression-hard-refresh
- [ ] regression-hard-refresh-slow
- [ ] regression-rightclick-copypaste
- [ ] regression-xlsx-sheet-nav
- [ ] regression-xlsx-sheet-tabs-rename
- [ ] regression-pptx-transitions-iconview
- [ ] regression-impress-transition-click
- [ ] regression-pptx-save-no-abort
- [ ] regression-impress-area-dialog
- [ ] regression-writer-insert-shape-area
- [ ] regression-writer-shape-area-oom
- [ ] regression-docswitch-dialogs
- [ ] regression-area-palette
- [ ] regression-copy-paste-suite
- [ ] singleuser
- [ ] regression-font-change-ui
- [ ] regression-writer-header-footer-remove
- [ ] regression-double-click-word-copypaste
- [ ] regression-external-image-paste
- [ ] regression-mouse-drag-copypaste
- [ ] regression-ctrl-x-cut-restore
- [ ] regression-bulk-open-ignored

## MIGRATE-COEDIT (34) — relay co-edit behavior via CV rooms

- [ ] regression-checkpoint-cursor-delete
- [ ] 2browser
- [ ] 3browser
- [ ] formats
- [ ] pptx-coedit
- [ ] latejoin
- [ ] stress
- [ ] e2e-upload
- [ ] regression-sab-context
- [ ] regression-room-switch
- [ ] regression-checkpoint-timing
- [ ] regression-xlsx-hotswitch
- [ ] regression-cross-format-matrix
- [ ] regression-first-client-overwrite   (rotation)
- [ ] regression-latejoin-offline-unsaved (rotation)
- [ ] regression-latejoin-overwrite       (rotation)
- [ ] regression-latejoin-unsaved
- [ ] regression-select-delete-coedit
- [ ] regression-delete-key-coedit
- [ ] regression-paste-coedit
- [ ] coedit-convergence-churn
- [ ] coedit-concurrent
- [ ] coedit-feature-shape
- [ ] coedit-feature-table
- [ ] coedit-formatting
- [ ] coedit-rejoin-storm                 (rotation)
- [ ] coedit-spell-correct
- [ ] coedit-latejoin-checkpoint-retry    (rotation)
- [ ] coedit-spell-correct-latejoin
- [ ] coedit-convergence-conflict
- [ ] coedit-churn-load-budget
- [ ] coedit-latejoin-manymsg             (rotation-adjacent: bounded log)
- [ ] latejoin-copypaste
- [ ] regression-mouse-select-copypaste

## STAYS LEGACY (66) — subject is legacy-viewer machinery

viewer-server/v2 storage & APIs: relay, folder-api, regression-v2-file-api-shape,
regression-user-save-checkpoint, save-conflict, regression-viewer-cache,
regression-html-304, viewer-e2e, cold-open, singleuser-viewer,
regression-hash-deeplink, regression-coediting-mode-toggle,
regression-journey-recorder.
shield/prewarm/hot-switch UI: regression-shield-timing, regression-shield-prewarm-race,
prewarm, regression-prewarm-ready-signal, regression-latejoin-prewarm-race,
regression-viewer-hot-switch, regression-viewer-hot-switch-report,
regression-viewer-same-type-hot-switch, regression-hot-switch-watchdog,
regression-iframe-pool, regression-cluster-c, pptx-viewer, pptx-viewer-slides,
regression-open-progress-stages, regression-event-driven-docready.
caching/snapshot infra: caching, regression-wasm-cache-crosstype,
regression-wasm-cache-revisit, regression-wasm-cache-pressure,
regression-incognito-warm-cache, snapshot-stale, snapshot-milestones,
snapshot-cross-type, regression-snapshot-survival, regression-snapshot-injection.
build/deploy/config tripwires: regression-editor-static-fresh,
regression-editor-fd-wasm-fetchable, regression-cool-html-substitution,
regression-cool-html-script-tags, regression-cool-html-lang-init,
regression-brotli-sidecar, regression-metadata-brotli-build,
regression-bundle-js-prepend, regression-csp-frame-ancestors,
regression-coop-coep-corp, regression-sw-fingerprint, regression-sw-bridge,
regression-sw-activate-eviction, regression-immutable-cache-control,
regression-l10n-manifest, regression-l10n-manifest-ui-lang-sync,
regression-viewer-config-pointer, regression-editor-deploy-folder,
regression-launcher-env-vars, regression-app-build-artifacts,
regression-relay-adapter-protocol, regression-wopi-ready,
regression-jobs-scale, regression-jobs-scale-watchdog, regression-ui-lang.
meta: regression-flake-budget, regression-shape-area-allocation-suspects,
regression-dict-manifest-coverage.
