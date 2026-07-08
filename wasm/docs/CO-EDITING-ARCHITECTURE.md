# Co-Editing Architecture

The full contract for this project. `CLAUDE.md` is the quick-reference;
this file is the authoritative spec.

## Core principles

1. **Each browser tab runs its own full WASM LibreOffice instance.** No shared memory between tabs.
2. **Each tab has its own cursor.** Remote cursors are displayed as colored markers but never move the local cursor.
3. **Every user-input action goes through the relay first.** The relay assigns a monotonically-increasing sequence number, broadcasts to all clients, and only then does each client apply the action. The relay is the single source of truth for total ordering.
4. **The relay never stores file bytes.** It holds metadata: current checkpoint (`{hash, locator, seq, cursors}`) and a bounded broadcast messageLog.
5. **Snapshots only contain prewarm-blank state — never any user file.** The HEAPU8 snapshot saved to Cache Storage represents Kit/COOLWSD with the empty `__prewarm_blank.<ext>` loaded for the captured doctype. Capturing user-doc state into the snapshot is forbidden: it would persist user content (potentially confidential) on disk in browser cache, leak across sessions / users on shared machines, and bake stale content that diverges from the canonical file in storage. The snapshot is purely a runtime warm-start optimisation (factories + module + blank doc loaded); the user's actual file is fetched and parsed on every visit through the normal load path.

## Services

Three services per environment. Hostnames vary across **dev box**,
**Azure test**, **Azure internal**, **Azure staging**, **Azure prod**,
and the **CI stack** (a parallel Azure environment driven by the
self-hosted GitHub Actions runner). Production user traffic only hits
staging + prod; everything else is for development, CI, and ad-hoc
validation.

### Per-environment service roles

Same role across every tier — the differences are deploy target,
storage backend, and the URL the user sees. Roles:

| Service | Role |
|---|---|
| **viewer** (`viewer-server.js`) | Sidebar UI, v2 encrypted storage (`/api/v2/file`), blob index (`/api/blobs`), legacy `/api/files`. |
| **editor-static** (`editor-static-server.js` — local-only) / **Azure Front Door** (all Azure tiers) | Serves `cool.html` + `online.wasm` + `/wasm/<name>` plaintext staging. On Azure tiers the editor lives at a per-deploy folder on Front Door + Storage static-website (no editor App Service). |
| **relay** (`message-relay.js`) | WebSocket broker — metadata + message ordering only. |
| **sni-router** (`sni-router.js`, local only) | Routes :443 → backend by Host header. Each backend has its own Let's Encrypt cert. |

Certs on the dev box are configured per-service in `wasm/.env` under
namespaced keys (`RELAY_SSL_CERT`, `EDITOR_SSL_CERT`; the viewer uses
bare `SSL_CERT`/`PORT`). On Azure tiers the cert lives on the App
Service / Front Door.

### Per-environment hostnames

| Env | Viewer | Editor | Relay | Notes |
|---|---|---|---|---|
| **Local (dev box)** | `viewer.szebeni.hu` (port 6934 behind SNI) | `wasm.atgpartners.info` (port 6932 behind SNI) | `relay.atgpartners.info` (port 9091 behind SNI) | Runs via `wasm/launch-{viewer,editor-static,relay,sni-router}.sh`. Plaintext storage; no encryption boundary. |
| **Azure test** | `wasm-viewer-test.azurewebsites.net` | `wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net` (per-deploy folder `/<EDITOR_DEPLOY_ID>/`) | `wasm-relay-test.azurewebsites.net` | Throwaway env wrapped by `/test-deploy`; env file at `~/ENV/online-test-deploy.env`. |
| **Azure internal** | `wasm-viewer-internal.azurewebsites.net` | same FD endpoint, different `EDITOR_DEPLOY_ID` App Setting | `wasm-relay-internal.azurewebsites.net` | Manual deploy via `wasm/deploy-internal.sh`; env at `~/ENV/online-internal-deploy.env`. |
| **Azure staging** | `szebeni-wasm-viewer.azurewebsites.net` | same FD endpoint, staging `EDITOR_DEPLOY_ID` | `szebeni-wasm-relay.azurewebsites.net` | CI-driven via merge to `dev`; env at `~/ENV/online-staging-deploy.env`. |
| **Azure prod** | _(set in `~/ENV/online-prod-deploy.env` when used)_ | same FD endpoint, prod `EDITOR_DEPLOY_ID` | _(same env file)_ | Manual promotion via `wasm/promote-online-build.sh latest ~/ENV/online-prod-deploy.env`. |
| **CI stack** | `ci-viewer.szebeni.hu` (port 7934 behind SNI) | `ci-editor.atgpartners.info` (port 7932 behind SNI) | `ci-relay.atgpartners.info` (port 9092 behind SNI) | Parallel of the local stack, driven by the self-hosted runner via `wasm-ci-local.yml`. Reports at `coolwasmfiles.z6.web.core.windows.net/local-builds/<id>/tests/`. |

The Front Door endpoint (`wasmeditor-enhhe6gndwb0d2ej.a02.azurefd.net`)
is shared across **all** Azure tiers. Per-tier separation happens via
the `EDITOR_DEPLOY_ID` App Setting on each viewer App Service — it
points the viewer at the `<EDITOR_DEPLOY_ID>/` folder on Front Door.
That's how `wasm/promote-editor.sh` (against any tier's env file)
flips an editor build without redeploying the viewer.

### Authoritative env files

The dev-box env layout lives in `wasm/.env` (gitignored; example at
`wasm/.env.example`). The Azure tier deploy configs live OUTSIDE the
repo at `~/ENV/online-*.env`:

- `~/ENV/online-test-deploy.env` — Azure test
- `~/ENV/online-internal-deploy.env` — Azure internal
- `~/ENV/online-staging-deploy.env` — Azure staging
- `~/ENV/online-prod-deploy.env` — Azure prod
- `~/ENV/online-ci.env` — CI stack
- `~/ENV/online.env` — dev box default (sources viewer-config.json
  for the local editor pointer)

Example templates ship with `wasm/.env.deploy.{test,internal,staging}.example`.

### Service supervision (on-box stacks)

The dev + CI on-box stacks run under **systemd** (not ad-hoc `nohup`), one
unit per service with `Restart=always` and a **pinned** `Environment=ENV_FILE`
so a CI job's exported `ENV_FILE` can never make a restart relaunch the wrong
tier on the wrong port/cert:

| Unit | Instance | Port |
|---|---|---|
| `coolwasm-viewer@.service` | `@online` / `@online-ci` | 6934 / 7934 |
| `coolwasm-editor-static@.service` | `@online` / `@online-ci` | 6932 / 7932 |
| `coolwasm-relay@.service` | `@online` / `@online-ci` | 9091 / 9092 |
| `coolwasm-sni-router.service` | shared | 443 |

`%i` is the ENV-file basename (`@online` → `online.env`, `@online-ci` →
`online-ci.env`). Bring up / recover a stack with
`sudo bash wasm/systemd/install-stack-units.sh [all|dev|ci]` (idempotent:
installs the units, frees any ad-hoc ports, enables + starts). Day-to-day:
`systemctl {status,restart} coolwasm-viewer@online-ci`,
`journalctl -u coolwasm-relay@online -f`; logs at `/var/log/coolwasm/`. Unit
files live in `wasm/systemd/`; `launch-*.sh` remain the ExecStart entrypoints.
The viewer launcher mints `DOC_STORAGE_KEY` as the repo owner when run as root
(root has no `az` context). See `wasm/deploy.sh` — it is systemd-aware: it
`systemctl restart`s a managed editor-static/relay unit instead of kill+nohup,
targeting the deploy's own tier.

### Operating-principle boundaries

- `/dev-iterate` and `/fix-bug` may verify against **local stack** and
  **Azure test** only. Staging / internal / prod / CI stack stay
  hands-off — they're CI-managed or operator-only.
- Reading CI state is always allowed (logs, run lists, artifact URLs).
- Internal is "off limits to skills" but the user has on past occasions
  asked for one-off rollbacks there; treat such requests as
  scope-limited authorizations.

## Message flow

```
User action (type / click / UNO)
    ↓
interceptedSend() — does NOT apply locally yet
    ↓
Relay assigns seq#, broadcasts to ALL clients (including sender)
    ↓
Each client receives the broadcast in seq order
    ↓
Own viewId → sendToKit() (local view, local cursor)
Other viewId → sendToRemoteClient() (remote view, remote cursor)
```

### Intercepted (go through relay)
- `key`, `textinput`, `windowkey` — keyboard input and IME
- `mouse type=button…` — mouse clicks
- `uno` — UNO commands (InsertRows, Bold, …)
- `removetextcontext`, `removetextcontent`, `contentcontrolevent`, `moveselectedclientparts`, `completefunction`, `selecttext`, `insertfile`, `paste`, `resetselection` — other user-input variants

### NOT intercepted (local only)
- `clientzoom`, `clientvisiblearea` — per-view display state
- `tileprocessed`, `commandvalues` — tile cache management
- Status queries — read-only

### Mouse-move special case
- `mouse type=move` **goes directly to Kit**, not through the relay.
- `_lastMouseMove` is buffered locally.
- Before the next `mouse type=button…`, the buffered move is flushed to the relay so remote Kits see the cursor position at click time — start and end points of a drag-selection without flooding the relay with every intermediate pixel.
- Implemented in `relay-adapter.js:659-669`.

## Multi-view architecture

Each WASM instance maintains multiple views of the same document.

- **Local view**: the user's own session. Local cursor, local selection. Receives own actions back from the relay via `sendToKit()`.
- **Remote views**: one per remote peer. Created via `create_remote_client()` in the Kit. Each has its own cursor + selection. Receives that peer's actions via `sendToRemoteClient()` → `handle_remote_message()`.

All views share the same in-memory `Document` object. Changes via any view are visible to all. Tile invalidations propagate across views.

### Why remote views are required
UNO commands are **cursor-context-dependent**. B's `InsertRowsAfter` must execute in B's *remote view on A's WASM*, where B's cursor is inside the table (set by B's earlier mouse clicks). Executing it in A's local view would insert at A's cursor — wrong.

## Relay protocol — frames

All frames: `[type(1)] [viewId(4, BE)] [payload…]`. Broadcast frames (0x00) from server to client insert `[seq(4, BE)]` between viewId and payload.

| Type | Dir | Name | Payload | Purpose |
|---|---|---|---|---|
| **0x00** | both | User message | seq(server) + bytes | Kit↔Kit broadcast (keys, clicks, UNO) |
| **0x02** | S→C | Announce join | `{viewId, seq}` | New peer joined |
| **0x03** | S→C | Announce leave | `{viewId, seq}` | Peer disconnected |
| **0x04** | C→S | Join request | (empty) | "I want in" |
| **0x05** | S→C | Join response | `{first, hash?, locator?, seq, cursors?, msgCount}` | "You're first" OR checkpoint + cursor-replay for late joiners |
| **0x06** | C→S | Join ready / register | `{hash, locator?}` | First client registers the room's initial checkpoint; late joiner confirms hash |
| **0x07** | C→S | Save-rotation | `{hash, locator, seq, cursors}` | After Ctrl+S, rotate the checkpoint and prune the messageLog |
| **0x0A** | S→C | Mismatch redirect | `{expected, locator, seq}` | "Your hash didn't match — re-download" |

Reserved: 0x01, 0x09 (ack; relay ignores today).

## Room lifecycle

**Empty room → first joiner**
1. Client opens WS → `Connected`.
2. Client sends `0x04 JOIN viewId=N`.
3. Relay: `activeClients.size == 0 && !checkpointHash` → `0x05 {first:true, seq:0}`, `activeClients.add(ws)`, `_joining=false`.
4. Client boots Kit, computes `hash = sha256(/wasm/<wopiSrc>)`, sends `0x06 {hash, locator}`.
5. Relay's `0x06` handler: `registerCheckpoint(hash, locator, 0, {})` — room is now open. Any joiners parked in `waitingForCheckpoint` get flushed.

**Late joiner, checkpoint already registered**
1. WS connect, `0x04`.
2. Relay: `checkpointHash` set → `serveCheckpoint(ws)` → `0x05 {first:false, hash, locator, seq, cursors, msgCount}`, `_joinBuffering=true`, `_joinBuffer = messageLog`.
3. Client fetches bytes from `locator`, verifies `sha256 === hash`, loads into Kit (via `switchdocument` onto the existing prewarm Kit — single LO main loop), applies `cursors` as peer cursor decorations, replays `_joinBuffer` through local Kit.
   - **Replay must wait for `switchdocument` to COMPLETE.** Replay is gated on the kit's switchdoc-complete signal (`window.__wasmSwitchDocLoaded`, set by `MAIN_THREAD_ASYNC_EM_ASM` at the `SWITCHDOC "complete"` point in `kit/ChildSession.cpp`), NOT merely on kit-preinit. Otherwise, with many unsaved messages, the ~90-frame replay finishes and applies to the *prewarm blank* before `switchdocument` loads the checkpoint doc — which then discards every replayed edit, so the joiner silently lands on the bare base doc. `relay-adapter.js startActivationPoll` holds activation (and thus replay) until the flag is set, with a 30 s bounded fallback so a broken switch degrades rather than hangs.
4. Client sends `0x06 {hash}`.
5. Relay compares `clientHash === expected`. Match → replay buffered frames, `activeClients.add`, `announceJoin`. Mismatch → `0x0A {expected, locator, seq}`, client re-downloads from the authoritative locator.

**Parked joiner (before first 0x06 lands)**
1. Client sends `0x04`. Relay: `!checkpointHash && activeClients.size > 0` → add to `room.waitingForCheckpoint`. **No response yet.**
2. The first client's `0x06` fires `registerCheckpoint` → all parked clients get their `0x05` immediately. No save round-trip.

**Save → checkpoint rotation**
1. Active client performs Ctrl+S. `.uno:Save` triggers Kit to serialize the doc.
2. Client POSTs the bytes to the file manager (viewer). Viewer encrypts (v2) and stores at `/api/v2/file/<fileId>`; the locator remains the v2 URL.
3. Client sends `0x07 {hash, locator, seq, cursors}` where:
   - `hash` = sha256 of the plaintext bytes just saved
   - `locator` = URL late joiners fetch from
   - `seq` = last broadcast message seq processed when the save started
   - `cursors` = snapshot of the relay's current cursor map (server authoritative; see below)
4. Relay: `registerCheckpoint(hash, locator, seq, cursors)` replaces the current checkpoint and prunes `messageLog` to `seq' > seq`.
   - **No-op-save invariant:** `relay-adapter.js saveAndUploadCheckpoint` only sends `0x07` (rotate + prune) when the saved bytes actually ADVANCED past the current checkpoint (`hash !== prevHash`). A byte-identical save does NOT rotate — otherwise it would prune the messageLog while the on-disk file failed to capture a live-but-unpersisted edit (e.g. a spell-correction / language change that LO didn't re-serialize), dropping that edit for late-joiners while live peers keep it. Skipping rotation keeps the edit replayable.
5. Already-connected peers don't reload — they're live-synced.
6. Future late joiners load from the new checkpoint and start replay from messages `seq' > seq`.

**Leave**
1. WS close → remove from `clients`, `activeClients`, `waitingForCheckpoint`.
2. If had `viewId`, `announceLeave(viewId)` → `0x03` to remaining active peers.
3. Room cleanup 60s after `clients.size === 0 && messageLog.length === 0`.

## Checkpoint model

A room has ONE current checkpoint at any instant: `{hash, locator, seq, cursors}`.

- **`hash`** — sha256 hex of the plaintext bytes at `locator`. Required.
- **`locator`** — URL any client can fetch those bytes from. Today `/wasm/<wopiSrc>` on the editor-static for initial open; `/api/v2/file/<fileId>` for v2-stored saves.
- **`seq`** — the last broadcast seq this checkpoint reflects. `0` on initial registration (nothing broadcast yet). Save-rotation uses the last-processed seq at save time.
- **`cursors`** — map `viewId → {frame}` of the last cursor-related broadcast per peer. Late joiners apply these before starting replay, so they see peer cursors immediately without waiting for the next cursor move.

**Convergence** holds because (a) every late joiner downloading the same `locator` at the same `seq` gets byte-identical bytes; (b) messages with `seq <= checkpoint.seq` are pruned; (c) live peers don't reload — they continue from accumulated in-memory state which by construction is the same as what a fresh joiner lands on.

### Checkpoint verification (mandatory)
Every client that opens a checkpoint MUST verify `sha256(downloaded-bytes) === checkpoint.hash`. Mismatch → show an error AND do not activate. The `0x0A` flow gives the client a chance to re-download from the authoritative locator.

## V2 encryption

Files uploaded via the viewer are encrypted under a 128-bit secret embedded in the URL fragment (`#file=<22-char-b64url>`).

- **Key derivation**: HKDF-SHA256 on the 16-byte secret → `contentKey` (32B AES), `nameKey` (32B AES), `fileIdBytes` (32B → hex = 64-char `fileId`).
- **Ciphertext layout**: 12-byte random IV + AES-256-GCM ciphertext + 16-byte tag. Filename is separately encrypted under `nameKey`.
- **Storage**: ciphertext + `encName` stored at `/api/v2/file/<fileId>` on the viewer. The server sees opaque bytes.
- **Open flow**: viewer fetches ciphertext, decrypts client-side, POSTs plaintext to `/wasm/<fileId>` on the editor, then spawns the editor iframe with `WOPISrc=<fileId>`. The editor and relay never see the decryption key.
- **Key custody**: the URL-fragment secret never leaves the browser. `localStorage.rf_v1` caches `{secret, fileId, cachedName}` per file the browser has seen so the sidebar can render the plaintext name.
- **Save-back**: Ctrl+S sends plaintext bytes to the viewer; the viewer encrypts and stores. The editor does not perform encryption — that responsibility lives in the file manager.

## Deploy contract

- `wasm/deploy.sh` rebuilds staging, re-applies the snapshot-restore injection into `online.js` (fail-loud on missing target), rotates editor-static JS hashes via SIGHUP, and **restarts the relay** so no client stays on a mismatched WS protocol.
- `test-regression-snapshot-injection.js` runs first in `run-all-tests.sh` — ~500 ms HTTP probe that catches broken deploys instantly.
- Each service must start via its `launch-*.sh` wrapper so .env is sourced correctly and the right TLS cert is used.

## Build & release policy

**LO builds are CI-only.** Two paths to a published LO build:

1. **PR to `dev` of `szsz/libreoffice-core-wasm`.** CI builds the PR head, publishes artefacts to `coolwasmfiles/lo-builds/<BUILD_ID>/`, and on green auto-merges (`gh pr merge --rebase --auto`). The merged `dev` HEAD equals the PR head SHA, so artefacts and source line up.
2. **`workflow_dispatch`** on libreoffice-core-wasm with an explicit `sha` input — re-mints an artefact for any past commit.

Build IDs are `YYYY-MM-DD-<gh_run_number>`, unique per CI run.

`wasm/LO_BUILD_ID` (in this repo) pins exactly one CI artefact. The Online CI's `validate-lo-build` job verifies the pin exists on coolwasmfiles before allowing a PR to land.

**Online deploys** follow the same two-path policy:

1. **PR to `dev`** — `validate-lo-build` runs; on green auto-merges. The post-merge `push: dev` event then runs the full build/deploy/test.
2. **`workflow_dispatch`** with `online_sha` — redeploy any past Online commit. `lo_build_id` defaults to that commit's `wasm/LO_BUILD_ID`.

### Local builds against a published LO

`wasm/build-wasm.sh` (default mode) calls `wasm/fetch-lo-build.sh` to
download the LO artefact pinned by `wasm/LO_BUILD_ID` from the public
coolwasmfiles endpoint, extracts it under `~/.cache/lo-builds/<ID>/`,
and bind-mounts that into the build container at `/lo`. No local LO
core build runs — the same artefact CI uses is reused.

`--local-lo` opts into the legacy path (bind-mounts
`$HOME/libreoffice-core-wasm` and rebuilds LO inside the container)
for inner-loop core-side debugging. Outputs from this mode MUST NOT
be deployed; the only deploy-eligible build is the published one
referenced by `wasm/LO_BUILD_ID`.

Don't push directly to `dev` on either repo — the auto-merge step is
the only sanctioned path.

## Test requirements for co-editing

Every co-editing test MUST verify:

1. **Content convergence** — after all edits + a sync period, all clients show identical document content (char count + full-text comparison).
2. **No checkpoint mismatches** — if any checkpoint is registered during the test, every active client's computed hash must match the relay's recorded hash.
3. **No OOB memory errors** — no `memory access out of bounds` crashes.
4. **Bidirectional sync** — changes from A appear on B AND changes from B appear on A.
5. **Structural changes** — insert/delete rows/columns, formatting commands propagate correctly.
6. **Independent cursors** — each user's cursor moves independently; remote actions don't hijack the local cursor.

## Known limitations

- **Warm-path snapshot + cold-reload** — on v2-via-viewer opens the iframe is spawned cold-reload style (`cool.html?WOPISrc=<fileId>`, no `#switchdoc=`). The snapshot restores Kit at the blank-loaded state and a post-restore `switchdocument` is needed to open the target. See `wasm-loader.js` for the current `snapshot:queuing_switchdoc_for_cold_reload` mechanism.
- **Kit-cooperation needed for "doc fully rendered" + "loading failed"** — today `WasmDocReady` fires from DOM polling (status bar + canvas heuristics). The right signal is a new `LOK_CALLBACK_DOCUMENT_PAINTED` from Kit; likewise for `load_error:`. Pending in LO Core C++. (A narrow, related signal already exists: the kit sets `window.__wasmSwitchDocLoaded` at `switchdocument`-complete, used to gate late-join replay — see the late-joiner flow above.)
- **Cold FIRST-load is slow (~25–45 s).** A fresh browser context (new user / first visit) has no Cache-Storage snapshot, so it pays full WASM cold-start (compile + `Desktop::Main` + prewarm) before the doc loads; warm restore is ~7–10 s. The fix is to ship a prebuilt snapshot as a static asset so fresh contexts restore instead of cold-initializing — tracked in `ai/tasks/todo/ship-prebuilt-snapshot-fast-first-load.md`.
- **Spell-correction / language change may not persist to the saved file.** Applying a spell-correction or character-language change via the context menu, then deselecting before save, can leave LO reporting the doc "unmodified" so `.uno:Save` re-serializes stale bytes. Live co-editing converges and the no-op-save invariant (above) keeps late-joiners consistent, but the file written to storage can be stale. The durable fix (persist on save) is tracked in `ai/tasks/todo/fix-spell-language-edits-not-persisted-on-save.md`.
- **messageLog cap** — 50,000 entries before silent truncation. With save-rotation pruning any session with at least one save stays well under the cap. Unsaved multi-hour sessions can lose early history; log compaction (merge redundant cursor-moves) is a follow-up.
- **Legacy `/api/files/*`** — still used for plaintext uploads by tests that bypass the viewer and for non-v2 files. V2 files (64-hex fileId) save through `WasmFileSave` postMessage → viewer-side encryption → `/api/v2/file/<fileId>`; the editor never sees the key. Legacy path is still exercised by `test-save-conflict.js` and `test-regression-viewer-cache.js`.
