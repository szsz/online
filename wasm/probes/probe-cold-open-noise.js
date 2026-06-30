'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('/home/localadmin/online/wasm/lib/test-env');
const { uploadV2 } = require('/home/localadmin/online/wasm/lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const T0 = Date.now();
const log = m => console.error(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);

(async () => {
    log('=== Cold-open noise survey ===');
    const docName = 'cold-survey-' + Date.now() + '.docx';
    const fixture = path.join('/home/localadmin/online/test/data/new.docx');
    const bytes = fs.readFileSync(fixture);
    const up = await uploadV2(VIEWER, docName, bytes);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const allLines = [];
    let lines = 0, bytesAcc = 0;
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('console', m => {
            const t = m.text();
            const type = m.type();
            lines++;
            bytesAcc += Buffer.byteLength(t, 'utf8');
            allLines.push(`[${type}] ${t}`);
        });
        page.on('pageerror', e => allLines.push(`[pageerror] ${e.message || e}`));
        await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`,
            { waitUntil: 'domcontentloaded', timeout: 120000 });

        let frame = null;
        for (let i=0; i<90 && !frame; i++) {
            frame = page.frames().find(f => f.url().includes('cool.html'));
            if (frame && !(await frame.$('#document-canvas').catch(()=>null))) frame = null;
            if (!frame) await new Promise(r=>setTimeout(r,1000));
        }
        if (!frame) throw new Error('editor frame never loaded');
        await frame.waitForFunction(() => window.__wasmInitialDocLoaded === true, { timeout: 60000 });
        await frame.waitForFunction(() =>
            /character/i.test(document.querySelector('#StateWordCount')?.textContent || ''),
            { timeout: 30000 });

        const idleStart = Date.now();
        let lastSeen = lines;
        let quietSince = Date.now();
        while (Date.now() - idleStart < 30000) {
            await new Promise(r=>setTimeout(r,500));
            if (lines !== lastSeen) { lastSeen = lines; quietSince = Date.now(); }
            else if (Date.now() - quietSince > 2000) break;
        }
    } finally { await browser.close(); }

    fs.writeFileSync('/tmp/cold-noise-all.txt', allLines.join('\n'));
    log(`Total: ${lines} lines / ${bytesAcc} bytes; saved /tmp/cold-noise-all.txt`);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
