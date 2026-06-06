// console-capture.js — Capture every browser console message + pageerror
// across all puppeteer Browsers/Pages a test creates, and write them to
// <shotsDir>/console.log on process exit. The HTML report (generate-
// report.js) renders the log inline so future failure triage no longer
// has to guess past the 80-char evidence truncation in checklist.json.
//
// Two integration modes:
//
//   1. Auto-install (preferred): require this file once before
//      `require('puppeteer')`, or rely on lib/inject-checklist.js which
//      already does it for you. Every Browser created via
//      puppeteer.launch() then automatically captures all pages +
//      popups + future targets.
//
//   2. Explicit: call attachToBrowser(browser) yourself if you don't
//      use the inject-checklist auto-install path.
//
// The captured file is plain text, one entry per line:
//   [t.t s] [type page#N] message
// type = log/info/warn/error/pageerror/requestfailed
// page#N = monotonic page index per Browser (page 0 = first about:blank).
//
// On test exit the file is written even if the test crashed — the
// process.on('exit') hook flushes the in-memory ring buffer to disk.
//
// To prevent unbounded memory growth on very long tests, the buffer is
// capped at MAX_LINES (default 50000); when full, earliest lines are
// dropped and a single "[truncated N lines]" marker is recorded.

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LINES = 50000;

class ConsoleCapture {
    constructor(shotsDir) {
        this.shotsDir = shotsDir;
        this.t0 = Date.now();
        this.lines = [];
        this.dropped = 0;
        this.pageIdx = new WeakMap();
        this.nextPageIdx = 0;
        this.flushed = false;
    }

    _record(type, pageLabel, text) {
        if (this.lines.length >= MAX_LINES) {
            this.dropped++;
            this.lines.shift();
        }
        const t = ((Date.now() - this.t0) / 1000).toFixed(3);
        this.lines.push(`[${t}s] [${type} ${pageLabel}] ${text}`);
    }

    _labelFor(page) {
        let idx = this.pageIdx.get(page);
        if (idx === undefined) {
            idx = this.nextPageIdx++;
            this.pageIdx.set(page, idx);
        }
        return 'page#' + idx;
    }

    attachToPage(page) {
        if (!page || typeof page.on !== 'function') return;
        const label = this._labelFor(page);

        page.on('console', m => {
            try {
                const type = m.type ? m.type() : 'log';
                const text = m.text ? m.text() : String(m);
                this._record(type, label, text);
            } catch (_) { /* swallow */ }
        });
        page.on('pageerror', e => {
            try {
                const msg = (e && e.stack) ? e.stack : (e && e.message) || String(e);
                this._record('pageerror', label, msg);
            } catch (_) { /* swallow */ }
        });
        page.on('requestfailed', req => {
            try {
                const url = req.url ? req.url() : '?';
                const err = req.failure ? (req.failure() || {}).errorText : '?';
                this._record('requestfailed', label, `${url} — ${err}`);
            } catch (_) { /* swallow */ }
        });
    }

    attachToBrowser(browser) {
        if (!browser || typeof browser.on !== 'function') return;
        // Attach to any already-open pages.
        if (typeof browser.pages === 'function') {
            browser.pages().then(ps => ps.forEach(p => this.attachToPage(p)))
                .catch(() => {});
        }
        // Attach to any future targets that resolve to a page.
        browser.on('targetcreated', async (target) => {
            try {
                const p = await target.page();
                if (p) this.attachToPage(p);
            } catch (_) { /* swallow */ }
        });
    }

    flush() {
        if (this.flushed) return;
        this.flushed = true;
        try {
            fs.mkdirSync(this.shotsDir, { recursive: true });
            const header = `# console-capture: ${this.lines.length} line(s)` +
                (this.dropped > 0 ? `, ${this.dropped} earlier line(s) dropped (exceeded MAX_LINES=${MAX_LINES})` : '') +
                `\n`;
            fs.writeFileSync(path.join(this.shotsDir, 'console.log'),
                header + this.lines.join('\n') + '\n');
        } catch (e) {
            console.error('console-capture flush failed:', e.message);
        }
    }
}

// Singleton — one capture per process, since the checklist library
// already imposes per-process scope and writes to a single shotsDir.
let _singleton = null;

function getSingleton(shotsDir) {
    if (!_singleton && shotsDir) _singleton = new ConsoleCapture(shotsDir);
    return _singleton;
}

// Monkey-patch puppeteer.launch — every browser created by the test
// gets attached automatically. Safe to call multiple times.
let _patched = false;
function autoAttach(shotsDir) {
    const cap = getSingleton(shotsDir);
    if (!cap) return null;
    if (_patched) return cap;
    _patched = true;
    try {
        // Lazy require so tests that don't use puppeteer don't pay the cost.
        const puppeteer = require('puppeteer');
        const origLaunch = puppeteer.launch.bind(puppeteer);
        puppeteer.launch = async function patchedLaunch(opts) {
            const browser = await origLaunch(opts);
            cap.attachToBrowser(browser);
            return browser;
        };
    } catch (_) {
        // puppeteer not installed at this path — give up silently; the
        // explicit attachToBrowser/attachToPage API still works.
    }
    return cap;
}

// Explicit API for tests that want to wire up manually.
function attachToBrowser(browser, shotsDir) {
    const cap = getSingleton(shotsDir);
    if (cap) cap.attachToBrowser(browser);
    return cap;
}
function attachToPage(page, shotsDir) {
    const cap = getSingleton(shotsDir);
    if (cap) cap.attachToPage(page);
    return cap;
}

// Flush on process exit (success or crash).
process.on('exit', () => { if (_singleton) _singleton.flush(); });
process.on('SIGINT',  () => { if (_singleton) _singleton.flush(); process.exit(130); });
process.on('SIGTERM', () => { if (_singleton) _singleton.flush(); process.exit(143); });

module.exports = { autoAttach, attachToBrowser, attachToPage, getSingleton };
