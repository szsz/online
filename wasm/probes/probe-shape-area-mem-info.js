'use strict';
// probe-shape-area-mem-info.js — minimal info probe: load editor, wait
// for kit, read Module.HEAPU8.byteLength + wasmMemory.maximum + grow
// thresholds. Doesn't drive the Area dialog — just snapshots state
// to discriminate hypotheses.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('/home/localadmin/online/wasm/lib/test-env');
const { uploadV2 } = require('/home/localadmin/online/wasm/lib/v2-upload');

const VIEWER  = env.FILE_STORAGE_URL;
const FIXTURE = '/home/localadmin/online/test/data/new.docx';
const OUTLOG  = '/tmp/shape-area-mem-info.log';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const lines = [];
    const rec = (k, v) => { const l = `[${k}] ${v}`; lines.push(l); process.stderr.write(l + '\n'); };

    rec('boot', new Date().toISOString());

    const bytes = fs.readFileSync(FIXTURE);
    const name = `mem-info-${Date.now()}.docx`;
    const up = await uploadV2(VIEWER, name, bytes);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 300000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900 });
        page.on('console', m => lines.push(`[console:${m.type()}] ${m.text()}`));
        page.on('pageerror', e => lines.push(`[pageerror] ${e.message}`));

        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded', timeout: 120000 });

        let frame = null;
        for (let i = 0; i < 90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html') || f.url().includes('/browser/dist/'));
            if (frame && !(await frame.$('#document-canvas').catch(() => null))) frame = null;
            if (!frame) await sleep(1000);
        }
        if (!frame) throw new Error('editor frame never loaded');
        rec('frame', frame.url());

        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true, { timeout: 90000 });
        await frame.waitForFunction(() => {
            const wc = document.querySelector('#StateWordCount')?.textContent || '';
            return wc.length > 0;
        }, { timeout: 45000 });
        rec('ready', '');

        // Multiple probes — try every reasonable globals path
        const info = await frame.evaluate(() => {
            const out = { tries: [] };

            // Try direct global `Module` (emscripten convention)
            try {
                out.tries.push({ key: 'window.Module', has: typeof Module !== 'undefined' });
                if (typeof Module !== 'undefined') {
                    out.directModule = {
                        keys: Object.keys(Module).filter(k => /HEAP|wasm|memory|buffer|asm/i.test(k)),
                        HEAPU8_byteLength: Module.HEAPU8 && Module.HEAPU8.byteLength,
                        HEAP8_byteLength:  Module.HEAP8  && Module.HEAP8.byteLength,
                    };
                    if (Module.wasmMemory) {
                        out.directModule.wasmMemoryBufferLength = Module.wasmMemory.buffer.byteLength;
                        out.directModule.wasmMemoryGrowExists = typeof Module.wasmMemory.grow === 'function';
                        // wasmMemory.grow returns prev page count; we don't call it
                    }
                }
            } catch (e) { out.tries.push({ err: 'window.Module', msg: String(e) }); }

            // Maybe app.LOK exposes it
            try {
                out.tries.push({ key: 'window.app', has: typeof window.app !== 'undefined' });
                if (window.app) {
                    out.appKeys = Object.keys(window.app).filter(k => /lok|module|wasm|heap/i.test(k)).slice(0, 20);
                }
            } catch (e) { out.tries.push({ err: 'window.app', msg: String(e) }); }

            // Try Module via global lookup (might be a getter on globalThis)
            try {
                out.tries.push({ key: 'globalThis.Module', has: typeof globalThis.Module !== 'undefined' });
            } catch (e) {}

            // Look at all-window properties (filter for memory-related)
            try {
                const props = Object.getOwnPropertyNames(window).filter(p => /module|wasm|heap|memory|asm|emscripten/i.test(p));
                out.windowProps = props.slice(0, 30);
            } catch (e) {}

            return out;
        }).catch(e => ({ err: String(e) }));
        rec('info', JSON.stringify(info, null, 2));
    } finally {
        await browser.close();
    }
    fs.writeFileSync(OUTLOG, lines.join('\n'));
    process.stderr.write(`\nWROTE ${OUTLOG} (${lines.length} lines)\n`);
})().catch(e => {
    fs.appendFileSync(OUTLOG, '\nFATAL ' + (e.stack || e.message));
    process.exit(2);
});
