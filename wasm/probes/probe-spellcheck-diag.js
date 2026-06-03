'use strict';
// Probe: spellcheck diagnosis. Captures console output from the iframe
// (especially [dict-loader] lines + LO spellcheck-related messages) and
// inspects the editor's reachable state. The Schmettrling probe shows
// 0 red pixels even on pre-existing typos — the spellcheck daemon is
// likely never starting. Find out WHY.
//
// Output: /tmp/probe-spellcheck-diag/ with console.log, FS dump, report.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { uploadV2 } = require('../lib/v2-upload');

const VIEWER = 'https://wasm-viewer-internal.azurewebsites.net';
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');
const OUT = '/tmp/probe-spellcheck-diag';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

(async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const up = await uploadV2(VIEWER, `probe-sc-${Date.now()}.docx`, bytes);
    log(`uploaded ${up.fileId.substring(0,12)}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--lang=de-DE'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de'] });
        Object.defineProperty(navigator, 'language',  { get: () => 'de-DE' });
        try { localStorage.setItem('cool-ui-lang', 'de'); } catch (_) {}
    });

    // Capture every console message from main page + iframe.
    const consoleLines = [];
    const stash = (src, type, text) => {
        const line = `[${((Date.now()-T0)/1000).toFixed(1)}s ${src} ${type}] ${text}`;
        consoleLines.push(line);
        // Surface dict-loader and spell- noise immediately.
        if (/dict-loader|spell|SpellOnline|dictionary|hunspell|linguistic/i.test(text)) {
            console.log('  ' + line);
        }
    };
    page.on('console', m => stash('page', m.type(), m.text()));
    page.on('pageerror', e => stash('page', 'error', e.message));

    await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`, {
        waitUntil: 'domcontentloaded', timeout: 120000,
    });

    let frame = null;
    for (let i = 0; i < 90 && !frame; i++) {
        frame = page.frames().find(f => f.url().includes('cool.html'));
        if (frame && !(await frame.$('#document-canvas').catch(()=>null))) frame = null;
        if (!frame) await sleep(1000);
    }
    if (!frame) { log('FATAL no frame'); await browser.close(); return; }
    log(`frame ${frame.url().substring(0,80)}`);

    // Wire console capture for the iframe too.
    frame.page = page;
    page.on('framenavigated', f => {
        if (f.url().includes('cool.html')) {
            // can't re-attach; the one attached at page level catches
            // child-frame console events because Puppeteer's `console`
            // event fires for the whole page tree by default.
        }
    });

    log('waiting 18s for cold-load + dict preload');
    await sleep(18000);

    // Inspect iframe state.
    const fsState = await frame.evaluate(() => {
        const Module = globalThis.Module;
        const out = { hasModule: !!Module, hasFS: !!(Module && Module.FS) };
        if (!out.hasFS) return out;
        try {
            const FS = Module.FS;
            const base = '/instdir/share/extensions';
            const entries = FS.readdir(base).filter(e => !e.startsWith('.'));
            out.extensionsDir = entries;
            // For each dict-* extension, list its contents.
            out.dictContents = {};
            for (const e of entries) {
                if (e.startsWith('dict-')) {
                    out.dictContents[e] = FS.readdir(`${base}/${e}`).filter(x => !x.startsWith('.'));
                }
            }
        } catch (err) {
            out.fsError = err.message;
        }
        out.dictLoaderState = (() => {
            try { return globalThis.dictLoaderState || 'n/a'; } catch { return 'n/a'; }
        })();
        out.appMap = !!(globalThis.app && globalThis.app.map);
        return out;
    });
    log('FS state: ' + JSON.stringify(fsState, null, 2));

    // Verify SpellOnline via dispatch query: ask the map what
    // .uno:SpellOnline state is.
    const spellState = await frame.evaluate(() => {
        const out = {};
        if (window.app && window.app.map) {
            try {
                // The map provides stateChangeHandler events; we'll
                // poke its known state cache directly.
                out.knownStates = Object.keys(window.app.map._docLayer && window.app.map._docLayer._stateChangeMap || {});
                // Dispatch a status request for SpellOnline.
                window.app.map.dispatch('uno:SpellOnline');
            } catch (e) {
                out.err = e.message;
            }
        }
        return out;
    });
    log('spellState: ' + JSON.stringify(spellState));

    // Now click into the doc, sample current canvas + sample for
    // SQUIGGLE under existing typo "manuscrit" (already in fixture).
    const canvas = await frame.$('#document-canvas');
    if (canvas) {
        await canvas.click({ offset: { x: 200, y: 200 } });
        await sleep(800);
        // Move to end of doc, type 3 misspellings to provoke squiggle.
        await page.keyboard.press('End');
        await page.keyboard.press('End');
        await page.keyboard.type(' Schmettrling fhsdkj qweryt', { delay: 50 });
        await sleep(4000);
        await page.screenshot({ path: `${OUT}/after_type.png` });

        // Sample red pixel ratio across a much wider band — the whole
        // visible document area.
        const redScan = await frame.evaluate(() => {
            const canvas = document.getElementById('document-canvas');
            if (!canvas) return null;
            const ctx = canvas.getContext('2d');
            const W = canvas.width, H = canvas.height;
            const data = ctx.getImageData(0, 0, W, H).data;
            let redPx = 0;
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i+1], b = data[i+2];
                if (r > 150 && g < 90 && b < 90) redPx++;
            }
            return { W, H, redPx, totalPx: W * H };
        });
        log('full-canvas red scan: ' + JSON.stringify(redScan));
    }

    // Save console output.
    fs.writeFileSync(`${OUT}/console.log`, consoleLines.join('\n'));
    log(`captured ${consoleLines.length} console lines; see ${OUT}/console.log`);

    // Filter the interesting subset
    const dictLines = consoleLines.filter(l => /dict-loader|spell|SpellOnline|hunspell|extension|linguistic/i.test(l));
    fs.writeFileSync(`${OUT}/console-filtered.log`, dictLines.join('\n'));
    log(`filtered ${dictLines.length} dict/spell lines; see ${OUT}/console-filtered.log`);

    await browser.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
