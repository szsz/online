// test-warm-switch-type-measure.js — DIAGNOSTIC / MEASUREMENT (throwaway)
//
// Measures the "Fix A" (explicit type= token on switchdocument) for the
// slow-consecutive-warm-open bug. Opens a sequence of distinct pptx files
// one after another in the SAME page via REAL hash navigation (the same
// user action the viewer hot-switch path drives — no sendUnoCommand, no
// dispatcher, no evaluate-click). For each warm open we:
//   - measure wall time to "verified" (canvas painted + #SlideStatus
//     "Slide N of M" present + canvas-hash differs from the previous doc)
//   - classify the kit path from the SWITCHDOC console marks (SW_MARK
//     emits these to the browser console; the per-rc trace was stripped
//     before ship, so we infer success from the marks alone):
//       in-place => `inPlace:start`/`inPlace:done` with NO `documentLoad:start`
//       slow     => `documentLoad:start`/`documentLoad:about-to-call`
//   - record the canvas-hash + slide-status so we can prove each open
//     rendered the CORRECT distinct document (no stale-doc bleed).
//
// On the LAST open we additionally type a character via real keyboard
// (page.keyboard) and confirm the canvas changes — i.e. edits still work
// after the (possibly consecutive) in-place reloads.
//
// Env: set -a; . ~/ENV/online.env; set +a   then  node <this>
// Optional: SEQ env var selects the fixture sequence, default "abcabc".
//   a=testdoc(4) b=rare-fonts(1) c=heavy-50(50)

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const DATA = path.join(__dirname, '..', '..', '..', 'test', 'data');

const FIX = {
    a: { file: path.join(DATA, 'testdoc.pptx'),        label: 'testdoc' },
    b: { file: path.join(DATA, 'rare-fonts.pptx'),     label: 'rare-fonts' },
    c: { file: path.join(DATA, 'heavy-50slides.pptx'), label: 'heavy-50' },
};
const SEQ = (process.env.SEQ || 'abcabc').split('');

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(m) { console.log(`[${elapsed()}] ${m}`); }

async function probe(page) {
    const fr = page.frames().find(f => f.url().includes('cool.html'));
    if (!fr) return { hasCanvas: false, statusOk: false, canvasHash: null, statusText: '' };
    return await fr.evaluate(() => {
        const c = document.querySelector('canvas');
        const ss = document.querySelector('#SlideStatus');
        const txt = (ss && ss.textContent || '').trim();
        let canvasHash = null;
        if (c) {
            try {
                const ctx = c.getContext('2d', { willReadFrequently: true });
                const w = Math.min(400, c.width), h = Math.min(300, c.height);
                if (w > 0 && h > 0) {
                    const data = ctx.getImageData(0, 0, w, h).data;
                    let h1 = 5381, h2 = 52711;
                    for (let i = 0; i < data.length; i += 7) {
                        h1 = ((h1 * 33) ^ data[i]) >>> 0;
                        h2 = ((h2 * 31) ^ data[i]) >>> 0;
                    }
                    canvasHash = (h1.toString(16) + h2.toString(16));
                }
            } catch (_) { canvasHash = 'denied'; }
        }
        return { hasCanvas: !!c, statusText: txt,
                 statusOk: /Slide\s+\d+\s+of\s+\d+/i.test(txt), canvasHash };
    }).catch(() => ({ hasCanvas: false, statusOk: false, canvasHash: null, statusText: '' }));
}

async function waitVerified(page, baselineHash, timeoutMs) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
        const p = await probe(page);
        last = p;
        const hashOk = !baselineHash || (p.canvasHash && p.canvasHash !== baselineHash && p.canvasHash !== 'denied');
        if (p.hasCanvas && p.statusOk && hashOk)
            return { ms: Date.now() - t0, canvasHash: p.canvasHash, statusText: p.statusText };
        await sleep(60);
    }
    return { ms: null, canvasHash: last && last.canvasHash, statusText: last && last.statusText, error: 'timeout' };
}

(async () => {
    const seq = SEQ.map(k => FIX[k]);
    log(`sequence: ${SEQ.join('')} -> ${seq.map(s => s.label).join(', ')}`);
    const ups = [];
    for (let i = 0; i < seq.length; i++) {
        const f = seq[i];
        const up = await uploadV2(VIEWER, f.label + '-' + i + '-' + Date.now() + '.pptx', fs.readFileSync(f.file));
        ups.push(up);
        log(`[setup] uploaded ${f.label} fileId=${up.fileId.slice(0,8)}`);
    }

    const { browser, cleanup } = await launch();
    const results = [];
    const swMarks = [];
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });
        page.on('pageerror', e => log(`[pageerror] ${e.message}`));
        page.on('console', m => {
            const t = m.text();
            if (/SWITCHDOC|in-place reload|inPlace|documentLoad|desiredType/i.test(t))
                swMarks.push({ t: Date.now(), text: t.slice(0, 200) });
        });

        for (let i = 0; i < ups.length; i++) {
            const f = seq[i];
            const prevHash = i === 0 ? null : results[i - 1].canvasHash;
            const markStart = swMarks.length;
            const tStart = Date.now();

            if (i === 0) {
                log(`[open#1 COLD] ${f.label}`);
                await page.goto(VIEWER + '/?planc=1#file=' + ups[i].b64urlSecret,
                    { waitUntil: 'domcontentloaded' });
            } else {
                log(`[open#${i + 1} WARM] ${f.label}`);
                await page.evaluate((secret) => { location.hash = '#file=' + secret; },
                    ups[i].b64urlSecret);
            }
            const r = await waitVerified(page, prevHash, i === 0 ? 180000 : 90000);
            if (i > 0) {
                const tw = Date.now();
                while (Date.now() - tw < 3000 &&
                       !swMarks.slice(markStart).some(m => /SWITCHDOC\[.*\] complete|documentLoad:done|in-place reload (succeeded|returned)/.test(m.text)))
                    await sleep(50);
            }
            const wall = Date.now() - tStart;
            const myMarks = swMarks.slice(markStart);
            const inPlaceTried = myMarks.some(m => /inPlace:start/.test(m.text));
            const docLoad = myMarks.some(m => /documentLoad:start|documentLoad:about-to-call/.test(m.text));
            // The heavy SWITCHDOC_INPLACE_RC console trace was stripped before
            // ship; the kit's "in-place reload succeeded" LOG_INF goes to the
            // kit log, not the browser console. Classify in-place success from
            // the browser-visible SW_MARKs: an in-place attempt was made
            // (inPlace:done fired) and it did NOT fall through to documentLoad.
            const inPlaceDone = myMarks.some(m => /inPlace:done/.test(m.text));
            const inPlaceOk = inPlaceTried && inPlaceDone && !docLoad;
            const desired = (myMarks.find(m => /desiredType from type=/.test(m.text)) || {}).text || '';
            let path_;
            if (i === 0) path_ = 'cold-boot';
            else if (inPlaceOk) path_ = 'IN-PLACE (fast)';
            else if (docLoad) path_ = 'documentLoad (SLOW)';
            else path_ = 'unknown';

            results.push({
                label: f.label, openNum: i + 1, seqKey: SEQ[i],
                wallMs: wall, verifiedMs: r.ms, path: path_,
                inPlaceTried, inPlaceOk, docLoad, desired,
                canvasHash: r.canvasHash, status: r.statusText, err: r.error,
            });
            log(`  -> verified=${r.ms !== null ? (r.ms/1000).toFixed(2)+'s' : 'TIMEOUT'} wall=${(wall/1000).toFixed(2)}s path=${path_} status="${r.statusText}" hash=${r.canvasHash}`);
            for (const m of myMarks) if (/inPlace:(start|done)|documentLoad:(start|done)/.test(m.text)) log(`     mark: ${m.text}`);
            await sleep(400);
        }

        // ---- Correctness: edit works after the consecutive switches ----
        // Real keyboard input on the live canvas of the LAST opened doc.
        log('[edit-check] clicking canvas + typing via real keyboard on last doc');
        const beforeEdit = (await probe(page)).canvasHash;
        const fr = page.frames().find(ff => ff.url().includes('cool.html'));
        let editChanged = false;
        if (fr) {
            const box = await fr.evaluate(() => {
                const c = document.querySelector('canvas');
                if (!c) return null;
                const r = c.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 3, w: r.width, h: r.height };
            });
            if (box) {
                // double-click to enter a text region, then type
                await page.mouse.click(box.x, box.y);
                await sleep(150);
                await page.mouse.click(box.x, box.y, { clickCount: 2 });
                await sleep(300);
                await page.keyboard.type('Zx9', { delay: 80 });
                await sleep(900);
                const afterEdit = (await probe(page)).canvasHash;
                editChanged = afterEdit && beforeEdit && afterEdit !== beforeEdit;
                log(`[edit-check] beforeEdit=${beforeEdit} afterEdit=${afterEdit} changed=${editChanged}`);
            }
        }
        results._editChanged = editChanged;
    } finally {
        await cleanup();
    }

    console.log('\n========== MEASUREMENT TABLE ==========');
    console.log('open# | seq | fixture     | verified | wall    | path                 | slide-status');
    for (const r of results) {
        console.log(
            `  #${r.openNum}  |  ${r.seqKey}  | ${r.label.padEnd(11)} | ` +
            `${(r.verifiedMs !== null ? (r.verifiedMs/1000).toFixed(2)+'s' : 'TIMEOUT').padEnd(8)} | ` +
            `${(r.wallMs/1000).toFixed(2)+'s'.padEnd(6)} | ${r.path.padEnd(20)} | ${r.status}`);
    }
    console.log('=======================================');

    // Correctness: every distinct fixture must show a distinct canvas hash
    // (no stale bleed) and a matching slide-status.
    const warm = results.slice(1);
    const inPlaceCount = warm.filter(r => r.inPlaceOk).length;
    const docLoadCount = warm.filter(r => r.docLoad && !r.inPlaceOk).length;
    console.log(`\nWARM opens=${warm.length}  in-place=${inPlaceCount}  documentLoad=${docLoadCount}`);
    console.log(`edit-after-switch changed canvas: ${results._editChanged}`);

    // distinct-doc check: consecutive opens of DIFFERENT fixtures must
    // differ in canvas hash.
    let bleed = false;
    for (let i = 1; i < results.length; i++) {
        if (results[i].seqKey !== results[i - 1].seqKey &&
            results[i].canvasHash && results[i].canvasHash === results[i - 1].canvasHash) {
            console.log(`STALE-BLEED: open#${i+1} (${results[i].label}) has same canvas as prev different doc`);
            bleed = true;
        }
    }
    console.log(`stale-doc bleed detected: ${bleed}`);
    process.exit(0);
})().catch(e => { log('FATAL: ' + e.stack); process.exit(2); });
