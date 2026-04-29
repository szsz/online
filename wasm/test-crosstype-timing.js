// Cross-type hot-switch timing baseline.
//
// Opens writer-1, then switches via the viewer's recent-files click
// to xlsx (calc) and pptx (impress). Captures every SWITCHDOC[+Nms]
// mark from the kit, plus Module.__firstDocLoaded on each switch.
// Result table = phase-by-phase wall time so we know what to optimise
// in iters 2-10 of the speedup plan.
//
// Six transitions sweep:
//   writer-1 → calc       (cross-type)
//   calc     → impress    (cross-type)
//   impress  → writer-2   (cross-type, returns to a different writer)
//   writer-2 → writer-1   (same-type, in-place reload — control)
//   writer-1 → calc       (warm cross-type, factories cached)
//   calc     → impress    (warm cross-type)

const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

const FIXTURES = [
    { name: 'writer-1.docx', src: 'new.docx',         type: 'writer'  },
    { name: 'writer-2.docx', src: 'template.docx',    type: 'writer'  },
    { name: 'calc.xlsx',     src: 'testdoc.xlsx',     type: 'calc'    },
    { name: 'impress.pptx',  src: 'rare-fonts.pptx',  type: 'impress' },
];
const TRANSITIONS = [
    'writer-1.docx → calc.xlsx',
    'calc.xlsx → impress.pptx',
    'impress.pptx → writer-2.docx',
    'writer-2.docx → writer-1.docx',
    'writer-1.docx → calc.xlsx',
    'calc.xlsx → impress.pptx',
];

async function getStatusOk(page, type) {
    const fr = page.frames().find(f => f.url().includes('cool.html'));
    if (!fr) return false;
    return fr.evaluate((t) => {
        const wc = (document.querySelector('#StateWordCount')?.textContent || '');
        const dp = (document.querySelector('#StatusDocPos')?.textContent || '');
        const ss = (document.querySelector('#SlideStatus')?.textContent || '');
        if (t === 'writer')  return /character/.test(wc);
        if (t === 'calc')    return /Sheet \d+ of/i.test(dp);
        if (t === 'impress') return /Slide \d+ of/i.test(ss + dp);
        return false;
    }, type).catch(() => false);
}

(async () => {
    const DATA_DIR = path.join(__dirname, '..', 'test', 'data');
    const fileIds = {};
    for (const f of FIXTURES) {
        const bytes = fs.readFileSync(path.join(DATA_DIR, f.src));
        const up = await uploadV2(VIEWER, f.name, bytes);
        fileIds[f.name] = { fileId: up.fileId, secret: up.b64urlSecret, type: f.type };
        log(`Uploaded ${f.name} (${bytes.length}B) → ${up.fileId.substring(0,8)}…`);
    }

    const { browser, cleanup } = await launch();
    try {
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        // Per-transition timing table:
        //   { transition, totalWall, switchdocMarks: [{label, t}] }
        const records = [];
        let activeRecord = null;
        page.on('console', m => {
            const t = m.text();
            // Per-phase async marks: "SWITCHDOC[+1234ms] label"
            const sw = t.match(/SWITCHDOC\[\+(\d+)ms\]\s+(.+)/);
            if (sw && activeRecord) {
                activeRecord.switchdocMarks.push({
                    t: parseInt(sw[1], 10), label: sw[2].slice(0, 60),
                });
            }
            // Batched dump (Iter A1) — survives the documentLoad block:
            //   SWITCHDOC_TIMINGS_BEGIN\n[+0ms] entered\n...SWITCHDOC_TIMINGS_END
            if (t.includes('SWITCHDOC_TIMINGS_BEGIN') && activeRecord) {
                const lines = t.split('\n');
                for (const line of lines) {
                    const m2 = line.match(/^\[\+(\d+)ms\]\s+(.+)$/);
                    if (m2) {
                        activeRecord.switchdocMarks.push({
                            t: parseInt(m2[1], 10), label: m2[2].slice(0, 60),
                            batched: true,
                        });
                    }
                }
            }
            // Bridge-level "switchdoc_seen / _sent" — viewer-side trigger.
            const bridge = t.match(/bridge:(switchdoc_seen|switchdoc_sent)/);
            if (bridge && activeRecord && !activeRecord.bridgeAt) {
                activeRecord.bridgeAt = Date.now();
            }
        });

        // Seed recent files so the sidebar lists everything.
        const rf = Object.entries(fileIds).map(([n, v]) => ({
            fileId: v.fileId, cachedName: n, secret: v.secret,
            lastVisited: new Date().toISOString(),
        }));
        await page.evaluateOnNewDocument(list => {
            localStorage.setItem('rf_v1', JSON.stringify({ files: list }));
        }, rf);

        // Open with writer-1 in the URL fragment so prewarm + cold-load go straight to it.
        await page.goto(VIEWER + '/#file=' + fileIds['writer-1.docx'].secret,
            { waitUntil: 'domcontentloaded', timeout: 60000 });
        log('Page loaded');

        // Wait for writer-1 to verify (cold open).
        const coldStart = Date.now();
        for (let i = 0; i < 240; i++) {
            await sleep(500);
            if (await getStatusOk(page, 'writer')) {
                log(`Cold writer-1 verified in ${((Date.now()-coldStart)/1000).toFixed(1)}s`);
                break;
            }
        }

        // Run six transitions.
        for (const transition of TRANSITIONS) {
            const [from, to] = transition.split(' → ');
            const target = fileIds[to];
            log(`\n=== ${transition} ===`);

            activeRecord = {
                transition,
                startedAt: Date.now(),
                bridgeAt: null,
                switchdocMarks: [],
                verifiedMs: null,
            };

            await page.evaluate(secret => {
                location.hash = '#file=' + secret;
            }, target.secret);

            // Wait for the destination doc-type-specific status to fire.
            const verifyStart = Date.now();
            let verified = false;
            for (let i = 0; i < 240; i++) {
                await sleep(200);
                if (await getStatusOk(page, target.type)) {
                    verified = true;
                    activeRecord.verifiedMs = Date.now() - verifyStart;
                    break;
                }
            }
            if (!verified) {
                activeRecord.error = `TIMEOUT after ${((Date.now()-verifyStart)/1000).toFixed(0)}s`;
            }
            // Async SWITCHDOC marks queued during the documentLoad block
            // flush AFTER verify returns. Wait an extra 4 s to let them
            // arrive at the page.on('console') handler and accumulate
            // into activeRecord.switchdocMarks before we snapshot.
            await sleep(4000);
            log(`  verified in ${activeRecord.verifiedMs}ms`
              + (activeRecord.bridgeAt ? ` (bridge → verify = ${activeRecord.verifiedMs - (activeRecord.bridgeAt - activeRecord.startedAt)}ms)` : ''));
            log(`  switchdoc marks: ${activeRecord.switchdocMarks.length}`);
            for (const m of activeRecord.switchdocMarks) {
                log(`    [+${m.t}ms] ${m.label}${m.batched ? ' (batch)' : ''}`);
            }
            records.push(activeRecord);
            activeRecord = null;

            // Brief settle so the next switch starts from a stable point.
            await sleep(1500);
        }

        // ── Summary table ──────────────────────────────────────
        log('\n========== SUMMARY ==========');
        log('transition                                          verified(ms)  doc-load(ms)  init-render(ms)');
        for (const r of records) {
            const docLoad = r.switchdocMarks.find(m => m.label === 'documentLoad:done');
            const docLoadStart = r.switchdocMarks.find(m => m.label === 'documentLoad:start');
            const init = r.switchdocMarks.find(m => m.label === 'initializeForRendering:done');
            const setLOK = r.switchdocMarks.find(m => m.label === 'setLOKitDocument:done');
            const inPlace = r.switchdocMarks.find(m => m.label === 'inPlace:done');
            const docLoadMs = docLoad && docLoadStart ? docLoad.t - docLoadStart.t : null;
            const initMs = init && setLOK ? init.t - setLOK.t : null;
            const inPlaceStr = inPlace ? `(in-place ${inPlace.t}ms)` : '';
            log(`  ${r.transition.padEnd(50)} ${String(r.verifiedMs || '—').padStart(8)}    ${String(docLoadMs ?? '—').padStart(7)}    ${String(initMs ?? '—').padStart(7)}    ${inPlaceStr}`);
        }
    } finally {
        await cleanup();
    }
})().catch(e => { console.error('FATAL', e.stack); process.exit(2); });
