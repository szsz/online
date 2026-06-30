'use strict';
// Phase-0 triage probe — Area dialog "Colors" palette (colorpage.ui).
//
// Context: yesterday's PaletteManager OOB fix (LO PR #39, LO_BUILD_ID
// 2026-06-18-74) stopped the crash, so the Area dialog now OPENS. The
// next layer of problems: "the palette appears but a lot of the
// components on it do not work." This probe drives the same repro as
// probe-shape-area-stack.js up to the open dialog, then produces a
// per-element DEAD/ALIVE map for the Colors palette:
//
//   1. Inventory: every widget the dialog actually rendered, anchored on
//      #colorset-img, vs the colorpage.ui expected set (paletteselector,
//      colorset, recentcolorset, hex_preset/custom, R/G/B + C/M/Y/K
//      spins + RGB/CMYK radios, oldpreview/newpreview, btnMoreColors,
//      add/delete/edit).
//   2. Build-time console errors SCOPED to the Area-click delta (so we
//      attribute "Unsupported control type" / "executeAction not found"
//      / 404 / a11y to THIS dialog, not startup QuickFind noise).
//   3. Live round-trip per interactive element: wrap app.socket so we
//      see whether an interaction emits anything to core, and snapshot
//      the dialog DOM/img-src before+after to see whether a JSUpdate
//      came back and changed anything.
//
// Diagnostic only — NOT a regression test. It deliberately observes
// internal traffic (app.socket) to localize where each element's wiring
// breaks. The real acceptance tests written in later phases will be
// pure visible-UI per /write-test.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const SHOT_DIR = '/tmp/static-deploy/public/shots-probe-area-colors';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0    = Date.now();
const log   = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}`, fullPage: false }); }
    catch (_) {}
}

// ── repro helpers (lifted from probe-shape-area-stack.js) ──────────────
async function realClickMenuItem(page, frame, labelRegex, ifr) {
    let bbox = null;
    for (let i = 0; i < 30; i++) {
        bbox = await frame.evaluate(({ reSrc, reFlags }) => {
            const re = new RegExp(reSrc, reFlags);
            const items = Array.from(document.querySelectorAll(
                '.context-menu-item, .menu-entry-with-icon, .menu-entry-no-icon'));
            const found = items.find(el => re.test(el.textContent || ''));
            if (!found) return null;
            const r = found.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height,
                     t: (found.textContent || '').trim().substring(0, 80) };
        }, { reSrc: labelRegex.source, reFlags: labelRegex.flags });
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(150);
    }
    if (!bbox) return { ok: false, why: 'menu item not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true, item: bbox.t };
}

async function clickInsertTab(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 40; i++) {
        bbox = await frame.evaluate(() => {
            const el = document.querySelector('#Insert-tab-label');
            if (!el || !el.offsetParent) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        }).catch(() => null);
        if (bbox && bbox.w > 0 && bbox.h > 0) break;
        await sleep(200);
    }
    if (!bbox) return { ok: false, why: 'Insert-tab-label not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true };
}

async function clickShapesMenubutton(page, frame, ifr) {
    let bbox = null;
    for (let i = 0; i < 40; i++) {
        bbox = await frame.evaluate(() => {
            const sel = [
                '[id^="insert-insert-shapes"][id$="-button"]',
                '[id^="insert-insert-shapes"]:not([id$="-button"])',
                '[id*="InsertShapesMenu"]',
            ];
            for (const s of sel) {
                const el = document.querySelector(s);
                if (el && el.offsetParent) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0)
                        return { x: r.left, y: r.top, w: r.width, h: r.height, sel: s };
                }
            }
            return null;
        }).catch(() => null);
        if (bbox) break;
        await sleep(200);
    }
    if (!bbox) return { ok: false, why: 'shapes menubutton not found' };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true, sel: bbox.sel };
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
    if (!bbox || bbox.w === 0) return { ok: false, why: `tile ${unoCmd} missing` };
    await page.mouse.click(bbox.x + bbox.w / 2 + ifr.left, bbox.y + bbox.h / 2 + ifr.top);
    return { ok: true };
}

// Expected colorpage.ui interactive widgets (the "should work" set).
const EXPECTED = [
    'paletteselector', 'colorset', 'recentcolorset',
    'hex_preset', 'hex_custom',
    'R_preset', 'G_preset', 'B_preset', 'R_custom', 'G_custom', 'B_custom',
    'C_preset', 'M_preset', 'Y_preset', 'K_preset',
    'C_custom', 'M_custom', 'Y_custom', 'K_custom',
    'RGB', 'CMYK', 'B_preset', 'B_custom',
    'oldpreview', 'newpreview',
    'btnMoreColors', 'add', 'delete', 'edit',
];

(async () => {
    log('=== Phase-0 triage: Area dialog Colors palette per-element map ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(FIXTURE)) { log(`SKIP: fixture missing: ${FIXTURE}`); process.exit(2); }

    const bytes = fs.readFileSync(FIXTURE);
    const name  = `area-colors-probe-${Date.now()}.docx`;
    const up    = await uploadV2(VIEWER, name, bytes);
    log(`uploaded ${name}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });

        const consoleLines = [];
        const failedReqs   = [];
        page.on('console', m => consoleLines.push(m.text()));
        page.on('response', r => { if (r.status() >= 400) failedReqs.push(`${r.status()} ${r.url()}`); });
        page.on('requestfailed', r => failedReqs.push(`FAILED ${r.url()}`));

        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded', timeout: env.scaleTimeout(120000) });

        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true,
            { timeout: env.scaleTimeout(90000) });
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount')?.textContent || '';
            const pp = document.querySelector('#StatusDocPos')?.textContent || '';
            return wc.length > 0 || pp.length > 0;
        }, { timeout: env.scaleTimeout(150000) });
        await sleep(2500);
        await snap(page, 'loaded');

        // Wrap app.socket.sendMessage so we can see what each interaction
        // emits to core. Buffer lives on window.__probeOut.
        await frame.evaluate(() => {
            window.__probeOut = [];
            try {
                const s = window.app && window.app.socket;
                if (s && typeof s.sendMessage === 'function' && !s.__probeWrapped) {
                    const orig = s.sendMessage.bind(s);
                    s.sendMessage = function (msg) {
                        try { window.__probeOut.push(String(msg).substring(0, 240)); } catch (e) {}
                        return orig(msg);
                    };
                    s.__probeWrapped = true;
                }
            } catch (e) {}
        }).catch(() => {});

        const canvasXY = await frame.evaluate(() => {
            const c = document.querySelector('#document-canvas');
            const r = c.getBoundingClientRect();
            return { x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height * 0.45) };
        });
        const ifr = await page.evaluate(() => {
            const f = document.querySelector('iframe');
            const r = f.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top) };
        });
        const clickXY = { x: canvasXY.x + ifr.left, y: canvasXY.y + ifr.top };

        // Insert a rectangle.
        await page.keyboard.press('Escape'); await sleep(300);
        await page.mouse.click(clickXY.x, clickXY.y); await sleep(400);
        const ins = await clickInsertTab(page, frame, ifr);
        log(`Insert tab → ok=${ins.ok} ${ins.why || ''}`); await sleep(600);
        const sm = await clickShapesMenubutton(page, frame, ifr);
        log(`shapes menubutton → ok=${sm.ok} ${sm.why || ''}`); await sleep(800);
        const tile = await clickShapeTile(page, frame, ifr, 'BasicShapes.rectangle');
        log(`rectangle tile → ok=${tile.ok} ${tile.why || ''}`);
        if (!tile.ok) throw new Error('could not arm rectangle tile');
        await sleep(500);
        await page.mouse.move(clickXY.x, clickXY.y);
        await page.mouse.down();
        await page.mouse.move(clickXY.x + 200, clickXY.y + 140, { steps: 8 });
        await page.mouse.up();
        const shapeCenter = { x: clickXY.x + 100, y: clickXY.y + 70 };
        await sleep(2500);
        await snap(page, 'shape_placed');

        // Right-click → Area...
        await page.mouse.click(shapeCenter.x, shapeCenter.y, { button: 'right' });
        let menuVisible = false;
        for (let i = 0; i < 30 && !menuVisible; i++) {
            menuVisible = await frame.evaluate(() =>
                !!document.querySelector('.context-menu-list, .on-the-fly-context-menu')).catch(() => false);
            if (!menuVisible) await sleep(150);
        }
        await snap(page, 'context_menu');
        if (!menuVisible) throw new Error('no context menu after right-click');

        // Baseline the console BEFORE Area so we attribute the delta to
        // the dialog, not to startup QuickFind noise.
        const beforeConsoleLen = consoleLines.length;
        const beforeFailedLen  = failedReqs.length;

        const area = await realClickMenuItem(page, frame, /^\s*Area/i, ifr);
        log(`Area... → ok=${area.ok} item="${area.item || ''}" ${area.why || ''}`);
        if (!area.ok) throw new Error('Area... menu item not present');

        // Wait for the dialog to render the colorset.
        let dialogUp = false;
        for (let i = 0; i < 60 && !dialogUp; i++) {
            dialogUp = await frame.evaluate(() =>
                !!document.querySelector('#colorset-img, #colorset, [id^="colorset"]')).catch(() => false);
            if (!dialogUp) await sleep(250);
        }
        await sleep(1500);
        await snap(page, 'area_dialog');
        log(`colorset rendered: ${dialogUp}`);

        // ── Build-time console delta (attributed to this dialog) ──
        const dlgConsole = consoleLines.slice(beforeConsoleLen);
        const dlgFailed  = failedReqs.slice(beforeFailedLen);
        const grep = (re) => dlgConsole.filter(l => re.test(l));
        const unsupported = [...new Set(grep(/Unsupported control type/).map(l => (l.match(/"([^"]+)"/) || [])[1]).filter(Boolean))];
        const actionMiss  = [...new Set(grep(/executeAction: not found control with id/).map(l => (l.match(/id: "([^"]+)"/) || [])[1]).filter(Boolean))];
        const a11yMiss    = [...new Set(grep(/Missing alt attribue/).map(l => (l.match(/imageId: '([^']+)'/) || [])[1]).filter(Boolean))];

        log('──── BUILD-TIME ERRORS (Area-click delta) ────');
        log(`  Unsupported control types : ${JSON.stringify(unsupported)}`);
        log(`  executeAction not-found   : ${JSON.stringify(actionMiss)}`);
        log(`  a11y missing-alt images   : ${JSON.stringify(a11yMiss)}`);
        log(`  failed network requests   : ${JSON.stringify(dlgFailed.slice(0, 12))}`);

        // ── Widget inventory: walk up from #colorset-img to the dialog
        // root, then collect every element with an id. ──
        const inventory = await frame.evaluate((expected) => {
            const anchor = document.querySelector('#colorset-img, #colorset, [id^="colorset"]');
            if (!anchor) return { found: false };
            // dialog root = nearest ancestor that looks like a jsdialog window
            let root = anchor;
            while (root.parentElement &&
                   !/jsdialog-container|lokdialog|ui-dialog|jsdialog-window/.test(root.className || '')) {
                root = root.parentElement;
                if (root === document.body) break;
            }
            const all = Array.from(root.querySelectorAll('[id]'));
            const norm = (id) => id.replace(/-img$/, '').replace(/-input$/, '').replace(/-button$/, '');
            const seen = {};
            for (const el of all) {
                const base = norm(el.id);
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                seen[el.id] = {
                    base,
                    tag: el.tagName.toLowerCase(),
                    cls: (el.className || '').toString().substring(0, 60),
                    disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' ||
                              /disabled/.test(el.className || ''),
                    visible: !!(r.width && r.height) && cs.display !== 'none' && cs.visibility !== 'hidden',
                    w: Math.round(r.width), h: Math.round(r.height),
                };
            }
            // for each expected widget, did anything with that base id render?
            const map = {};
            for (const want of expected) {
                const hit = Object.entries(seen).find(([id, v]) => v.base === want || id === want);
                map[want] = hit ? { id: hit[0], ...hit[1] } : null;
            }
            return {
                found: true,
                rootClass: (root.className || '').toString(),
                totalIds: all.length,
                idList: all.map(e => e.id).slice(0, 120),
                expectedMap: map,
            };
        }, EXPECTED).catch(e => ({ found: false, err: String(e) }));

        log('──── WIDGET INVENTORY ────');
        if (!inventory.found) {
            log(`  colorset anchor NOT found in DOM — dialog did not render the palette. ${inventory.err || ''}`);
        } else {
            log(`  dialog root class: ${inventory.rootClass}`);
            log(`  total ids under root: ${inventory.totalIds}`);
            log(`  id list: ${JSON.stringify(inventory.idList)}`);
            log('  expected-widget presence:');
            for (const want of EXPECTED) {
                const v = inventory.expectedMap[want];
                if (!v) log(`    ✗ ${want.padEnd(16)} MISSING`);
                else log(`    ✓ ${want.padEnd(16)} id=${v.id} <${v.tag}> vis=${v.visible} dis=${v.disabled} ${v.w}x${v.h} cls="${v.cls}"`);
            }
        }

        // ── Live round-trip probes on the three most telling elements ──
        // colorset click, paletteselector open, hex_custom typing.
        async function probe(label, fn) {
            await frame.evaluate(() => { window.__probeOut.length = 0; });
            const before = await frame.evaluate(() => ({
                newprev: document.querySelector('#newpreview-img, #newpreview')?.getAttribute('src') || '',
                hex: document.querySelector('#hex_custom-input, #hex_custom input, #hex_preset-input')?.value || '',
                colorsrc: document.querySelector('#colorset-img')?.getAttribute('src')?.slice(-40) || '',
            }));
            await fn();
            await sleep(1200);
            const after = await frame.evaluate(() => ({
                out: window.__probeOut.slice(0, 8),
                newprev: document.querySelector('#newpreview-img, #newpreview')?.getAttribute('src') || '',
                hex: document.querySelector('#hex_custom-input, #hex_custom input, #hex_preset-input')?.value || '',
                colorsrc: document.querySelector('#colorset-img')?.getAttribute('src')?.slice(-40) || '',
            }));
            const emitted = after.out.length;
            const changed = after.newprev !== before.newprev || after.hex !== before.hex || after.colorsrc !== before.colorsrc;
            log(`  [${label}] emitted=${emitted} domChanged=${changed}`);
            log(`     out: ${JSON.stringify(after.out)}`);
            if (changed) log(`     Δ newprev:${after.newprev !== before.newprev} hex:${after.hex !== before.hex}(${before.hex}->${after.hex}) colorset:${after.colorsrc !== before.colorsrc}`);
            return { emitted, changed };
        }

        log('──── LIVE ROUND-TRIP PROBES ────');
        // colorset: click near top-left cell of the palette grid image.
        await probe('colorset click', async () => {
            const box = await frame.evaluate(() => {
                const el = document.querySelector('#colorset-img');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height };
            });
            if (box && box.w) {
                await page.mouse.click(box.x + 12 + ifr.left, box.y + 12 + ifr.top);
            } else { log('     colorset-img not clickable (no box)'); }
        });
        await snap(page, 'after_colorset_click');

        // paletteselector: click to open the dropdown.
        await probe('paletteselector open', async () => {
            const box = await frame.evaluate(() => {
                const el = document.querySelector('[id^="paletteselector"]');
                if (!el) return null;
                const t = el.querySelector('select, .ui-combobox-button, button, input') || el;
                const r = t.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height };
            });
            if (box && box.w) {
                await page.mouse.click(box.x + box.w - 8 + ifr.left, box.y + box.h / 2 + ifr.top);
            } else { log('     paletteselector not found'); }
        });
        await snap(page, 'after_paletteselector');

        // hex field: focus + type a value + Enter.
        await probe('hex type FF0000', async () => {
            const box = await frame.evaluate(() => {
                const el = document.querySelector('#hex_custom-input, #hex_custom input, #hex_preset-input, [id^="hex"] input');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.left, y: r.top, w: r.width, h: r.height };
            });
            if (box && box.w) {
                await page.mouse.click(box.x + box.w / 2 + ifr.left, box.y + box.h / 2 + ifr.top);
                await sleep(150);
                await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
                await page.keyboard.type('FF0000', { delay: 40 });
                await page.keyboard.press('Enter');
            } else { log('     hex field not found'); }
        });
        await snap(page, 'after_hex_type');

        log('\n=== PROBE COMPLETE — see per-element map above ===');
        log(`screenshots: ${VIEWER.replace(/\/$/, '')}/shots-probe-area-colors/`);
    } finally {
        await browser.close();
    }
    process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
