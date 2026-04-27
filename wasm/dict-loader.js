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
    // cool.html can be loaded from /browser/cool.html or directly, so
    // resolve relative to this script's source URL.
    var scriptEl = document.currentScript;
    var DICTS_BASE = (function() {
        // Try relative to this script.
        if (scriptEl && scriptEl.src) {
            var u = new URL(scriptEl.src);
            // If script is at /browser/<hash>/dict-loader.js — go up two
            // levels to find /dicts at the app root. We also accept
            // /browser/dict-loader.js and plain /dict-loader.js.
            u.pathname = u.pathname.replace(/\/browser\/[^/]+$/, '/dicts');
            u.pathname = u.pathname.replace(/\/dict-loader(\.[0-9a-f]+)?\.js$/, '');
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
    // The canonical location for a bundled-with-LO dictionary extension
    // is /instdir/share/extensions/dict-<lang>/. The build's tar is
    // rooted at "./" so entries look like "en_US.dic", "dictionaries.xcu",
    // "META-INF/manifest.xml" etc. — we prepend the extension dir.
    function writeExtension(Module, lang, entries) {
        var FS = Module.FS;
        if (!FS) throw new Error('Module.FS not available');
        var base = '/instdir/share/extensions/dict-' + lang;
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
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var full = base + '/' + e.name.replace(/^\/+/, '');
            ensureParents(full);
            try {
                FS.writeFile(full, e.data, { canOwn: false });
            } catch (err) {
                warn('writeFile failed', full, err);
            }
        }
        log('wrote', entries.length, 'files to', base);
    }

    // ── Main entry: preRun-blocking primary preload ───────────────
    var state = {
        manifest: null,
        primaryLang: null,
        primaryWritten: false,
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
        if (lang === state.primaryLang && state.primaryWritten) {
            return Promise.resolve({ lang: lang, cached: true });
        }
        return fetchAndInstall(lang).then(function() {
            return { lang: lang };
        });
    };

    // Debug surface.
    globalThis.__dictLoader = state;
})();
