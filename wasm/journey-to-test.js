#!/usr/bin/env node
// journey-to-test.js — Phase 3 of the user-journey recorder.
//
// Reads a journey bundle (produced by viewer-public/lib/journey-recorder.js)
// and emits a runnable Puppeteer regression test that REPLAYS the journey as
// genuine user input through the real viewer UI, plus the fixture files it
// needs. The emitted test honors the repo's hard rule: every action is a
// real page.mouse / page.keyboard / page.click — no sendUnoCommand, no
// dispatcher, no state injection. Recorded timing deltas are NOT replayed as
// sleeps; sync is by condition-wait (doc-ready + canvas-paint-settle).
//
// Usage:
//   node wasm/journey-to-test.js <journey.json> [slug]
//
// Output:
//   wasm/tests/journeys/test-journey-<slug>.js
//   wasm/tests/journeys/<slug>/fixtures/<ref>.<ext>
//
// Then wire the test into run-all-tests.sh and fill in the VERIFY assertion
// at the bottom (the journey itself doesn't know the bug's expected outcome).

'use strict';
const fs = require('fs');
const path = require('path');

function die(m) { console.error('journey-to-test: ' + m); process.exit(1); }

const inFile = process.argv[2];
if (!inFile) die('usage: node journey-to-test.js <journey.json> [slug]');
let bundle;
try { bundle = JSON.parse(fs.readFileSync(inFile, 'utf8')); }
catch (e) { die('cannot read/parse ' + inFile + ': ' + e.message); }
if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.events))
    die('not a v1 journey bundle');

const slug = (process.argv[3] || path.basename(inFile).replace(/\.json$/, ''))
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'journey';

const OUT_DIR = path.join(__dirname, 'tests', 'journeys');
const FIX_DIR = path.join(OUT_DIR, slug, 'fixtures');
fs.mkdirSync(FIX_DIR, { recursive: true });

// Materialize fixtures (decode base64 → bytes on disk).
const extFor = f => {
    if (f.name && f.name.indexOf('.') >= 0) return f.name.slice(f.name.lastIndexOf('.'));
    return ({ writer: '.docx', calc: '.xlsx', impress: '.pptx' })[f.docType] || '.bin';
};
const fixMeta = {};
for (const f of (bundle.fixtures || [])) {
    const file = f.ref + extFor(f);
    fs.writeFileSync(path.join(FIX_DIR, file), Buffer.from(f.bytesB64 || '', 'base64'));
    fixMeta[f.ref] = { file, name: f.name || file, docType: f.docType || '' };
}

// JS string literal helper for embedding into the emitted source.
const S = v => JSON.stringify(v);

// Translate one journey event into emitted replay statements (array of lines).
function emitEvent(ev, idx) {
    const L = [];
    const tag = `e${idx}:${ev.type}${ev.frame ? '/' + ev.frame : ''}`;
    L.push(`    // [${tag}] t=${ev.t}ms`);
    switch (ev.type) {
        case 'upload':
        case 'open': {
            // First open is handled by SETUP; later opens are doc switches —
            // re-stage the (already-uploaded) fixture by navigating the hash.
            if (ev.fixtureRef && fixMeta[ev.fixtureRef]) {
                L.push(`    await openOrSwitch(${S(ev.fixtureRef)});`);
            }
            break;
        }
        case 'hashchange':
            L.push(`    await settle();`);
            break;
        case 'docReady':
            L.push(`    await waitDocReady();`);
            break;
        case 'pointerdown':
            if (ev.frame === 'editor') {
                L.push(`    { const pt = await canvasPoint(${ev.nx}, ${ev.ny});`);
                L.push(`      await page.mouse.move(pt.x, pt.y); await page.mouse.down({ button: ${S(btn(ev.button))} }); }`);
            } else if (ev.selector) {
                L.push(`    await clickSelector(${S(ev.selector)});`);
            }
            break;
        case 'pointerup':
            if (ev.frame === 'editor') {
                L.push(`    { const pt = await canvasPoint(${ev.nx}, ${ev.ny});`);
                L.push(`      await page.mouse.move(pt.x, pt.y); await page.mouse.up({ button: ${S(btn(ev.button))} }); await settle(); }`);
            }
            break;
        case 'keydown': {
            const mods = ['ctrl', 'shift', 'alt', 'meta'].filter(m => ev[m]);
            if (mods.length || isSpecialKey(ev.key)) {
                // Chord / non-printable: down modifiers → press key → up.
                for (const m of mods) L.push(`    await page.keyboard.down(${S(modKey(m))});`);
                L.push(`    await page.keyboard.press(${S(ev.key)});`);
                for (const m of mods.slice().reverse()) L.push(`    await page.keyboard.up(${S(modKey(m))});`);
            } else if (typeof ev.key === 'string' && ev.key.length === 1) {
                L.push(`    await page.keyboard.type(${S(ev.key)}, { delay: 25 });`);
            }
            break;
        }
        case 'wheel':
            L.push(`    await page.mouse.wheel({ deltaX: ${ev.dx || 0}, deltaY: ${ev.dy || 0} }); await settle();`);
            break;
        default:
            L.push(`    // (unhandled event type ${ev.type})`);
    }
    return L.join('\n');
}

const btn = b => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');
const modKey = m => ({ ctrl: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' }[m]);
function isSpecialKey(k) {
    return typeof k === 'string' && k.length > 1;   // 'Enter','Backspace','ArrowLeft',…
}

const firstFixtureRef = (() => {
    const ev = bundle.events.find(e => (e.type === 'open' || e.type === 'upload') && e.fixtureRef);
    return ev ? ev.fixtureRef : (bundle.fixtures[0] && bundle.fixtures[0].ref);
})();
if (!firstFixtureRef || !fixMeta[firstFixtureRef])
    die('journey has no openable fixture');

const vp = bundle.viewport || { width: 1280, height: 900 };

// Skip the SETUP open/upload events when emitting the replay loop (SETUP
// already opened the first fixture); switches to OTHER fixtures replay.
let setupConsumed = false;
const replayLines = bundle.events.map((ev, i) => {
    if (!setupConsumed && (ev.type === 'open' || ev.type === 'upload')
        && ev.fixtureRef === firstFixtureRef) { setupConsumed = true; return null; }
    return emitEvent(ev, i);
}).filter(x => x !== null).join('\n');

const fixtureEntries = Object.entries(fixMeta)
    .map(([ref, m]) => `    ${S(ref)}: { file: ${S(m.file)}, name: ${S(m.name)}, docType: ${S(m.docType)} },`)
    .join('\n');

const out = `// AUTO-GENERATED from a recorded user journey by wasm/journey-to-test.js.
// Source bundle: ${path.basename(inFile)} (recorded ${bundle.recordedAt || '?'}).
// Replays the journey as genuine user input through the real viewer UI.
// FILL IN the VERIFY assertion at the bottom with the bug's expected outcome.
//
// Real input only — no sendUnoCommand/dispatcher/state injection. Timing is
// condition-wait (doc-ready + canvas-paint-settle), never recorded sleeps.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const { openSecretInBrowser } = require('../../lib/open-via-viewer');
const { getActiveEditorFrame, waitForDocReady } = require('../../lib/two-tab');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(180000);
const FIX_DIR = path.join(__dirname, ${S(slug + '/fixtures')});
const VIEWPORT = { width: ${vp.width}, height: ${vp.height} };

const FIXTURES = {
${fixtureEntries}
};

const T0 = Date.now();
const log = m => console.log('[' + ((Date.now() - T0) / 1000).toFixed(1) + 's] ' + m);

(async () => {
    const { browser, cleanup } = await launch();
    let page, frame;
    const secrets = {};           // fixtureRef -> b64urlSecret (uploaded once)

    async function ensureUploaded(ref) {
        if (secrets[ref]) return secrets[ref];
        const m = FIXTURES[ref];
        const bytes = fs.readFileSync(path.join(FIX_DIR, m.file));
        const up = await uploadV2(VIEWER, m.name, bytes);
        secrets[ref] = up.b64urlSecret;
        return up.b64urlSecret;
    }
    async function waitDocReady() {
        frame = await getActiveEditorFrame(page) || frame;
        try { await waitForDocReady(page, { timeout: TIMEOUT }); } catch (e) {}
        frame = await getActiveEditorFrame(page) || frame;
    }
    // Canvas-paint-settle: poll a centre pixel-hash until stable — replaces
    // fixed sleeps as the inter-step sync (mirrors the hot-switch pattern).
    async function settle() {
        let last = null, stable = 0;
        for (let i = 0; i < 40; i++) {
            await sleep(250);
            frame = await getActiveEditorFrame(page) || frame;
            const h = await (frame ? frame.evaluate(() => {
                const c = document.querySelector('canvas');
                if (!c) return 'nc';
                try { const g = c.getContext('2d');
                    const d = g.getImageData(c.width / 2 - 30, c.height / 2 - 30, 60, 60).data;
                    let x = 0; for (let i = 0; i < d.length; i += 41) x = (x * 31 + d[i]) >>> 0;
                    return String(x); } catch (e) { return 'err'; }
            }).catch(() => 'ef') : 'nf');
            if (h === last) { if (++stable >= 2) return; } else { last = h; stable = 0; }
        }
    }
    async function canvasPoint(nx, ny) {
        // Recompute page coords from the live editor-frame box (the iframe
        // mounts fullscreen at (0,0); recorded coords were normalized).
        const box = await page.evaluate(() => {
            const el = document.getElementById('editor-frame');
            if (!el) return null; const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        const b = box || { x: 0, y: 0, w: VIEWPORT.width, h: VIEWPORT.height };
        return { x: Math.round(b.x + nx * b.w), y: Math.round(b.y + ny * b.h) };
    }
    async function clickSelector(sel) {
        try { await page.waitForSelector(sel, { visible: true, timeout: 10000 }); await page.click(sel); }
        catch (e) { log('selector click skipped (' + sel + '): ' + e.message); }
    }
    async function openOrSwitch(ref) {
        const secret = await ensureUploaded(ref);
        if (!page) {
            const r = await openSecretInBrowser(browser, VIEWER, secret,
                { viewport: VIEWPORT, iframeTimeout: TIMEOUT });
            page = r.page; frame = r.editorFrame;
        } else {
            await page.evaluate(s => { location.hash = '#file=' + s; }, secret);
        }
        await waitDocReady();
    }

    try {
        // ── SETUP: open the first fixture ──────────────────────────────
        await openOrSwitch(${S(firstFixtureRef)});
        await sleep(2500);   // relay-adapter activation gate before first input

        // ── REPLAY ─────────────────────────────────────────────────────
${replayLines}

        // ── VERIFY (fill this in) ──────────────────────────────────────
        // The journey doesn't know the bug's expected outcome. Replace this
        // with a real assertion (e.g. a char count, canvas hash, or a
        // visible element) describing what SHOULD be true at the end.
        frame = await getActiveEditorFrame(page) || frame;
        const alive = await page.evaluate(() => document.title !== '').catch(() => false);
        if (!alive) { log('✗ FAIL: page did not survive the journey'); process.exitCode = 1; }
        else log('✓ journey replayed; page alive (add a real VERIFY assertion)');
    } catch (err) {
        log('FAIL: ' + err.message); console.error(err); process.exitCode = 1;
    } finally {
        await cleanup();
    }
})();
`;

const outFile = path.join(OUT_DIR, 'test-journey-' + slug + '.js');
fs.writeFileSync(outFile, out);
console.log('Wrote ' + path.relative(process.cwd(), outFile));
console.log('Fixtures: ' + Object.keys(fixMeta).length + ' → ' + path.relative(process.cwd(), FIX_DIR));
console.log('Next: fill in the VERIFY assertion + add an entry to run-all-tests.sh');
