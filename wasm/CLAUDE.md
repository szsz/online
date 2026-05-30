# CLAUDE.md — wasm/ project instructions

Quick reference for Claude Code. Full architecture contract lives in
**[CO-EDITING-ARCHITECTURE.md](./CO-EDITING-ARCHITECTURE.md)** — read that before making non-trivial changes
to the relay protocol, checkpoint lifecycle, or v2 encryption flow.

## What this project is
A browser-only LibreOffice co-editor built on three services:
**viewer** (UI + v2 encrypted file storage + sidebar), **editor-static**
(serves cool.html + online.wasm + `/wasm/<name>`), and **message-relay**
(WebSocket broker for co-edit frames). An SNI router on :443 routes by
Host header; each service has its own cert.

**Hostnames per environment** (dev / test / internal / staging / prod /
CI stack) live in `CO-EDITING-ARCHITECTURE.md`'s `## Services` section
— don't hard-code them here; they change per dev box and per deploy
target.

## Key files
- `viewer-server.js` — HTTP: sidebar, `/api/v2/file`, `/api/blobs`, legacy `/api/files`
- `viewer-public/index.html` — viewer UI; `openFileBySecret`, shield, prewarm
- `message-relay.js` — WS protocol; frames 0x00–0x0A (see CO-EDITING-ARCHITECTURE.md)
- `relay-adapter.js` — iframe-side client of message-relay
- `wasm-loader.js` — iframe-side hash-switch bridge, snapshot load/save
- `deploy.sh` — apply snapshot inject, rehash, **restart relay**
- `launch-{viewer,editor-static,relay}.sh` — per-service starters

## Config
All env in `wasm/.env`. Never hardcode paths in source. Each service
reads namespaced vars (`RELAY_SSL_CERT`, `EDITOR_SSL_CERT`; viewer uses
bare `SSL_CERT`/`PORT`).

## Workflow — read the working lists at `ai/`

Per-dev gitignored queues, status = subfolder. **This is the source of
truth for what to work on next.**

- `ai/tasks/{todo,in-progress,parked,done}/<slug>.md` — work queue.
- `ai/proposals/{proposed,promoted,rejected}/<slug>.md` — sideways
  findings the user reviews.
- `ai/questions/{pending,answered}/<slug>.md` — decisions blocking
  parked tasks; the **single** ntfy.sh notification channel watches
  `pending/`.

See `ai/README.md` (and each subdir's README) for conventions. Status
changes use `git mv` so history is preserved.

### Autonomous mode (the default)

**While `ai/tasks/todo/` has unparked entries, keep iterating without
asking.** The skills `/dev-iterate` and `/fix-bug` already encode the
discipline (branch → failing E2E test via `/write-test` → fix →
snapshot gate → PR). Pick, ship, move task to `done/`, pick the next.

If you hit a decision a human must make: `git mv` the task to
`ai/tasks/parked/` and write `ai/questions/pending/<slug>.md` — the
ntfy hook will notify the user. Don't block on `AskUserQuestion`.

### Sideways findings — inline-if-related, proposal-if-unrelated

While working any iteration you'll notice things adjacent to the
current task. **Determine by scope:**

- **Related** = same subsystem, same files you're already touching,
  defect uncovered by the test you just wrote, one-line cleanup in
  code you're editing. **Fix it inline in the current commit.** Note
  it in the commit body. No proposal needed — filing one for a 5-line
  cleanup in a file you're already in adds ceremony for no gain.
- **Unrelated** = different code path, separate verification cycle
  needed, would balloon the PR's diff or require an LO rebuild.
  Write `ai/proposals/proposed/<slug>.md` — the user reviews and
  promotes accepted ones to `ai/tasks/todo/` themselves.

"Related" means: no need to touch files outside the current diff, no
separate test cycle, no extra LO build. If you'd have to widen scope
to fix it → proposal.

**Never write directly to `ai/tasks/todo/`.** New task entries appear
only when the user explicitly says "create a task for X" OR when
they promote a proposal themselves. Backlog stays curated, not
auto-flooded.

### One PR at a time on `dev` — batch iterations

The self-hosted runner is single-tenant; full CI takes 60-90 min;
multiple open PRs saturate the queue for half a day. **Only ONE PR is
open against `dev` at a time.** Multiple iterations accumulate as
commits on the same accumulator branch; CI re-runs once per push and
covers the full batch.

- Before committing, `gh pr list --state open --base dev`. If a PR
  is open → `gh pr checkout <N>` and commit on top. If not → branch
  `batch/<topic>-<YYYY-MM-DD>` off `origin/dev`, commit, push, open
  the PR (now the next accumulator).
- Each commit must be **independently revert-able**. A failing batch
  CI is recovered by reverting just the bad commit, not the whole
  batch. Risky / speculative changes go in their own accumulator.
- **Hold pushes while CI is in-progress on the current batch.**
  Pushing mid-CI cancels + re-queues from scratch. Only push mid-CI
  for a critical hot-fix to an active CI failure.
- LO-core PRs and `LO_BUILD_ID` bumps are exempt — different repo,
  different cycle, always their own PR.
- When the accumulator auto-merges (on green build-deploy-test), the
  next iter starts a fresh accumulator branch.

## Engineering rules (from user feedback, durable)
- All user input goes through the relay; never bypass for "own" messages.
- Every fixed bug gets a `test-regression-*.js` + entry in `run-all-tests.sh`.
- **Tests must drive through visible UI** — never `sendUnoCommand`,
  `app.dispatcher.dispatch`, or `page.evaluate(()=>el.click())` to
  exercise the bug. Use `/write-test` to author new tests; see
  `.claude/skills/write-test/SKILL.md` for the full forbidden /
  allowed pattern + template.
- No configuration in source code — only `.env`.
- Deploying code requires restarting the relay (`deploy.sh` does this).
- No backwards-compat hacks; delete legacy when v2 supersedes it.
- Don't use `--ignore-certificate-errors` for cert-validity tests — it
  hides the silent SAN-mismatch class of bug.
- For viewer UX changes: test in a real browser; shield logic has many
  edge cases the unit tests don't catch.

## Testing
- `bash run-all-tests.sh` — full suite (~56 tests, ~60 min on Azure).
- `bash run-focused-tests.sh` — fast iter cycle (~15 min, 10 tests:
  hot-switch, copy/paste, co-edit cluster, snapshot-milestones).
  Use during active fix work; full suite for sign-off.
- `test-regression-snapshot-injection.js` runs first; fails fast (<500ms)
  if `deploy.sh` didn't apply the HEAPU8 injection to `online.js`.
- Run flaky tests **solo** (`timeout 600 node wasm/test-X.js`) to
  isolate from parallel-run noise — relay broker and viewer-server
  slow under load and 2-browser tests time out at 300s waiting for
  the second tab to render. `regression-paste-coedit` and
  `snapshot-milestones` are known to flake under JOBS=2 but pass solo.
- For new tests with explicit timeouts that mark *patience* (waiting
  for the second tab to render, doc-load wait, replay completion),
  route the value through `env.scaleTimeout(ms)`:
  ```js
  await page.goto(url, { timeout: env.scaleTimeout(60000) });
  ```
  Parallel runners export `JOBS_SCALE` from their `JOBS` env, so a
  test that scales widens automatically under contention. Don't wrap
  perf-budget assertions (e.g. `tTotal < 30000` "warm-path was fast
  enough") — those should fail when warm slows down. The wrapper
  timeout in `run-focused-tests.sh` and `run-all-tests-parallel.sh`
  also scales with JOBS_SCALE so internal patience can widen safely.
  `test-regression-jobs-scale.js` enforces that the contention-flaky
  tests keep their `env.scaleTimeout` calls.
- Viewer tests use v2 uploads via `lib/v2-upload.js`, not legacy
  `/api/files/` POST. v2 files DO NOT appear in `/api/files`; query
  `/api/v2/file/<fileId>` directly. The endpoint returns
  `{ciphertext, encName, size, updatedAt}` (no plaintext hash) — hash
  the ciphertext locally for change detection.
- Tests that bypass the viewer and go direct to `cool.html` must also
  stage `/wasm/<fileId>` so Kit can read the file (pattern in
  `test-caching.js`).
- For hot-switch tests, **don't trust status text alone** —
  `#StatusDocPos` / `#SlideStatus` carries over from the previous doc
  so `/Sheet 1 of 1/` matches before AND after the switch. Capture a
  canvas pixel-hash before the hashchange and require it to differ
  after (pattern in `test-hotswitch-xlsx.js`). Note: Impress uses
  `#SlideStatus`, Calc/Writer use `#StatusDocPos`.
- For co-edit / single-user diagnosis, write a minimal repro that
  captures both browsers' relay-adapter logs and reads them as pairs
  to find asymmetries (pattern in `test-coedit-propagation-diag.js`):
  ```js
  page.on('console', m => {
      if (/relay|processUI|remote client|queued|Flushing|preinit/.test(m.text()))
          sink.push(`[${(Date.now()-T0)/1000}s ${tag}] ${m.text()}`);
  });
  ```
- Relay broker logs at `/tmp/relay-iter4.log` (root-owned, `sudo cat …`).
  Shows `JOIN viewId=... checkpoint=...`, `JOIN READY`,
  `CHECKPOINT MISMATCH`, `Room cleaned up`. Authoritative source when
  the browser logs disagree about which client joined first.
- Reports land at `/tmp/static-deploy/public/reports{,-focused}/`,
  per-test logs at `.logs/<slug>.log`. Per-test timeout in the
  parallel runners is 1800 s.

## How to make changes to LibreOffice (and Online)

**LO builds are CI-only.** `wasm/build-wasm.sh` defaults to fetching the
published LO artefact pinned by `wasm/LO_BUILD_ID` (via
`wasm/fetch-lo-build.sh`, which downloads + extracts under
`~/.cache/lo-builds/<ID>/`) and builds Online against it — same recipe
the CI uses. `--local-lo` opts into a legacy path that bind-mounts
`$HOME/libreoffice-core-wasm` and rebuilds LO core inside docker; outputs
from this mode are for inner-loop debugging only and MUST NOT be deployed.

There are exactly two ways to publish a new LO build:

1. **PR to `dev` of `szsz/libreoffice-core-wasm`.** CI builds the PR head
   on the self-hosted runner, publishes artefacts to
   `coolwasmfiles/lo-builds/<BUILD_ID>/`, and on green auto-merges
   (`gh pr merge --rebase --auto`). The merged `dev` HEAD then equals the
   PR head SHA, so the artefact and the source line up exactly.

2. **`workflow_dispatch` on libreoffice-core-wasm with an explicit
   `sha` input.** Rebuilds that specific commit. Use this to re-mint
   an artefact for an old LO commit (e.g., after Azure storage GC).

Build IDs are `YYYY-MM-DD-<gh_run_number>`, unique per CI run.

### Pointing Online at a new LO build

Open a PR on `szsz/online` that bumps `wasm/LO_BUILD_ID` to the new ID
(or to `__LATEST__`). The Online CI's `validate-lo-build` job verifies
the build exists on coolwasmfiles before allowing the PR to land.
On green it auto-merges; the post-merge `push: dev` event then runs the
full build/deploy/test for the wasm sites.

### Redeploying an old Online commit

`workflow_dispatch` the Online `wasm-ci.yml` with:
- `online_sha` — the Online commit SHA to redeploy (default: HEAD of dev).
- `lo_build_id` — optional override; defaults to the value pinned at
  that commit's `wasm/LO_BUILD_ID`.

This lets you roll back without writing a revert PR — every past
Online commit + its pinned LO build is reproducible.

### What NOT to do

- Don't push directly to `dev` on either repo (branch protection should
  block this; if it doesn't, the `wasm-ci` workflow's `push: dev`
  trigger will deploy whatever you pushed without a review).
- Don't run `build-wasm.sh` / `iterate.sh` and copy the resulting
  `online.wasm` to `/tmp/static-deploy/` for production use. Those
  outputs are not tracked by `LO_BUILD_ID` and a future redeploy will
  drift silently.
- Don't bump `wasm/LO_BUILD_ID` to a value that isn't published. The
  validate gate catches it on PR open, but it wastes a CI cycle.

## When in doubt
- Protocol changes → read CO-EDITING-ARCHITECTURE.md's "Relay protocol — frames" first.
- Deploy is failing → check `wasm/.env` for the three namespaces;
  `launch-relay.sh` refuses if `RELAY_SSL_CERT` is unreadable.
- Warm path is fragile (see CO-EDITING-ARCHITECTURE.md "Known limitations") — snapshot
  restore + `__wasmInitialDocLoaded` flag interaction is the current
  debugging surface.

## Doing work in this repo
- Default to running `run-all-tests.sh` only when asked — it's an hour.
- Small changes: verify with a single relevant `test-*.js` first.
- The Plan agent knows this codebase well — use it for implementation
  plans on anything touching the protocol or snapshot lifecycle.
