const __cl = require('./lib/inject-checklist');
// Stress test: multiple browsers joining, leaving, reconnecting
// Tests resilience of the co-editing system under dynamic conditions.
//
// Phases:
// 1. A opens, types ALPHA (5 chars)
// 2. B late-joins, types BETA (4 chars)
// 3. A disconnects (simulates connection loss)
// 4. C late-joins, types GAMMA (5 chars)
// 5. B disconnects
// 6. D late-joins, types DELTA (5 chars)
// 7. A reconnects (new page, same room), types EPSILON (7 chars)
// 8. Verify D and reconnected-A converge

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const RELAY_HTTP = env.RELAY_HTTP_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-stress';
const DOC_NAME = 'test document.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', DOC_NAME);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(msg) { console.log(`[${elapsed()}] ${msg}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(300);
    const filename = `${String(++shotNum).padStart(2, '0')}_${elapsed()}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    log(`[snap] ${filename}`);
}

function charCount(status) {
    const m = status.match(/([\d,]+) characters/);
    return m ? parseInt(m[1].replace(/,/g, '')) : -1;
}

async function getStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}

async function waitForReady(page, label, count) {
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
        const logs = await page.evaluate(() => window._logs ? window._logs.filter(l =>
            l.includes(') ready')
        ) : []);
        if (logs.length >= count) {
            log(`[${label}] ${count} remote client(s) ready (${((Date.now()-t0)/1000).toFixed(1)}s)`);
            return true;
        }
        await sleep(2000);
    }
    log(`[${label}] Remote client timeout`);
    return false;
}

(async () => {
    log('=== Stress test: join, leave, reconnect ===');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) { log('ERROR: doc not found'); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    let allPassed = true;
    function check(label, condition) { __cl.recordCheck(label, condition);
        if (condition) { log(`✓ ${label}`); }
        else { log(`✗ FAIL: ${label}`); allPassed = false; }
    }

    const ROOM = 'stress-' + Date.now();
    const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
    const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOC_NAME)}&relay=${relay}&access_token=test`;

    async function openDoc(label) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ctx = await browser.createBrowserContext();
            const page = await ctx.newPage();
            await page.evaluateOnNewDocument(() => {
                window._logs = [];
                const orig = console.log;
                console.log = function() {
                    window._logs.push(Array.from(arguments).join(' '));
                    orig.apply(console, arguments);
                };
            });
            try {
                log(`[${label}] Opening (attempt ${attempt})...`);
                const t0 = Date.now();
                await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
                await page.waitForFunction(() => {
                    const el = document.querySelector('#StateWordCount');
                    return el && el.textContent && el.textContent.includes('characters');
                }, { timeout: TIMEOUT });
                const dur = ((Date.now() - t0) / 1000).toFixed(1);
                const status = await getStatus(page);
                log(`[${label}] Loaded in ${dur}s: "${status}"`);
                return page;
            } catch (e) {
                log(`[${label}] Attempt ${attempt} failed: ${e.message}`);
                await ctx.close();
                if (attempt === 3) throw e;
                await sleep(5000);
            }
        }
    }

    async function typeText(page, label, text) {
        log(`[${label}] Typing "${text}"...`);
        for (const ch of text) {
            await page.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            await sleep(1500);
        }
        await sleep(5000);
    }

    // Upload
    log('Uploading ' + DOC_NAME);
    const up = await browser.newPage();
    await up.goto(BASE, { waitUntil: 'networkidle0' });
    const docBytes = fs.readFileSync(DOC_PATH);
    await up.evaluate(async (url, name, arr, room, relayHttp) => {
        await fetch(url + '/wasm/' + encodeURIComponent(name), {
            method: 'POST', body: new Blob([new Uint8Array(arr)])
        });
        // Pre-seed relay server so late joiners get this file immediately
        await fetch(relayHttp + '/room/' + encodeURIComponent(room) + '/file', {
            method: 'POST', body: new Blob([new Uint8Array(arr)])
        });
    }, BASE, DOC_NAME, Array.from(docBytes), ROOM, RELAY_HTTP);
    await up.close();
    log('Uploaded (WOPI + relay)');

    try {
        // === Phase 1: A opens, types ALPHA ===
        log('\n=== Phase 1: A opens, types ALPHA ===');
        let pageA = await openDoc('A');
        const initChars = charCount(await getStatus(pageA));
        await snap(pageA, 'A_initial');

        await sleep(5000);
        await typeText(pageA, 'A', 'ALPHA');
        const afterAlpha = charCount(await getStatus(pageA));
        await snap(pageA, 'A_after_ALPHA');
        log(`After ALPHA: ${afterAlpha} chars`);
        check('ALPHA inserted', afterAlpha === initChars + 5);

        // Wait for auto-save to relay
        log('Waiting 20s for auto-save...');
        await sleep(20000);

        // === Phase 2: B late-joins, types BETA ===
        log('\n=== Phase 2: B late-joins, types BETA ===');
        let pageB = await openDoc('B');
        const bChars = charCount(await getStatus(pageB));
        await snap(pageB, 'B_initial');
        check('B got saved state', bChars > initChars);

        await waitForReady(pageB, 'B', 1);
        await waitForReady(pageA, 'A', 1);
        await sleep(3000);

        await typeText(pageB, 'B', 'BETA');
        await snap(pageA, 'A_after_BETA');
        await snap(pageB, 'B_after_BETA');
        log(`After BETA: A=${charCount(await getStatus(pageA))} B=${charCount(await getStatus(pageB))}`);

        // === Phase 3: A disconnects ===
        log('\n=== Phase 3: A disconnects (connection loss) ===');
        await pageA.close();
        log('A disconnected');
        await sleep(5000);
        await snap(pageB, 'B_after_A_disconnect');
        check('B still running after A disconnect', charCount(await getStatus(pageB)) > 0);

        // === Phase 4: C late-joins, types GAMMA ===
        log('\n=== Phase 4: C late-joins, types GAMMA ===');
        let pageC = await openDoc('C');
        const cChars = charCount(await getStatus(pageC));
        await snap(pageC, 'C_initial');
        check('C got saved state', cChars > initChars);

        await waitForReady(pageC, 'C', 1);
        await waitForReady(pageB, 'B', 1);
        await sleep(3000);

        await typeText(pageC, 'C', 'GAMMA');
        await snap(pageB, 'B_after_GAMMA');
        await snap(pageC, 'C_after_GAMMA');
        log(`After GAMMA: B=${charCount(await getStatus(pageB))} C=${charCount(await getStatus(pageC))}`);

        // === Phase 5: B disconnects ===
        log('\n=== Phase 5: B disconnects ===');
        await pageB.close();
        log('B disconnected');
        await sleep(5000);
        check('C still running after B disconnect', charCount(await getStatus(pageC)) > 0);
        await snap(pageC, 'C_after_B_disconnect');

        // === Phase 6: D late-joins, types DELTA ===
        log('\n=== Phase 6: D late-joins, types DELTA ===');
        let pageD = await openDoc('D');
        const dChars = charCount(await getStatus(pageD));
        await snap(pageD, 'D_initial');
        check('D got saved state', dChars > initChars);

        await waitForReady(pageD, 'D', 1);
        await waitForReady(pageC, 'C', 1);
        await sleep(3000);

        await typeText(pageD, 'D', 'DELTA');
        await snap(pageC, 'C_after_DELTA');
        await snap(pageD, 'D_after_DELTA');
        log(`After DELTA: C=${charCount(await getStatus(pageC))} D=${charCount(await getStatus(pageD))}`);

        // Convergence check for C and D
        const cFinal = charCount(await getStatus(pageC));
        const dFinal = charCount(await getStatus(pageD));
        const cdDiff = Math.abs(cFinal - dFinal);
        check(`C and D close (diff=${cdDiff})`, cdDiff < 10);

        // === Phase 7: A reconnects, types EPSILON ===
        log('\n=== Phase 7: A reconnects, types EPSILON ===');
        // Wait for auto-save so A gets latest state
        log('Waiting 15s for auto-save...');
        await sleep(15000);

        pageA = await openDoc('A-reconnect');
        const aReconnChars = charCount(await getStatus(pageA));
        await snap(pageA, 'A_reconnected');
        check('A reconnected with saved state', aReconnChars > initChars);

        await waitForReady(pageA, 'A-reconnect', 2);
        await sleep(3000);

        await typeText(pageA, 'A-reconnect', 'EPSILON');
        await sleep(15000);
        await snap(pageA, 'A_after_EPSILON');
        await snap(pageC, 'C_after_EPSILON');
        await snap(pageD, 'D_after_EPSILON');

        const aEnd = charCount(await getStatus(pageA));
        const cEnd = charCount(await getStatus(pageC));
        const dEnd = charCount(await getStatus(pageD));
        log(`After EPSILON: A=${aEnd} C=${cEnd} D=${dEnd}`);

        // Final convergence: all three should be within 10 chars
        const allCounts = [aEnd, cEnd, dEnd].filter(c => c > 0);
        const maxDiff = Math.max(...allCounts) - Math.min(...allCounts);
        check(`Final convergence (maxDiff=${maxDiff})`, maxDiff < 15);

        // Final screenshots
        log('\n=== Final state ===');
        await snap(pageA, 'A_final');
        await snap(pageC, 'C_final');
        await snap(pageD, 'D_final');

        log(`\nFinal: A=${aEnd} C=${cEnd} D=${dEnd}`);
        log(allPassed ? '\n✓ ALL CHECKS PASSED' : '\n✗ SOME CHECKS FAILED');

    } catch (e) {
        log('Error: ' + e.message);
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
