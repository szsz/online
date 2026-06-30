'use strict';
// Probe: click the "Vorlagen-Seitenleiste öffnen" button and capture
// what the sidebar deck actually shows so we can see which strings
// stay English even after PR #116 langpacks + PR #118 l10n fixes.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { uploadV2 } = require('../lib/v2-upload');

const VIEWER = 'https://wasm-viewer-internal.azurewebsites.net';
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'mixed-lang-paragraphs.docx');
const OUT = '/tmp/probe-sidebar-deck-lang';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

(async () => {
    const bytes = fs.readFileSync(FIXTURE);
    const up = await uploadV2(VIEWER, `probe-sb-${Date.now()}.docx`, bytes);
    log(`uploaded ${up.fileId.substring(0,12)}`);

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--lang=de-DE'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1700, height: 1100 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de'] });
        Object.defineProperty(navigator, 'language',  { get: () => 'de-DE' });
        try { localStorage.setItem('cool-ui-lang', 'de'); } catch (_) {}
    });
    await page.goto(`${VIEWER}/?singleuser#file=${up.b64urlSecret}`, {
        waitUntil: 'domcontentloaded', timeout: 120000,
    });

    let frame = null;
    for (let i = 0; i < 90 && !frame; i++) {
        frame = page.frames().find(f => f.url().includes('cool.html'));
        if (frame && !(await frame.$('#document-canvas').catch(()=>null))) frame = null;
        if (!frame) await sleep(1000);
    }
    log(`frame found`);
    await sleep(14000);
    await page.screenshot({ path: `${OUT}/01_doc_loaded.png` });

    // Find the styles iconview "more" dropdown trigger.
    // The "Open Styles Sidebar" button (id=format-style-list-dialog) only
    // appears inside the styles iconview dropdown menu. We need to first
    // open that dropdown via the expander button (#stylesview-iconview-list-expand-button),
    // then click the format-style-list-dialog entry.
    log('--- looking for expander button ---');
    const expanderInfo = await frame.evaluate(() => {
        const exp = document.querySelector('#stylesview-iconview-list-expand-button');
        if (!exp) return null;
        const r = exp.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, text: exp.innerText };
    });
    log(`expander: ${JSON.stringify(expanderInfo)}`);

    if (expanderInfo) {
        // Compute click coords on the page (account for iframe offset).
        const iframeEl = await page.$('#editor-frame, iframe');
        const ifBox = iframeEl ? await iframeEl.boundingBox() : { x: 0, y: 0 };
        await page.mouse.click(ifBox.x + expanderInfo.x + expanderInfo.w/2,
                                ifBox.y + expanderInfo.y + expanderInfo.h/2);
        await sleep(1500);
        await page.screenshot({ path: `${OUT}/02_dropdown_open.png` });

        // Now click the "Open Styles Sidebar" entry inside the dropdown.
        const sidebarBtnInfo = await frame.evaluate(() => {
            const btn = document.querySelector('#format-style-list-dialog, #format-style-list-dialog-button');
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, text: btn.innerText };
        });
        log(`open-sidebar-btn: ${JSON.stringify(sidebarBtnInfo)}`);

        if (sidebarBtnInfo) {
            await page.mouse.click(ifBox.x + sidebarBtnInfo.x + sidebarBtnInfo.w/2,
                                    ifBox.y + sidebarBtnInfo.y + sidebarBtnInfo.h/2);
            await sleep(4000);
        }
        await page.screenshot({ path: `${OUT}/03_sidebar_clicked.png` });
    }

    // Now sample text in the right pane (the actual sidebar deck).
    log('--- sampling right-pane (x>1300) text ---');
    const samples = await frame.evaluate(() => {
        const out = [];
        document.querySelectorAll('*').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.x < 1300 || r.x > 1700) return;
            if (r.width < 30 || r.height < 10) return;
            const t = (el.innerText || el.textContent || '').trim();
            if (!t || t.length < 2 || t.length > 80) return;
            out.push({ x: r.x|0, y: r.y|0, text: t, tag: el.tagName,
                       id: el.id || (el.className || '').substring(0,40) });
        });
        const seen = new Set();
        return out.filter(o => { if (seen.has(o.text)) return false; seen.add(o.text); return true; }).slice(0, 60);
    });
    log(`right-pane samples: ${samples.length}`);
    for (const s of samples) log(`  @x=${s.x} y=${s.y} "${s.text}" [${s.id}]`);

    fs.writeFileSync(`${OUT}/samples.json`, JSON.stringify(samples, null, 2));
    fs.writeFileSync(`${OUT}/report.html`, `
<!doctype html><meta charset="utf-8"><title>Probe: sidebar deck lang</title>
<style>body{font-family:system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}
img{max-width:100%;border:1px solid #ccc;margin:0.5rem 0}
pre{background:#f4f4f4;padding:0.8rem;overflow-x:auto;font-size:.85rem}</style>
<h1>Probe — Sidebar deck content lang</h1>
<p>Target: ${VIEWER}, editor pinned to latest (2026-05-19-112539)</p>
<h2>01 Document loaded</h2><img src="01_doc_loaded.png">
<h2>02 Style dropdown opened</h2><img src="02_dropdown_open.png">
<h2>03 After clicking Open Styles Sidebar</h2><img src="03_sidebar_clicked.png">
<h2>Right-pane text samples</h2>
<pre>${JSON.stringify(samples, null, 2)}</pre>
`);
    log(`report at ${OUT}/report.html`);
    await browser.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
