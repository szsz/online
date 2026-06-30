# Phase 2 — re-enable WASM snapshot warm-restore

The killswitch in `wasm-loader.js` (`SNAPSHOT_DISABLED=true`) makes every
visit cold. This document captures everything I learned tracing the
warm-restore failure on 2026-04-25 so the next person/session can pick
up where this left off.

## Why warm restore is currently broken

The snapshot is saved inside `Desktop::Main` via
`wasmshim::waitForSnapshot()` — that point is reached *before* Kit's
event loop (`Execute()`) runs, which means **before any user document
has been loaded into Kit**. `preloadDocumentModules()` opens and
disposes a blank Writer/Calc/Impress to warm the modules, but the
disposes ensure no Document survives into the snapshot.

On warm restore the heap is faithfully reconstructed, but every Kit
`ChildSession` reaches the loaded-state check (`kit/ChildSession.cpp:589`,
`if (!_isDocLoaded)`) with `_isDocLoaded == false`. Every UNO command
fails with `error: cmd=<verb> kind=nodocloaded`, surfacing as a modal
alert in the editor where the spreadsheet should be.

The screenshot of the failure mode is at `/tmp/warm-verify.png`
(captured during this session): document name shows in the title bar,
empty editor area, and a modal saying `cmd=file:///tempdoc kind=nodocloaded`.

## What also goes wrong

A second, related failure is that JS sends
`switchdocument url=<origin>/wasm/<filename>` as an early message after
warm restore. That message hits **WSD's WebSocket-upgrade handler**
in `wsd/ClientRequestDispatcher.cpp:889` which expects
`<command> <numeric_appDocId>` and tries to parse `url=…` as a
u64 — failing with `Bad document ID "url=https://…" in "switchdocume[nt]"`.
The dispatcher then routes the connection through a partially-set-up
state where ChildSession::loadDocument never completes, perpetuating
the `_isDocLoaded == false` failure above.

## What's already in place

- `wasm/wasmsnapshot.cxx` (LO fork) — snapshot save/restore primitives,
  `wasmshim::{waitForSnapshot, preloadDocumentModules,
  wasm_snapshot_complete}`.
- `wasmshim::waitForSnapshot()` uses a 60s `wait_for(condvar, …)` —
  Phase 1 hardening so a hung JS side doesn't permablock LO.
- `try/catch` around `preloadDocumentModules` in `Desktop::Main`.
- `lo_initialize` forces `eStage = SECOND_INIT` on snapshot restore.
- `Application::clearInstancePointer()` (Poco patch) called by
  `COOLWSD::leakSnapshotPolls` before the warm-visit `new COOLWSD()`.
- `g_argv1`, `g_argv2` are owning `std::string` globals so the
  `std::thread` lambda doesn't reference dangling `argv_main` after
  `main()` returns on warm visit.
- Strict snapshot fingerprint check rejects pre-fingerprint and
  fingerprint-mismatched snapshots.

## The three pieces Phase 2 needs

### 1. Move snapshot save to *after* Kit's first doc load
- New `extern "C"` callback emitted from Kit when
  `LOK_CALLBACK_DOCUMENT_LOADED` fires (or equivalent: the point where
  `_isDocLoaded` flips true on at least one ChildSession).
- `wasmsnapshot.cxx` exposes a second wait point keyed off that
  callback. Desktop::Main waits, runs preload, then waits *again* for
  Kit's first doc load before triggering JS save.
- Or: don't use `Desktop::Main` as the save trigger at all — let Kit
  (which sees the callback) signal JS directly.

### 2. Per-module snapshot baselines — or robust cross-module switchdoc
- Cleanest option: load a baseline `swriter`, save snapshot tagged
  `:writer`. Same for `:calc`, `:impress`. Restore the matching one
  based on the user's file extension. Caches three blobs ~150MB each.
- Cheaper: one snapshot with one baseline. Test that a Calc-blank →
  xlsx switch and an Impress-blank → pptx switch both work cleanly via
  the existing cross-type hot-switch path (see commit history for
  task #88: "Implement cross-type hot-switch (persistent WASM
  module)").

### 3. Fix WSD upgrade-handler tolerance for switchdocument first-message
- `wsd/ClientRequestDispatcher.cpp:889` — the post-HULLO appDocId
  parser. Either:
  (a) Detect `switchdocument` and skip the appDocId parse (route to
      the message handler with `mobileAppDocId = 0`).
  (b) Change the JS-side wire protocol so warm-restore doesn't send
      `switchdocument` until after the WS upgrade has returned a
      `coolclient` ready response.
- (a) is smaller and avoids any JS-side timing changes.

## How to verify Phase 2 once landed

- Flip `SNAPSHOT_DISABLED = false` in `wasm-loader.js`.
- `bash wasm/build-wasm.sh && bash wasm/deploy.sh`.
- Run `node wasm/test-snapshot-same-doc.js` — both cold and warm
  must reach `Document ready`. Warm should land in <5s.
- Run `bash wasm/run-all-tests.sh` — Format Tests B (currently
  failing because B's puppeteer page shares Cache Storage with A and
  hits warm-restore) should pass.

## Test fixtures useful for Phase 2 work

- `node wasm/test-deploy-smoke.js` — fast (60s) cold-only smoke.
- `node wasm/test-cold-only.js` — verifies multiple consecutive cold
  visits all reach a real canvas. Sanity check.
- `wasm/repro-warm.js` — open the user's URL in cold-then-warm with
  persistent userDataDir, capture timeline + DOM. Most useful repro
  for warm-restore debugging.
- `/tmp/warm-verify.png` — known failure-mode screenshot.

## Don't lose the killswitch

When Phase 2 lands, search for `SNAPSHOT_DISABLED` in
`wasm/wasm-loader.js`, flip the bool, and remove the surrounding
killswitch branches.
