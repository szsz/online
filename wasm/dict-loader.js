// dict-loader.js — lazy-load hunspell dictionaries into the WASM LO VFS.
//
// Usage: loaded via <script> in cool.html alongside wasm-loader.js /
// relay-adapter.js. Runs before Emscripten's Module instantiates: hooks
// Module.preRun and adds a run-dependency that is only cleared once the
// primary dictionary has been written to the virtual filesystem. This way
// LibreOffice's startup scan of /instdir/share/extensions/ finds the dict
// on its first pass — no need to trigger a rescan.
//
// Dictionary source: dicts/manifest.json + dicts/<lang>.tar.br, produced
// by wasm/build-dicts.sh. The .tar.br contains the upstream LibreOffice
// dictionary files (.dic, .aff, dictionaries.xcu, description.xml, …)
// which we unpack directly into the VFS extension directory.
//
// Preload strategy:
//   - eager: map `navigator.language` to a manifest entry and preload it
//            before LO starts.
//   - reactive: expose window.loadDictionary(lang) so the viewer can
//            request additional languages on demand (e.g. from document
//            locale metadata) — those are written post-init and become
//            visible to LO after a linguistic-services refresh.
//
// Where to find bytes:
//   - /dicts/manifest.json and /dicts/<lang>.tar.br on whichever origin
//     is serving cool.html. For the Azure editor these are on
//     szebeni-wasm-static; for local they're under editor-static-server's
//     PUB directory.

(function() {
    'use strict';

    // ── URL resolution ────────────────────────────────────────────
    // Dictionary blobs live at `<deploy-root>/dicts/`. The deploy
    // root depends on what served cool.html. Three shapes seen in
    // practice:
    //   /<id>/browser/dist/dict-loader.js  ← Front Door static site
    //                                        (literal webpack output
    //                                        path; manifest at
    //                                        /<id>/dicts/manifest.json)
    //   /<id>/browser/dict-loader.js       ← old editor-server layout
    //                                        (routed via express.static)
    //   /dict-loader.js                    ← flat dev layout
    //
    // The transform: strip `/browser/[dist/]<script>` off the URL,
    // then append `/dicts`. We use the script's own URL as the
    // anchor since it's the most reliable thing to navigate from.
    var scriptEl = document.currentScript;
    var DICTS_BASE = (function() {
        if (scriptEl && scriptEl.src) {
            var u = new URL(scriptEl.src);
            // Trim `/browser/(dist/)?<filename>` (covers FD literal +
            // legacy App-Service-routed layouts) OR a bare
            // `/<filename>` (flat layout).
            u.pathname = u.pathname.replace(/\/browser\/(?:dist\/)?[^/]+$/, '');
            u.pathname = u.pathname.replace(/\/dict-loader(\.[0-9a-f]+)?\.js$/, '');
            // Drop trailing slash so the join below doesn't double up.
            u.pathname = u.pathname.replace(/\/$/, '');
            if (!/\/dicts$/.test(u.pathname)) u.pathname += '/dicts';
            u.search = ''; u.hash = '';
            return u.toString();
        }
        return '/dicts';
    })();

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[dict-loader]');
        console.log.apply(console, args);
    }
    function warn() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[dict-loader]');
        console.warn.apply(console, args);
    }

    // ── Locale → dictionary choice ────────────────────────────────
    // The manifest lists top-level LO dict groups ("en", "de", …). Pick
    // the one matching the primary 2-letter language of navigator.language.
    // Users can override via URL param `dict=<lang>` (lowercase).
    function pickLang(manifest) {
        var override = new URLSearchParams(window.location.search).get('dict');
        if (override && manifest.some(function(e) { return e.lang === override; })) {
            return override;
        }
        var nav = (navigator.language || 'en-US').toLowerCase();
        var primary = nav.split('-')[0]; // "en-us" → "en"
        // First exact match, then prefix match.
        var exact = manifest.filter(function(e) { return e.lang === primary; });
        if (exact.length) return exact[0].lang;
        var prefix = manifest.filter(function(e) { return e.lang.indexOf(primary) === 0; });
        if (prefix.length) return prefix[0].lang;
        // Fall back to the first entry (typically "en") so LO always has
        // *something* to spellcheck with.
        return manifest[0] && manifest[0].lang;
    }

    // ── Minimal tar parser ────────────────────────────────────────
    // POSIX tar is a fixed-512-byte-header-per-entry format with data
    // padded to the next 512 boundary. We don't need extended features.
    function parseTar(buf) {
        var u8 = new Uint8Array(buf);
        var entries = [];
        var decoder = new TextDecoder('utf-8');
        var off = 0;
        while (off + 512 <= u8.length) {
            // Empty 512-byte block signals end-of-archive.
            var allZero = true;
            for (var i = 0; i < 512; i++) {
                if (u8[off + i] !== 0) { allZero = false; break; }
            }
            if (allZero) break;

            var name = decoder.decode(u8.subarray(off, off + 100)).replace(/\0.*$/, '');
            // Octal size in bytes 124..135.
            var sizeOct = decoder.decode(u8.subarray(off + 124, off + 136)).replace(/\0.*$/, '').trim();
            var size = parseInt(sizeOct, 8) || 0;
            var typeflag = String.fromCharCode(u8[off + 156] || 0x30); // '0' = file
            // GNU tar uses 'prefix' at offset 345..500 when names exceed 100.
            var prefix = decoder.decode(u8.subarray(off + 345, off + 500)).replace(/\0.*$/, '');
            if (prefix) name = prefix + '/' + name;

            var data = u8.subarray(off + 512, off + 512 + size);
            off += 512 + Math.ceil(size / 512) * 512;

            if (typeflag === '5') continue; // directory entry — skip
            if (!name || name === './' || name === '.') continue;
            // Strip leading "./" the BSD tar sometimes emits.
            name = name.replace(/^\.\/+/, '');
            if (!name) continue;
            entries.push({ name: name, data: data });
        }
        return entries;
    }

    // ── Browser-native gzip decompression ─────────────────────────
    // Bundles ship as .tar.gz. DecompressionStream('gzip') is universal
    // (Chrome 80+, Firefox 113+, Safari 16.4+, Node 18+). We tried brotli
    // first but `DecompressionStream('br')` is still behind a flag in
    // some Chromium builds we target — gzip is reliable.
    function gzipDecompress(response) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('DecompressionStream unavailable');
        }
        var stream = response.body.pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).arrayBuffer();
    }

    // ── Write unpacked files to Module.FS ─────────────────────────
    // Writes only the spell/hyphen/thesaurus data files into the flat
    // /instdir/share/dict/ directory that LO's lingucomponent scans at
    // startup (see lingucomponent/source/lingutil/lingutil.cxx, the
    // EMSCRIPTEN branch of GetOldStyleDics). Filename conventions the
    // scanner expects:
    //    <locale>.dic        — spell (hunspell)
    //    <locale>.aff        — spell (hunspell affix file)
    //    hyph_<locale>.dic   — hyphenation
    //    th_<locale>_v2.dat  — thesaurus
    //    th_<locale>_v2.idx  — thesaurus index
    // Everything else in the tar (dictionaries.xcu, META-INF/, README)
    // is unused for the legacy DICPATH path and gets skipped.
    function writeExtension(Module, lang, entries) {
        var FS = Module.FS;
        if (!FS) throw new Error('Module.FS not available');
        var base = '/instdir/share/dict';
        var mkdirs = {};
        function ensureDir(p) {
            if (mkdirs[p]) return;
            mkdirs[p] = true;
            try { FS.mkdir(p); } catch (e) { /* exists, fine */ }
        }
        function ensureParents(full) {
            var parts = full.split('/').filter(Boolean);
            var cur = '';
            for (var i = 0; i < parts.length - 1; i++) {
                cur += '/' + parts[i];
                ensureDir(cur);
            }
        }
        ensureParents(base + '/x');
        // Pattern: keep only data files for the lingu directory scan.
        // (Spell .dic / .aff; hyphenation hyph_*.dic; thesaurus
        //  th_*_v2.dat / th_*_v2.idx.)
        var DATA_RE = /(?:^|\/)([^\/]+\.(?:dic|aff|dat|idx))$/i;
        // Normalise a spell-dictionary file name so LO's GetOldStyleDics derives
        // the locale the document actually uses. The scanner takes the file stem
        // (minus a hyph_/th_ prefix) as a BCP47 tag. Some upstream dicts carry a
        // project suffix — German is `de_DE_frami.dic` → stem "de_DE_frami" →
        // parses to the BCP47 *variant* tag "de-DE-frami" (stored by LO as the
        // opaque qlt locale), which no `de-DE` document ever matches. Strip such
        // a trailing `_<variant>` from <lang>_<REGION>_<variant> spell files so
        // the stem is a plain `<lang>_<REGION>`. Hyphenation/thesaurus names
        // (hyph_*, th_*) and already-plain names (en_US, fr) are left untouched.
        function normalizeLeaf(leaf) {
            if (/^(?:hyph_|th_)/i.test(leaf)) return leaf;
            // <lang>_<REGION>_<variant>.<dic|aff>  ->  <lang>_<REGION>.<ext>
            return leaf.replace(
                /^([a-z]{2,3})_([A-Za-z]{2,4})_[A-Za-z0-9]+(\.(?:dic|aff))$/,
                '$1_$2$3');
        }
        var written = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var m = DATA_RE.exec(e.name);
            if (!m) continue;
            var leaf = normalizeLeaf(m[1]);
            var full = base + '/' + leaf;
            ensureParents(full);
            try {
                FS.writeFile(full, e.data, { canOwn: false });
                written++;
            } catch (err) {
                warn('writeFile failed', full, err);
            }
        }
        log('wrote', written, '/', entries.length, 'data files to', base);
    }

    // ── Main entry: preRun-blocking primary preload ───────────────
    var state = {
        manifest: null,
        primaryLang: null,
        primaryWritten: false,
        // Tracks every language whose tar has been fetched + unpacked
        // into Module.FS, primary or reactive. loadDictionary() reads
        // this to skip a redundant fetch when a viewer or kit-side
        // event-driven path requests the same lang twice (mixed-
        // language docs trigger a load per paragraph locale; without
        // dedup we'd re-fetch the same ~2-5 MB bundle on every
        // language-tag swap).
        loaded: Object.create(null),
    };

    // Hook strategy: poll until `globalThis.Module.addRunDependency` is
    // callable, then install a run-dependency + kick off the fetch. The
    // property-setter trap tried earlier got clobbered by later scripts
    // reassigning `globalThis.Module` as a plain data property (emscripten
    // and bundle.js both do this). Run dependencies are Emscripten's own
    // gating mechanism: as long as we add ours before the runtime calls
    // `run()`, it'll wait for us — we don't need preRun at all.
    var dictHookInstalled = false;
    function tryInstallHook() {
        if (dictHookInstalled) return;
        var Module = globalThis.Module;
        if (!Module || typeof Module.addRunDependency !== 'function') {
            setTimeout(tryInstallHook, 30);
            return;
        }
        // Don't block the pthread helper workers — they share FS with the
        // main thread, and only the main thread opens docs.
        if (typeof Module.ENVIRONMENT_IS_PTHREAD !== 'undefined' && Module.ENVIRONMENT_IS_PTHREAD) return;
        dictHookInstalled = true;
        log('installing run-dependency (Module ready)');
        Module.addRunDependency('dict-preload');
        var done = function() {
            try { Module.removeRunDependency('dict-preload'); } catch (e) {}
        };
        var t0 = performance.now();
        fetch(DICTS_BASE + '/manifest.json', { credentials: 'omit' })
            .then(function(r) {
                if (!r.ok) throw new Error('manifest HTTP ' + r.status);
                return r.json();
            })
            .then(function(manifest) {
                state.manifest = manifest;
                var lang = pickLang(manifest);
                if (!lang) {
                    warn('no dictionary matched navigator.language — skipping preload');
                    return done();
                }
                state.primaryLang = lang;
                log('preloading', lang, 'for navigator.language=' + navigator.language);
                return fetchAndInstall(lang).then(function() {
                    state.primaryWritten = true;
                    state.loaded[lang] = true;
                    log('primary ready in', (performance.now() - t0).toFixed(0) + 'ms');
                }).then(done);
            })
            .catch(function(e) {
                warn('preload failed — editor will start without spellcheck:', e.message || e);
                done();
            });
    }
    // Start polling immediately; the module loads within a few frames.
    tryInstallHook();

    function fetchAndInstall(lang) {
        var entry = (state.manifest || []).find(function(e) { return e.lang === lang; });
        if (!entry) return Promise.reject(new Error('no manifest entry for ' + lang));
        var url = DICTS_BASE + '/' + entry.file;
        return fetch(url, { credentials: 'omit' }).then(function(r) {
            if (!r.ok) throw new Error(entry.file + ' HTTP ' + r.status);
            return gzipDecompress(r);
        }).then(function(tarBuf) {
            var entries = parseTar(tarBuf);
            if (!entries.length) throw new Error(entry.file + ' unpacked to 0 entries');
            writeExtension(Module, lang, entries);
        });
    }

    // ── Reactive loader (post-init) ───────────────────────────────
    // Usable from the viewer (e.g. when it detects a document locale).
    // After LO is already running, we write into FS normally; LO reads
    // from there on its next spellcheck attempt for that locale.
    globalThis.loadDictionary = function(lang) {
        if (!state.manifest) {
            return Promise.reject(new Error('manifest not loaded yet'));
        }
        // Idempotent: any language we've already written to FS short-
        // circuits to a resolved cached promise. Tracked via
        // state.loaded (populated by both the primary preload and
        // reactive loads below). Without this check, a viewer or
        // kit-side event handler that fires loadDictionary() on every
        // paragraph-language event would re-fetch the same 2-5 MB
        // bundle each time.
        if (state.loaded[lang]) {
            return Promise.resolve({ lang: lang, cached: true });
        }
        return fetchAndInstall(lang).then(function() {
            state.loaded[lang] = true;
            return { lang: lang };
        });
    };

    // ── BCP 47 locale → manifest-lang resolver ──────────────────
    // Callable from anywhere in the editor (StatusBar's
    // LanguageStatus handler, kit-side language-tag events, the
    // viewer-side document-language probe). Maps a runtime locale
    // tag like "fr-FR" / "de-DE" / "pt-BR" / "zh-Hans-CN" to whatever
    // the manifest actually ships, then dispatches via the
    // idempotent loadDictionary above. Returns a resolved promise
    // (with { skipped: 'no-manifest-match' }) when the locale has
    // no shipping dict — so callers can `.catch(()=>{})` blindly.
    //
    // Resolution order (mirrors pickLang's primary-preload logic):
    //   1. Exact lowercase match against manifest.lang
    //      ("fr_fr" → "fr_FR" if shipped — note manifest already
    //      lowercases its `lang` keys at build time).
    //   2. Primary subtag exact match (drop region):
    //      "en-us" → primary "en" → exact "en" in manifest.
    //   3. Primary subtag prefix match:
    //      "fr-CA" → primary "fr" → manifest "fr_FR" via
    //      indexOf(primary + '_') === 0.
    //   4. None of the above → resolve { skipped }.
    globalThis.loadDictionaryForLocale = function(bcp47) {
        if (!state.manifest) {
            return Promise.reject(new Error('manifest not loaded yet'));
        }
        var lc = String(bcp47 || '').toLowerCase().replace(/_/g, '-');
        if (!lc) return Promise.resolve({ lang: '', skipped: 'empty-locale' });
        var exact = state.manifest.find(function(e) { return e.lang.toLowerCase() === lc; });
        if (exact) return globalThis.loadDictionary(exact.lang);
        var primary = lc.split('-')[0];
        var primaryExact = state.manifest.find(function(e) { return e.lang.toLowerCase() === primary; });
        if (primaryExact) return globalThis.loadDictionary(primaryExact.lang);
        var prefix = state.manifest.find(function(e) {
            var ml = e.lang.toLowerCase();
            return ml.indexOf(primary + '_') === 0 || ml.indexOf(primary + '-') === 0;
        });
        if (prefix) return globalThis.loadDictionary(prefix.lang);
        return Promise.resolve({ lang: bcp47, skipped: 'no-manifest-match' });
    };

    // Debug surface.
    globalThis.__dictLoader = state;
})();
