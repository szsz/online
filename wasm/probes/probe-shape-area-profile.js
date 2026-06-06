'use strict';
// probe-shape-area-profile.js — Diagnostic for the post-PR-#182
// "operation does not support unaligned accesses" RuntimeError that
// fires when right-clicking → Area on a Writer shape under
// ALLOW_MEMORY_GROWTH=1 (LO build 2026-06-02-60+).
//
// Goal: discriminate between three hypotheses listed in
//   ai/proposals/proposed/shape-area-unaligned-access-after-growth.md
//
//   1. Heap-buffer detach race — cached HEAPU8 view from before a
//      growth ends up at misaligned offset
//   2. Bitmap stride/padding bug — alignment assumption in BitmapEx
//      / SvxPresetListBox
//   3. -msimd128 / -matomics flag interaction with growable memory
//
// Strategy:
//   - Open new.docx on the configured viewer.
//   - Insert a basic rectangle (Insert → Shape → BasicShapes.rectangle).
//   - Hook Module.HEAPU8.byteLength + emscripten_resize_heap calls
//     INSIDE the editor iframe BEFORE clicking Area (so we observe
//     the growth window).
//   - Right-click the shape, click "Area…".
//   - Tail browser console + pageerror for 60s; specifically grep
//     for: "unaligned access", "Cannot enlarge memory", "Aborted(",
//     RuntimeError, "memory access out of bounds", growth markers.
//   - Capture pre-/post-click HEAPU8.byteLength + growth count.
//   - Dump everything to /tmp/shape-area-profile.log.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('/home/localadmin/online/wasm/lib/test-env');
const { uploadV2 } = require('/home/localadmin/online/wasm/lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = '/home/localadmin/online/test/data/new.docx';
const OUTLOG  = '/tmp/shape-area-profile.log';
const SHOT    = '/tmp/shape-area-profile-shots';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const stamp = () => `[${((Date.now() - T0) / 1000).toFixed(2)}s]`;

const allLines  = [];   // every console + pageerror line
const interesting = []; // matched filter lines
const FILTER_RE = /unaligned access|Cannot enlarge memory|Aborted\(|RuntimeError|memory access out of bounds|emscripten_resize_heap|HEAPU8\.byteLength|alignment|out of bounds|stack overflow|Stack overflow|unreachable|jserror|EM_ASM|wasm-call|abort_function|abort\(/i;

function rec(kind, text) {
    const line = `${stamp()} ${kind} ${text}`;
    allLines.push(line);
    if (FILTER_RE.test(text)) interesting.push(line);
    // Stream every line to disk for crash resilience.
    try { fs.appendFileSync(OUTLOG, line + '\n'); } catch (_) {}
    // Mirror important markers to stderr so the runner sees progress.
    if (kind.startsWith('[STEP]') || kind.startsWith('[FAIL]')
     || kind.startsWith('[BOOT]') || kind.startsWith('[NAV]')
     || kind.startsWith('[ABORT-DETECTED]') || kind.startsWith('[READY]')
     || kind.startsWith('[HEAP-SNAP]') || kind.startsWith('[GROWTH')) {
        try { process.stderr.write(line + '\n'); } catch (_) {}
    }
}

async function clickInsertTab(page, frame, ifr) {
    for (let i = 0; i < 40; i++) {
        const bbox = await frame.evaluate(() => {
            const el = document.querySelector('#Insert-tab-label');
            if (!el || !el.offsetParent) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        }).catch(() => null);
        if (bbox && bbox.w > 0) {
            await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left,
                                   bbox.y + bbox.h / 2 + ifr.top);
            return true;
        }
        await sleep(200);
    }
    return false;
}

async function clickShapesMenubutton(page, frame, ifr) {
    for (let i = 0; i < 40; i++) {
        const bbox = await frame.evaluate(() => {
            const sels = [
                '[id^="insert-insert-shapes"][id$="-button"]',
                '[id^="insert-insert-shapes"]:not([id$="-button"])',
                '[id*="InsertShapesMenu"]',
            ];
            for (const s of sels) {
                const el = document.querySelector(s);
                if (el && el.offsetParent) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0) return { x: r.left, y: r.top, w: r.width, h: r.height };
                }
            }
            return null;
        }).catch(() => null);
        if (bbox) {
            await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left,
                                   bbox.y + bbox.h / 2 + ifr.top);
            return true;
        }
        await sleep(200);
    }
    return false;
}

async function clickShapeTile(page, frame, ifr, unoCmd) {
    const bbox = await frame.evaluate((target) => {
        const grid = document.querySelector('.insertshape-grid');
        if (!grid) return null;
        const tile = Array.from(grid.querySelectorAll('.col'))
            .find(t => (t.dataset.uno || '') === target);
        if (!tile) return null;
        const r = tile.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, unoCmd).catch(() => null);
    if (!bbox) return false;
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left,
                           bbox.y + bbox.h / 2 + ifr.top);
    return true;
}

async function realClickMenuItem(page, frame, labelRegex, ifr) {
    for (let i = 0; i < 30; i++) {
        const bbox = await frame.evaluate(({ src, flags }) => {
            const re = new RegExp(src, flags);
            const items = Array.from(document.querySelectorAll(
                '.context-menu-item, .menu-entry-with-icon, .menu-entry-no-icon'));
            const found = items.find(el => re.test(el.textContent || ''));
            if (!found) return null;
            const r = found.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height,
                     t: (found.textContent || '').trim().substring(0, 60) };
        }, { src: labelRegex.source, flags: labelRegex.flags });
        if (bbox && bbox.w > 0) {
            await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left,
                                   bbox.y + bbox.h / 2 + ifr.top);
            return { ok: true, item: bbox.t };
        }
        await sleep(150);
    }
    return { ok: false };
}

async function snapHeap(frame, tag) {
    const info = await frame.evaluate(() => {
        // We learned wasmMemory access throws "unreachable" in some path.
        // Stick to HEAPU8 / HEAP8 byteLength which are plain TypedArrays.
        const result = {
            growthCount: window.__growthCount || 0,
            growthHistory: window.__growthHistory || [],
        };
        try {
            if (typeof Module !== 'undefined') {
                if (Module.HEAPU8) result.HEAPU8_byteLength = Module.HEAPU8.byteLength;
                if (Module.HEAP8)  result.HEAP8_byteLength  = Module.HEAP8.byteLength;
            }
        } catch (e) { result.heapAccessErr = String(e); }
        return result;
    }).catch(e => ({ ok: false, err: String(e) }));
    rec('[HEAP-SNAP]', `${tag}: ${JSON.stringify(info)}`);
    return info;
}

async function installGrowthHook(frame) {
    // Inject a window-level growth observer inside the iframe. Wraps
    // Module.asm? No — wraps wasmMemory.grow indirectly by polling
    // HEAPU8.byteLength every 200ms and recording when it changes.
    // We also try to hook emscripten_resize_heap if it's discoverable
    // on Module.
    const r = await frame.evaluate(() => {
        try {
            window.__growthCount = 0;
            window.__growthHistory = [];
            window.__lastHeapBytes = (typeof Module !== 'undefined' && Module.HEAPU8) ?
                Module.HEAPU8.byteLength : 0;
            window.__growthPoller = setInterval(() => {
                try {
                    if (typeof Module === 'undefined' || !Module.HEAPU8) return;
                    const cur = Module.HEAPU8.byteLength;
                    if (cur !== window.__lastHeapBytes) {
                        window.__growthCount++;
                        window.__growthHistory.push({
                            t: Date.now(),
                            from: window.__lastHeapBytes,
                            to: cur,
                        });
                        console.log(`[GROWTH-OBSERVER] grow #${window.__growthCount}: ${window.__lastHeapBytes} -> ${cur} (+${cur - window.__lastHeapBytes} bytes, alignment-of-base: ${(Module.HEAPU8.byteOffset || 0) % 16})`);
                        window.__lastHeapBytes = cur;
                    }
                } catch (e) { /* ignore */ }
            }, 100);
            return { ok: true,
                     initial: window.__lastHeapBytes,
                     hasModule: typeof Module !== 'undefined',
                     hasMemory: typeof Module !== 'undefined' && !!Module.wasmMemory };
        } catch (e) { return { ok: false, err: String(e) }; }
    }).catch(e => ({ ok: false, err: String(e) }));
    rec('[GROWTH-HOOK]', JSON.stringify(r));
    return r;
}

(async () => {
    process.stderr.write(`[boot] starting probe at ${new Date().toISOString()}\n`);
    rec('[BOOT]', `viewer=${VIEWER} editor=${process.env.EDITOR_URL || '(from viewer config)'}`);
    fs.rmSync(SHOT, { recursive: true, force: true });
    fs.mkdirSync(SHOT, { recursive: true });
    // Write log incrementally so a crash mid-probe still captures state
    fs.writeFileSync(OUTLOG, `=== shape-area-profile boot ${new Date().toISOString()} ===\n`);

    const bytes = fs.readFileSync(FIXTURE);
    const docName = `shape-area-profile-${Date.now()}.docx`;
    rec('[UPLOAD]', `name=${docName} size=${bytes.length}`);
    const up = await uploadV2(VIEWER, docName, bytes);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    let shotN = 0;
    const snap = async (page, label) => {
        try { await page.screenshot({ path: `${SHOT}/${String(++shotN).padStart(2,'0')}_${label}.png` }); }
        catch (_) {}
    };

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });

        page.on('console', m => rec(`[console:${m.type()}]`, m.text()));
        page.on('pageerror', e => rec('[pageerror]', e.stack || e.message || String(e)));
        page.on('requestfailed', r => rec('[requestfailed]', `${r.url()} ${r.failure()?.errorText}`));

        const url = `${VIEWER}/?singleuser#file=${up.b64urlSecret}`;
        rec('[NAV]', url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html') || f.url().includes('/browser/dist/'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        rec('[FRAME]', `url=${frame.url()}`);

        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true, { timeout: 90000 });
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount')?.textContent || '';
            const pp = document.querySelector('#StatusDocPos')?.textContent || '';
            return wc.length > 0 || pp.length > 0;
        }, { timeout: 45000 });
        rec('[READY]', 'doc loaded + statusbar live');
        await sleep(2000);
        await snap(page, 'doc_ready');

        await installGrowthHook(frame);
        await snapHeap(frame, 'after-ready');

        const canvasXY = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            const r = c.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2),
                     y: Math.round(r.top + r.height * 0.45) };
        });
        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        const click = { x: canvasXY.x + ifr.left, y: canvasXY.y + ifr.top };
        rec('[GEOM]', `canvasCenter=${JSON.stringify(canvasXY)} ifr=${JSON.stringify(ifr)}`);

        await page.keyboard.press('Escape');
        await sleep(300);
        await page.mouse.click(click.x, click.y);
        await sleep(400);

        const insOk = await clickInsertTab(page, frame, ifr);
        rec('[STEP]', `Insert tab clicked=${insOk}`);
        await sleep(600);
        await snap(page, 'insert_tab');

        const shapesOk = await clickShapesMenubutton(page, frame, ifr);
        rec('[STEP]', `Shapes menubutton clicked=${shapesOk}`);
        await sleep(700);
        await snap(page, 'shapes_popup');

        const tileOk = await clickShapeTile(page, frame, ifr, 'BasicShapes.rectangle');
        rec('[STEP]', `Rectangle tile clicked=${tileOk}`);
        await sleep(500);
        await snap(page, 'shape_armed');

        // Drag-insert
        await page.mouse.move(click.x, click.y);
        await page.mouse.down();
        await page.mouse.move(click.x + 200, click.y + 140, { steps: 8 });
        await page.mouse.up();
        await sleep(2500);
        await snap(page, 'shape_placed');
        await snapHeap(frame, 'after-shape-placed');

        // Right-click for context menu
        const shapeCenter = { x: click.x + 100, y: click.y + 70 };
        rec('[STEP]', `right-click shape at (${shapeCenter.x},${shapeCenter.y})`);
        await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: 'right' });
        let menuVisible = false;
        for (let i = 0; i < 30 && !menuVisible; i++) {
            menuVisible = await frame.evaluate(() =>
                !!document.querySelector('.context-menu-list, .on-the-fly-context-menu')
            ).catch(() => false);
            if (!menuVisible) await sleep(150);
        }
        rec('[STEP]', `context menu visible=${menuVisible}`);
        await snap(page, 'context_menu');

        if (!menuVisible) {
            rec('[FAIL]', 'no context menu — cannot reach Area dialog');
            return;
        }

        await snapHeap(frame, 'before-area-click');

        rec('[CLICK]', 'Area...');
        const area = await realClickMenuItem(page, frame, /^\s*Area/i, ifr);
        rec('[STEP]', `Area menu clicked=${area.ok} item="${area.item || ''}"`);
        if (!area.ok) {
            const items = await frame.evaluate(() => Array.from(
                document.querySelectorAll('.context-menu-item')).map(el =>
                    (el.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 50)));
            rec('[FAIL]', `Area item missing. items=${JSON.stringify(items)}`);
            return;
        }
        await snap(page, 'area_click');

        // Tail 60s, snapping heap every 5s.
        const tailStart = Date.now();
        let tickN = 0;
        while (Date.now() - tailStart < 60000) {
            await sleep(5000);
            tickN++;
            await snapHeap(frame, `tick-${tickN} (+${(((Date.now()-tailStart)/1000)).toFixed(1)}s)`);
            await snap(page, `tick_${tickN}`);
            // Stop early if we already saw the abort signature
            if (interesting.some(l => /unaligned access|Aborted\(|unreachable|Cannot enlarge/i.test(l))) {
                rec('[ABORT-DETECTED]', 'stopping tail early; signature present');
                break;
            }
        }
        // Nudge mainloop to drive any pending render that might reveal abort
        try { await page.mouse.move(click.x + 5, click.y + 5); } catch (_) {}
        await sleep(2000);
        await snapHeap(frame, 'final');
        await snap(page, 'final');

        // Capture growth history one more time
        const growth = await frame.evaluate(() => ({
            count: window.__growthCount || 0,
            history: window.__growthHistory || [],
            initial: window.__lastHeapBytes,
        })).catch(e => ({ err: String(e) }));
        rec('[GROWTH-HISTORY]', JSON.stringify(growth));

        // Final liveness probe
        const alive = await frame.evaluate(() => ({
            hasApp: !!window.app,
            hasModule: !!(window.Module && window.Module.HEAP8),
            HEAPU8_len: (typeof Module !== 'undefined' && Module.HEAPU8) ? Module.HEAPU8.byteLength : -1,
        })).catch(e => ({ err: String(e) }));
        rec('[LIVENESS]', JSON.stringify(alive));
    } finally {
        await browser.close();
    }

    // Dump report
    fs.writeFileSync(OUTLOG,
        '=== INTERESTING FILTERED LINES ===\n' + interesting.join('\n') +
        '\n\n=== ALL LINES (' + allLines.length + ') ===\n' +
        allLines.join('\n') + '\n');
    console.error(`\nWROTE ${OUTLOG} (${allLines.length} total / ${interesting.length} interesting)`);
    console.error(`screenshots in ${SHOT}/`);
})().catch(e => {
    fs.appendFileSync(OUTLOG, `\nFATAL: ${e.stack || e.message}\n`);
    console.error('FATAL', e.stack || e.message);
    process.exit(2);
});
