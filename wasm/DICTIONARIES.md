# Spellcheck dictionaries in the WASM editor

How hunspell spell-check dictionaries are built, shipped, loaded, and made
visible to LibreOffice in the browser-only (WASM) editor — and how to add more.

## TL;DR

- Dictionaries are **not** compiled into `online.wasm`. They are fetched at
  runtime from `/dicts/` as per-language gzipped tarballs.
- Loading is **lazy / two-tier**: one *primary* dictionary is preloaded at
  start-up (the user's `navigator.language`); every other language is fetched
  *reactively* the first time the cursor enters a paragraph in that language.
- `DEFAULT_LANGS` in [`build-dicts.sh`](./build-dicts.sh) is **all** spell
  dictionaries `LibreOffice/dictionaries` ships, so any document language can
  be loaded on demand. Shipping more is cheap — the client only ever fetches
  what a document actually uses.
- **To add/refresh languages:** edit `DEFAULT_LANGS`, run
  `bash wasm/build-dicts.sh`, deploy. No LibreOffice (LO-core) build needed.

## Pipeline (end to end)

1. **Build** — [`build-dicts.sh`](./build-dicts.sh) pulls each language from
   upstream `github.com/LibreOffice/dictionaries` and emits, under
   `wasm/online-build/dicts/`:
   - `<lang>.tar.gz` — gzip tar of just the data files (`.dic`/`.aff`, plus
     `hyph_*`/`th_*` where present). Non-hunspell or dict-less dirs are skipped.
   - `manifest.json` — index of `{ lang, file, size, sha256, locales }`.
2. **Serve** — `/dicts/` ships as static viewer assets (also mirrored to
   `coolwasmfiles` storage). They are plain static files, not an App-Service
   payload.
3. **Client** — [`dict-loader.js`](./dict-loader.js):
   - **Primary (eager):** during the editor's `preRun` it holds an
     `addRunDependency('dict-preload')`, maps `navigator.language` to a manifest
     entry, fetches that bundle, un-tars it in JS, and `FS.writeFile`s the files
     into `/instdir/share/dict` **before** LO's first dictionary scan — so the
     user's own language is spell-checkable from the first keystroke.
   - **Reactive (lazy):** exposes `window.loadDictionaryForLocale(bcp47)`. The
     status-bar `.uno:LanguageStatus` handler
     ([`Control.StatusBar.js`](../browser/src/control/Control.StatusBar.js))
     calls it whenever the cursor enters a paragraph in a new language, fetching
     that bundle on demand (idempotent — cached in `state.loaded`).
   - **Filename normalization:** the scanner derives a dictionary's locale from
     its file *stem*. Some upstream dicts carry a project suffix
     (`de_DE_frami.dic` → would parse as the BCP-47 variant `de-DE-frami`, which
     no `de-DE` document matches). `dict-loader.js` strips such a suffix on
     write so files land as plain `<lang>_<REGION>.dic`.
4. **LibreOffice** — `lingucomponent` scans `/instdir/share/dict`
   (`GetOldStyleDics`, lingutil.cxx) and registers the locales; hunspell does
   the checking.

## Runtime registration in WASM (why this is more than "drop a file")

LO's linguistic framework discovers spell services and their locales **once at
start-up**. Lazy-loaded dictionaries arrive *after* that, so several layers had
to learn to pick them up at runtime (all gated to `EMSCRIPTEN`/LibreOfficeKit):

- **`GetOldStyleDics`** scans `$BRAND_BASE_DIR/share/dict` (EMSCRIPTEN ordered
  before `SYSTEM_DICTS`), where the dict-loader writes.
- **`SpellChecker::hasLocale`** (sspellimp.cxx) re-scans that directory when its
  file count changes (guarded so genuinely-unsupported languages don't re-scan
  every word), and matches a document locale to any installed dictionary of the
  same **language** (so `fr` serves `fr-FR`, `de-DE` serves a `de-DE` doc, etc.).
- **`SpellCheckerDispatcher::hasLocale`** (spelldsp.cxx) — the framework's
  language→service cache — probes the loaded spell service on a cache miss and
  registers the locale if the service now supports it.
- **Re-spell trigger** — when a runtime re-scan first registers a language the
  spell service fires `SPELL_WRONG_WORDS_AGAIN`, so text scanned as "correct"
  before its dictionary loaded gets re-checked (squiggles appear).
- **Right-click** — `SwView::ExecSpellPopup` force-re-checks the clicked
  paragraph under LOK (even if not dirty), so suggestions appear immediately on
  a word whose dictionary loaded after the initial scan.
- The Writer spell context menu is emitted as JSON directly under LOK
  (`ExecSpellPopup`), mirroring `EditView::LOKSendSpellPopupMenu`, because the
  classic `SwSpellPopup` (a VclBuilder menu) can't be constructed headless.

Net effect: right-click a misspelled word in **any** loaded language → real
hunspell suggestions → picking one replaces the word.

## Adding or changing languages

1. Edit `DEFAULT_LANGS` in [`build-dicts.sh`](./build-dicts.sh). Use the
   upstream directory names — `bash wasm/build-dicts.sh --list` prints them all.
2. `bash wasm/build-dicts.sh` (optionally `bash wasm/build-dicts.sh en de fr`
   for a subset). It fetches, packages, and rewrites `manifest.json`; dirs with
   no hunspell `.dic`/`.aff` are skipped automatically.
3. Deploy so the new `/dicts/` is live. **No LO-core build is required** — it is
   pure data plus the (already shipped) runtime-registration logic.
4. `test-regression-dict-manifest-coverage.js` asserts the required minimum set
   is present and the total stays under the runaway-build cap.

### Caveats

- The language must exist in `LibreOffice/dictionaries`.
- Only the *primary* (eager) bundle affects cold-start latency — pick the user's
  `navigator.language`. Reactive loads don't touch start-up. (German ≈ 4.5 MB,
  Spanish ≈ 5.5 MB.)
- CJK / complex-script languages need more than a hunspell dictionary (input
  methods, word-breaking); a `.dic` alone is not a drop-in for those.
