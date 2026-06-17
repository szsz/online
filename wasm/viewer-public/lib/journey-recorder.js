// journey-recorder.js — Phase 1 of the user-journey recorder.
//
// Records a complete viewer session — uploaded files (plaintext bytes),
// every chrome click/keypress/scroll, every in-canvas click/key forwarded
// from the editor iframe, and doc open/ready transitions — into a single
// self-contained journey JSON that the user downloads. Phases 2 (HTML
// review timeline) and 3 (codegen to a replayable Puppeteer test) consume
// that JSON.
//
// GATED on the `?record` URL param. When absent, this exposes an inert
// no-op stub so the viewer can call JourneyRecorder.note*() unconditionally
// without overhead or errors.
//
// Capture surfaces (see ai/proposals/promoted/user-journey-recorder.md):
//   - TOP WINDOW (this file): chrome clicks/keys/scroll on the viewer doc,
//     plus upload/open/doc-ready/hashchange notes pushed by index.html.
//   - EDITOR IFRAME (wasm-loader.js, also ?record-gated): in-canvas
//     pointer/key/scroll events posted to the parent as `JourneyInput`;
//     index.html's message listener forwards them to noteIframeInput().
//
// Fixtures hold PLAINTEXT bytes (the recorder's own browser already
// decrypted them); replay re-encrypts via uploadV2 with a fresh secret —
// session-specific secrets/fileIds are deliberately NOT stored.

(function () {
    'use strict';

    var RECORD = false;
    try { RECORD = new URLSearchParams(window.location.search).has('record'); }
    catch (e) { RECORD = false; }

    // Inert stub when not recording — every method is a no-op.
    if (!RECORD) {
        window.JourneyRecorder = {
            active: false,
            noteUpload: function () {}, noteOpen: function () {},
            noteDocReady: function () {}, noteHashChange: function () {},
            noteIframeInput: function () {}, start: function () {}, stop: function () {},
        };
        return;
    }

    // ── base64 of a Uint8Array (chunked — avoids call-stack overflow on
    // multi-MB fixtures) ────────────────────────────────────────────────
    function bytesToBase64(u8) {
        var CH = 0x8000, parts = [];
        for (var i = 0; i < u8.length; i += CH) {
            parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CH)));
        }
        return btoa(parts.join(''));
    }

    function sha256Hex(u8) {
        if (!(window.crypto && crypto.subtle)) return Promise.resolve('');
        // Pass a fresh ArrayBuffer slice (subtle.digest wants a buffer).
        var buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        return crypto.subtle.digest('SHA-256', buf).then(function (d) {
            var b = new Uint8Array(d), h = '';
            for (var i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
            return h;
        }).catch(function () { return ''; });
    }

    // Build a reasonably-stable CSS selector for a chrome element so replay
    // can target it with page.click(selector). Prefers #id; else walks up
    // building tag + :nth-of-type, stopping at the nearest id or <body>.
    function cssPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return '#' + CSS.escape(el.id);
        var parts = [];
        for (var node = el; node && node.nodeType === 1 && node !== document.body;
             node = node.parentElement) {
            if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
            var tag = node.tagName.toLowerCase();
            var p = node.parentElement;
            if (p) {
                var same = Array.prototype.filter.call(p.children, function (c) {
                    return c.tagName === node.tagName;
                });
                if (same.length > 1) tag += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
            }
            parts.unshift(tag);
        }
        return parts.join(' > ');
    }

    var R = {
        active: false,
        _t0: 0,
        _events: [],
        _fixtures: [],          // { ref, name, docType, bytes:Uint8Array, size }
        _fixByKey: {},          // name+'\x00'+size -> ref
        _fixSeq: 0,

        _now: function () { return Date.now() - this._t0; },

        _ensureFixture: function (name, docType, bytes) {
            var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            var key = (name || 'file') + '\x00' + u8.length;
            if (this._fixByKey[key]) return this._fixByKey[key];
            var ref = 'f' + (++this._fixSeq);
            this._fixtures.push({ ref: ref, name: name || ('file' + this._fixSeq),
                docType: docType || '', bytes: u8, size: u8.length });
            this._fixByKey[key] = ref;
            return ref;
        },

        _push: function (ev) {
            if (!this.active) return;
            ev.t = this._now();
            this._events.push(ev);
            this._renderControl();
        },

        // ── notes called by index.html ────────────────────────────────
        noteUpload: function (name, docType, bytes) {
            if (!this.active) return;
            this._push({ type: 'upload', fixtureRef: this._ensureFixture(name, docType, bytes) });
        },
        noteOpen: function (name, docType, bytes) {
            if (!this.active) return;
            var ref = (bytes != null) ? this._ensureFixture(name, docType, bytes) : null;
            this._push({ type: 'open', fixtureRef: ref, name: name || null, docType: docType || null });
        },
        noteDocReady: function (name) {
            if (!this.active) return;
            this._push({ type: 'docReady', name: name || null });
        },
        noteHashChange: function () {
            if (!this.active) return;
            this._push({ type: 'hashchange' });
        },

        // ── forwarded in-canvas events from wasm-loader.js ─────────────
        noteIframeInput: function (v) {
            if (!this.active || !v || !v.type) return;
            if (v.type === 'pointerdown' || v.type === 'pointerup') {
                var ifW = v.ifW || 1, ifH = v.ifH || 1;
                this._push({ type: v.type, frame: 'editor', target: 'canvas',
                    nx: +(v.x / ifW).toFixed(5), ny: +(v.y / ifH).toFixed(5),
                    absX: v.x, absY: v.y, ifW: ifW, ifH: ifH, button: v.button || 0 });
            } else if (v.type === 'keydown') {
                this._push({ type: 'keydown', frame: 'editor', key: v.key, code: v.code,
                    ctrl: !!v.ctrl, shift: !!v.shift, alt: !!v.alt, meta: !!v.meta });
            } else if (v.type === 'wheel') {
                this._push({ type: 'wheel', frame: 'editor', dx: v.dx || 0, dy: v.dy || 0 });
            }
        },

        // ── top-window chrome listeners ────────────────────────────────
        _installListeners: function () {
            var self = this;
            // Pointer events on the editor iframe don't bubble to the parent
            // (separate browsing context), so these only see viewer chrome.
            ['pointerdown', 'pointerup'].forEach(function (type) {
                document.addEventListener(type, function (e) {
                    if (!self.active) return;
                    self._push({ type: type, frame: 'top', target: 'selector',
                        selector: cssPath(e.target), absX: e.clientX, absY: e.clientY,
                        button: e.button || 0 });
                }, true);
            });
            document.addEventListener('keydown', function (e) {
                if (!self.active) return;
                self._push({ type: 'keydown', frame: 'top', key: e.key, code: e.code,
                    ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
            }, true);
            window.addEventListener('wheel', function (e) {
                if (!self.active) return;
                self._push({ type: 'wheel', frame: 'top', dx: e.deltaX, dy: e.deltaY });
            }, { capture: true, passive: true });
        },

        // ── floating control ───────────────────────────────────────────
        _ctrlEl: null,
        _installControl: function () {
            var el = document.createElement('div');
            el.id = 'journey-recorder-control';
            el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;' +
                'background:#111;color:#fff;padding:8px 10px;border-radius:8px;' +
                'font:12px -apple-system,Segoe UI,Arial,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4);';
            el.innerHTML =
                '<div id="jr-status" style="margin-bottom:6px;">⏺ <b>Recording</b> · ' +
                '<span id="jr-count">0</span> events</div>' +
                '<button id="jr-stop" style="font-size:12px;padding:3px 8px;cursor:pointer;">' +
                'Stop &amp; Download</button>';
            document.body.appendChild(el);
            this._ctrlEl = el;
            var self = this;
            el.querySelector('#jr-stop').addEventListener('click', function () { self.stop(); });
        },
        _renderControl: function () {
            if (!this._ctrlEl) return;
            var c = this._ctrlEl.querySelector('#jr-count');
            if (c) c.textContent = String(this._events.length);
        },

        // ── lifecycle ──────────────────────────────────────────────────
        start: function () {
            if (this.active) return;
            this.active = true;
            this._t0 = Date.now();
            console.log('[journey] recording started');
        },

        stop: function () {
            if (!this.active) return;
            this.active = false;
            var self = this;
            var status = this._ctrlEl && this._ctrlEl.querySelector('#jr-status');
            if (status) status.innerHTML = '⏳ Building bundle…';

            // Compute sha256 for each fixture, then assemble + download.
            Promise.all(this._fixtures.map(function (f) {
                return sha256Hex(f.bytes).then(function (h) { return { f: f, sha: h }; });
            })).then(function (rows) {
                var fixtures = rows.map(function (r) {
                    return { ref: r.f.ref, name: r.f.name, docType: r.f.docType,
                        sha256: r.sha, size: r.f.size, bytesB64: bytesToBase64(r.f.bytes) };
                });
                var bundle = {
                    version: 1,
                    recordedAt: new Date().toISOString(),
                    viewerUrl: window.location.origin,
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    userAgent: navigator.userAgent,
                    fixtures: fixtures,
                    events: self._events,
                };
                var json = JSON.stringify(bundle, null, 2);
                var blob = new Blob([json], { type: 'application/json' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                var stamp = bundle.recordedAt.replace(/[:.]/g, '-');
                a.href = url; a.download = 'journey-' + stamp + '.json';
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
                if (status) status.innerHTML = '✓ Downloaded · ' + self._events.length +
                    ' events, ' + fixtures.length + ' file(s)';
                console.log('[journey] downloaded ' + a.download + ' (' +
                    self._events.length + ' events, ' + fixtures.length + ' fixtures)');
            });
        },
    };

    window.JourneyRecorder = R;

    // Auto-start on load so the very first upload/open is captured. The user
    // navigates to the state they want, then clicks "Stop & Download".
    function boot() {
        R._installListeners();
        R._installControl();
        R.start();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
