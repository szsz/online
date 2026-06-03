// Diagnostic: open A and B against the same room, A types a few chars,
// capture full relay logs from both. Goal: identify where A→B propagation
// breaks. NOT a checked test — pure observation.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const FIXTURE = path.join(__dirname, '..', 'test', 'data', 'new.docx');
const NAME = 'coedit-diag-' + Date.now() + '.docx';
const ROOM = 'coedit-diag-' + Date.now();
const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
const fileStorageUrl = encodeURIComponent(env.FILE_STORAGE_URL);
const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(NAME)}&relay=${relay}&access_token=test&fileStorageUrl=${fileStorageUrl}`;

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

async function getWc(page) {
    return await page.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent || '');
}
function chars(s) { const m = s && s.match(/(\d+) characters/); return m ? +m[1] : -1; }

(async () => {
    const { browser, cleanup } = await launch();
    try {
        // Upload fixture
        const fixtureBytes = fs.readFileSync(FIXTURE);
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'domcontentloaded' });
        await up.evaluate(async (base, n, a) => {
            await fetch(base + '/wasm/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, BASE, NAME, Array.from(fixtureBytes));
        await up.close();
        log(`Uploaded ${NAME}`);

        const aLogs = [], bLogs = [];
        function tagLogs(page, tag, sink) {
            page.on('console', m => {
                const t = m.text();
                if (/relay|processUI|remote client|queued|Flushing|replay|join|0x0|sendToKit|sendToRemoteClient|presence|Module|preinit/i.test(t)) {
                    const line = `[${((Date.now()-T0)/1000).toFixed(1)}s ${tag}] ${t.slice(0, 280)}`;
                    sink.push(line);
                    // Echo live for diagnosis. Otherwise everything's lost on timeout.
                    console.log(line);
                }
            });
            page.on('pageerror', e => {
                const line = `[${tag} pageerror] ${e.message}`;
                sink.push(line);
                console.log(line);
            });
        }

        async function openTab(label, sink) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            tagLogs(page, label, sink);
            try {
                await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
                await page.waitForFunction(() =>
                    document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
                    { timeout: 90000 });
                log(`[${label}] loaded: "${await getWc(page)}"`);
            } catch (e) {
                log(`[${label}] LOAD FAILED: ${e.message}`);
                // Best-effort dump of what we got so far before bubbling up
                const wc = await getWc(page).catch(() => '(unavailable)');
                log(`[${label}] last #StateWordCount: "${wc}"`);
                throw e;
            }
            return page;
        }

        const pageA = await openTab('A', aLogs);
        await sleep(8000);
        const pageB = await openTab('B', bLogs);
        await sleep(15000); // settle late-join

        log(`Initial: A=${chars(await getWc(pageA))} B=${chars(await getWc(pageB))}`);

        // ── A clicks the canvas, types XYZ ─────────────────────
        log('--- A types XYZ ---');
        const fr = pageA.frames().find(f => f.url().includes('cool.html')) || pageA;
        const cv = await pageA.$('#editor-frame') || await pageA.$('canvas');
        if (cv) {
            const box = await cv.boundingBox();
            await pageA.mouse.click(box.x + box.width/2, box.y + Math.min(box.height*0.55, 450));
        }
        await sleep(500);
        await pageA.keyboard.press('End').catch(()=>{});
        await sleep(200);
        const beforeA = chars(await getWc(pageA));
        const beforeB = chars(await getWc(pageB));
        log(`Pre-type: A=${beforeA} B=${beforeB}`);

        // Type with small delays so each keystroke shows up as a separate frame
        for (const c of 'XYZ') {
            await pageA.keyboard.type(c);
            await sleep(120);
        }
        await sleep(3000);
        const afterA = chars(await getWc(pageA));
        const afterB = chars(await getWc(pageB));
        log(`Post A-type: A=${afterA} (Δ${afterA-beforeA}) B=${afterB} (Δ${afterB-beforeB})`);

        // ── Now B types: tests B→A propagation ────────────────
        log('--- B types END ---');
        const cvB = await pageB.$('#editor-frame') || await pageB.$('canvas');
        if (cvB) {
            const box = await cvB.boundingBox();
            await pageB.mouse.click(box.x + box.width/2, box.y + Math.min(box.height*0.55, 450));
        }
        await sleep(500);
        await pageB.keyboard.press('End').catch(()=>{});
        await sleep(200);
        const beforeBtype_A = chars(await getWc(pageA));
        const beforeBtype_B = chars(await getWc(pageB));
        log(`Pre B-type: A=${beforeBtype_A} B=${beforeBtype_B}`);
        for (const c of 'END') {
            await pageB.keyboard.type(c);
            await sleep(120);
        }
        await sleep(3000);
        const post_A = chars(await getWc(pageA));
        const post_B = chars(await getWc(pageB));
        log(`Post B-type @+3s: A=${post_A} (Δ${post_A-beforeBtype_A}) B=${post_B} (Δ${post_B-beforeBtype_B})`);
        // Wait up to 180s for A's remote client for B to become ready.
        // Print every 30s.
        for (let i = 1; i <= 6; i++) {
            await sleep(30000);
            const ai = chars(await getWc(pageA));
            log(`Post B-type @+${i*30}s: A=${ai} (Δ${ai-beforeBtype_A}) B=${chars(await getWc(pageB))}`);
            if (ai > beforeBtype_A) break;
        }

        // ── Dump captured logs ────────────────────────────────
        log('=== A logs (last 60) ===');
        for (const l of aLogs.slice(-60)) console.log(l);
        log('=== B logs (last 60) ===');
        for (const l of bLogs.slice(-60)) console.log(l);
    } finally {
        await cleanup();
    }
})().catch(e => { console.error('FATAL', e.stack); process.exit(2); });
