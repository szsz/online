# Plan: stop deploy scripts from rewriting build outputs

## Problem

Two deploy scripts (`wasm/deploy.sh` for the dev box, `wasm/deploy-azure.sh`
for prod and internal Azure) currently rewrite published build artefacts
during deploy:

- **Snapshot-restore inject** — Python heredoc that finds
  `if (shouldRunNow) callMain(args);` in `online.js` and injects a
  ~150-line block doing HEAPU8 copy + 6 `Module.ccall` warm-restore
  resets + VFS dir recreation + PThread instrumentation.

- **Cache-bust locateFile patch** — Python heredoc that injects a
  `locateFile` field into the Module object returned by
  `emscripten-module.js` so cache-bust-renamed `.wasm` files are
  fetched correctly.

- **Snapshot fingerprint substitution** — `sed -i` replacing
  `__WASM_BUILD_FINGERPRINT__` placeholders in `wasm-loader.js` /
  `sw.js` with `md5sum online.wasm`.

- **`global.js` branding strip** — `sed -i` removing
  `.insertAdjacentElement("afterend", brandingLink)` since we don't
  ship integrator themes.

- **Cache-bust filename rewrite** — `cache-bust-build.js` renames
  `online.js` → `online.<hash>.js` etc. and rewrites `cool.html`'s
  asset references.

- **Brotli sidecars** — `precompress-br.js` writes `<file>.br`
  alongside each big asset.

The first four of these are **content patches** — they change the bytes
of build outputs based on logic that has nothing to do with where we're
deploying. The last two are content-addressed transforms that should
also live in the build (now partially do — `build-wasm.sh` produces
`.br` sidecars for the heavy assets, deploys reuse them).

The result is the bug we just hit: the snapshot-restore inject lives in
two scripts (`deploy.sh` and `deploy-azure.sh`), they drifted, and
Azure has been silently missing the warm-restore resets for weeks.

## Goal

Deploy scripts do **only** orientation work:

- `cp` files into the staging dir
- write `.env`-style configuration values into config endpoints
- `az webapp deploy` / `rsync` the staged dir to the target
- run a smoke test

No `python3 -c`, no `sed -i` on JS/HTML, no `node tools/cache-bust-build.js`,
no `node tools/precompress-br.js`. Those run once at build time and
their outputs ride into every deploy unchanged.

## Proposed structure

### Build time (`wasm/build-wasm.sh` + `.github/scripts/wasm-ci/build-online.sh`)

After `emmake make` and before stopping the docker container, run a
single new step `wasm/tools/finalize-build.sh` which does, in order:

1. **Snapshot inject** — applies the snapshot-restore block to
   `online-build/wasm/online.js` and `online-build/browser/dist/online.js`.
   The inject text becomes a tracked source file:
   `wasm/snapshot-inject.js` (today it lives twice in `deploy.sh` and
   `deploy-azure.sh`). The finalize script reads it, splices it before
   `if (shouldRunNow) callMain(args);`, and writes back. Idempotent
   (skipped when `__wasmSnapshotData` already present).

2. **emscripten-module locateFile patch** — injects the
   `locateFile: function(file, prefix) { ... }` field into the Module
   object so cache-bust-renamed `.wasm` resolves through `__assetMap`.
   Also reads from a tracked source: `wasm/snapshot-inject-locate-file.js`.

3. **`global.js` branding strip** — applies the `.insertAdjacentElement`
   removal once. (This is config drift; the cleaner version is to fork
   `global.js` once with the line gone, but the current one-line
   `sed` is fine as a build step.)

4. **Fingerprint substitution** — `md5sum online.wasm | cut -c1-16`,
   replace `__WASM_BUILD_FINGERPRINT__` in `wasm-loader.js` and `sw.js`.

5. **Cache-bust** — `node tools/cache-bust-build.js --dir browser/dist`.
   This step runs LAST so subsequent steps (brotli) operate on the
   final filenames.

6. **Brotli sidecars** — `node tools/precompress-br.js` over the heavy
   assets (already happens here today). Includes the cache-busted
   files because they were renamed in step 5.

After this, `online-build/` is "complete" — a deploy is just `cp -a`
plus configuration.

### Deploy time

Each of `deploy.sh` and `deploy-azure.sh` becomes:

```
1. (optional) copy build tree into staging dir
2. write static config files (`.env` for local; az webapp config set
   for Azure)
3. ship staging dir to target (`rsync` / `az webapp deploy`)
4. SIGHUP local services / wait for App Service restart
5. smoke test
```

Both end up much shorter (~50 lines instead of ~400 / ~700).

### Migration sequencing

1. **Move the inject blocks to source files**:
   - `wasm/snapshot-inject.js` (the HEAPU8 copy + warm-restore resets)
   - `wasm/snapshot-inject-locate-file.js` (the locateFile patch)
   These are shipped with the repo, version-controlled. No more drift.

2. **Add `wasm/tools/finalize-build.sh`** that applies them post-`make`,
   plus the existing fingerprint/cache-bust/brotli steps. Make
   `build-wasm.sh` and `.github/scripts/wasm-ci/build-online.sh` call
   it as their last step.

3. **Test**: `bash build-wasm.sh && diff online-build/.../online.js
   <(deploy.sh-inject applied to old build's online.js)` — should
   match (modulo cache-bust hashes).

4. **Strip the deploy-time copies**: `deploy.sh` and `deploy-azure.sh`
   delete their python heredocs, fingerprint sed, branding sed, and
   `cache-bust-build.js` calls. Keep only file copy + config write
   + restart.

5. **Verify warm-restore on internal Azure** still works (this is
   the regression risk — if the build-time inject is missed somehow,
   warm hangs the same way today's bug did).

6. **Cleanup**: delete `--no-inject` and similar flags from deploy
   scripts since the inject is no longer a deploy-time concern.

### Dependencies / risk

- The CI build (`.github/scripts/wasm-ci/build-online.sh`) currently
  produces a half-finalized `online-build/` and the CI deploy step
  (`.github/scripts/wasm-ci/deploy.sh`) finishes the patches. After the
  refactor, CI's build step does everything; CI's deploy step becomes
  trivial.

- The `--commit <sha>` path in `deploy-internal.sh` rebuilds historical
  commits. Those commits would need their own build-time finalize step,
  which means the finalize script must be back-compat with the inject
  shape from older `wasm/snapshot-inject.js` versions. Concretely: the
  tracked inject file lives in the repo, so building an old commit
  picks up that commit's inject — no compat dance needed.

- **Risk**: drift between `snapshot-inject.js` and the C++ exports it
  ccalls (`wasm_warm_restore_*_reset`). The exports list in
  `.github/scripts/wasm-ci/build-online.sh` (lines 148-160) already
  enforces these — if the inject calls a function that isn't in the
  EXPORTED_FUNCTIONS list, runtime fails with an undefined symbol.
  That's the existing safety net.

## Estimate

- Move inject blocks to source files: ~30 min
- Write `finalize-build.sh`: ~1 h
- Wire into `build-wasm.sh` + `build-online.sh`: ~30 min
- Strip deploy-time logic from `deploy.sh` + `deploy-azure.sh` +
  `wasm-ci/deploy.sh`: ~1 h
- Verify all three deploy paths still work: ~1 h

Total: half a day, with a build cycle for verification.
