// Test: 3 browsers co-edit "test document.docx"
// Screenshots every second during load, timestamps on everything.
// Each browser types at a different position in the document.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-docx';
const DOC_NAME = 'test document.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', DOC_NAME);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
function log(msg) { console.log(`[${elapsed()}] ${msg}`); }

let shotNum = 0;
let lastSnapTime = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const now = Date.now();
    const diff = lastSnapTime ? ((now - lastSnapTime) / 1000).toFixed(1) : '0.0';
    lastSnapTime = now;
    const filename = `${String(++shotNum).padStart(2, '0')}_${elapsed()}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    log(`[snap] ${filename} (+${diff}s)`);
    return filename;
}

async function getStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}

function charCount(status) {
    const m = status.match(/([\d,]+) characters/);
    return m ? parseInt(m[1].replace(/,/g, '')) : -1;
}

async function waitForReady(page, label, count, screenshotDuringWait) {
    log(`[${label}] Waiting for ${count} remote client(s)...`);
    const t0 = Date.now();
    let lastScreenshot = 0;
    while (Date.now() - t0 < 180000) {
        const logs = await page.evaluate(() => window._logs ? window._logs.filter(l =>
            l.includes(') ready')
        ) : []);
        if (logs.length >= count) {
            const dur = ((Date.now() - t0) / 1000).toFixed(1);
            log(`[${label}] ${count} client(s) ready (${dur}s)`);
            return true;
        }
        // Screenshot every second during wait
        if (screenshotDuringWait && Date.now() - lastScreenshot > 1000) {
            await snap(page, `${label}_loading`);
            lastScreenshot = Date.now();
        }
        await sleep(500);
    }
    log(`[${label}] Timeout waiting for remote clients`);
    return false;
}

(async () => {
    log('=== Test: 3 browsers co-edit docx ===');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Upload the docx
    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: ' + DOC_PATH + ' not found');
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    let allPassed = true;
    function check(label, condition) {
        if (condition) {
            log(`✓ ${label}`);
        } else {
            log(`✗ FAIL: ${label}`);
            allPassed = false;
        }
    }

    try {
        // Upload docx via HTTP POST
        log('Uploading ' + DOC_NAME + ' (' + fs.statSync(DOC_PATH).size + ' bytes)');
        const up = await browser.newPage();
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        const docBytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (url, name, bytesArr) => {
            const bytes = new Uint8Array(bytesArr);
            await fetch(url + '/wasm/' + encodeURIComponent(name), {
                method: 'POST',
                body: new Blob([bytes], { type: 'application/octet-stream' }),
            });
        }, BASE, DOC_NAME, Array.from(docBytes));
        await up.close();
        log('Uploaded');

        let ROOM = 'docx-' + Date.now();
        let relay = encodeURIComponent(`wss://wasm.atgpartners.info:9091/room/${ROOM}`);
        let coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOC_NAME)}&relay=${relay}&access_token=test`;

        async function openDoc(label, retries) {
            retries = retries || 3;
            for (let attempt = 1; attempt <= retries; attempt++) {
                const page = await browser.newPage();
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
                    const loadStart = Date.now();

                    await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

                    // Screenshot every second while waiting for WASM to load
                    let loaded = false;
                    const loadTimeout = Date.now() + TIMEOUT;
                    while (Date.now() < loadTimeout) {
                        const ready = await page.evaluate(() => {
                            const el = document.querySelector('#StateWordCount');
                            return el && el.textContent && el.textContent.includes('characters');
                        });
                        if (ready) { loaded = true; break; }
                        await snap(page, `${label}_load`);
                        await sleep(1000);
                    }
                    if (!loaded) throw new Error('Load timeout');

                    const loadDur = ((Date.now() - loadStart) / 1000).toFixed(1);
                    log(`[${label}] Loaded in ${loadDur}s: "${await getStatus(page)}"`);
                    await snap(page, `${label}_loaded`);
                    return page;
                } catch (e) {
                    log(`[${label}] Attempt ${attempt} failed: ${e.message}`);
                    await page.close();
                    if (attempt === retries) throw e;
                    await sleep(5000);
                }
            }
        }

        // Open all 3 with fresh-room retry.
        // WASM+relay load has ~30% failure rate per browser (race in init hooking).
        // Retry each individual browser, keeping the room the same.
        let pageA, pageB, pageC;
        for (let roomAttempt = 1; roomAttempt <= 3; roomAttempt++) {
            try {
                ROOM = 'docx-' + Date.now();
                relay = encodeURIComponent(`wss://wasm.atgpartners.info:9091/room/${ROOM}`);
                coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOC_NAME)}&relay=${relay}&access_token=test`;
                log(`Room attempt ${roomAttempt}: ${ROOM}`);
                pageA = await openDoc('A', 3);
                await sleep(10000);
                pageB = await openDoc('B', 3);
                await sleep(10000);
                pageC = await openDoc('C', 3);
                break;
            } catch (e) {
                log(`Room ${roomAttempt} failed: ${e.message}`);
                try { if (pageA) await pageA.close(); } catch (x) {}
                try { if (pageB) await pageB.close(); } catch (x) {}
                try { if (pageC) await pageC.close(); } catch (x) {}
                pageA = pageB = pageC = null;
                await sleep(5000);
            }
        }
        if (!pageA || !pageB || !pageC) throw new Error('Could not open all 3 browsers');

        await sleep(10000);
        const initA = await getStatus(pageA);
        const initB = await getStatus(pageB);
        const initC = await getStatus(pageC);
        log(`Initial: A="${initA}" B="${initB}" C="${initC}"`);
        check('All browsers loaded same doc', charCount(initA) === charCount(initB) && charCount(initB) === charCount(initC));
        const initialChars = charCount(initA);
        log(`Document has ${initialChars} characters`);

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        await snap(pageC, 'C_initial');

        // Wait for remote clients (3 per browser)
        log('--- Waiting for remote clients ---');
        const readyA = await waitForReady(pageA, 'A', 3, true);
        const readyB = await waitForReady(pageB, 'B', 3, false);
        const readyC = await waitForReady(pageC, 'C', 3, false);
        if (!readyA || !readyB || !readyC) {
            log('ERROR: Not all remote clients ready');
            // Dump logs
            for (const [label, page] of [['A', pageA], ['B', pageB], ['C', pageC]]) {
                const logs = await page.evaluate(() => window._logs.filter(l => l.includes('[relay]')));
                log(`--- ${label} relay logs ---`);
                logs.forEach(l => log('  ' + l));
            }
            throw new Error('Not ready');
        }

        log('=== All ready. Typing starts. ===');
        await sleep(2000);

        // Phase 1: A types "ALPHA" at start (Ctrl+Home)
        log('[A] Ctrl+Home');
        await pageA.evaluate(() => {
            globalThis.TheFakeWebSocket.send('key type=input char=0 key=9220');
            globalThis.TheFakeWebSocket.send('key type=up char=0 key=9220');
        });
        await sleep(2000);

        log('[A] Typing "ALPHA"...');
        for (const ch of 'ALPHA') {
            await pageA.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            await sleep(2000);
        }
        await sleep(8000);
        await snap(pageA, 'A_after_ALPHA');
        await snap(pageB, 'B_after_ALPHA');
        await snap(pageC, 'C_after_ALPHA');
        const afterAlpha = initialChars + 5;
        let sA = await getStatus(pageA);
        let sB = await getStatus(pageB);
        let sC = await getStatus(pageC);
        log(`After ALPHA: A="${sA}" B="${sB}" C="${sC}"`);
        check(`All at ${afterAlpha} after ALPHA`,
            charCount(sA) === afterAlpha && charCount(sB) === afterAlpha && charCount(sC) === afterAlpha);

        // Phase 2: B types "BETA" at end (Ctrl+End)
        log('[B] Ctrl+End');
        await pageB.evaluate(() => {
            globalThis.TheFakeWebSocket.send('key type=input char=0 key=9221');
            globalThis.TheFakeWebSocket.send('key type=up char=0 key=9221');
        });
        await sleep(5000); // longer wait for large doc cursor navigation

        log('[B] Typing "BETA"...');
        for (const ch of 'BETA') {
            await pageB.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            await sleep(2000);
        }
        await sleep(15000);
        await snap(pageA, 'A_after_BETA');
        await snap(pageB, 'B_after_BETA');
        await snap(pageC, 'C_after_BETA');
        const afterBeta = afterAlpha + 4;
        sA = await getStatus(pageA);
        sB = await getStatus(pageB);
        sC = await getStatus(pageC);
        log(`After BETA: A="${sA}" B="${sB}" C="${sC}"`);
        check(`All at ${afterBeta} after BETA`,
            charCount(sA) === afterBeta && charCount(sB) === afterBeta && charCount(sC) === afterBeta);

        // Phase 3: C clicks somewhere in the middle and types "GAMMA"
        log('[C] Click middle of page');
        await pageC.evaluate(() => {
            globalThis.TheFakeWebSocket.send('mouse type=buttondown x=3000 y=5000 count=1 buttons=1 modifier=0');
            globalThis.TheFakeWebSocket.send('mouse type=buttonup x=3000 y=5000 count=1 buttons=1 modifier=0');
        });
        await sleep(2000);

        log('[C] Typing "GAMMA"...');
        for (const ch of 'GAMMA') {
            await pageC.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            await sleep(2000);
        }
        await sleep(8000);
        await snap(pageA, 'A_after_GAMMA');
        await snap(pageB, 'B_after_GAMMA');
        await snap(pageC, 'C_after_GAMMA');
        const afterGamma = afterBeta + 5;
        sA = await getStatus(pageA);
        sB = await getStatus(pageB);
        sC = await getStatus(pageC);
        log(`After GAMMA: A="${sA}" B="${sB}" C="${sC}"`);
        check(`All at ${afterGamma} after GAMMA`,
            charCount(sA) === afterGamma && charCount(sB) === afterGamma && charCount(sC) === afterGamma);

        // Final
        log('Final settle (10s)...');
        await sleep(10000);
        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');
        await snap(pageC, 'C_final');
        sA = await getStatus(pageA);
        sB = await getStatus(pageB);
        sC = await getStatus(pageC);
        log(`Final: A="${sA}" B="${sB}" C="${sC}"`);
        check('All browsers identical char count',
            charCount(sA) === charCount(sB) && charCount(sB) === charCount(sC));
        check(`Final count is ${afterGamma}`, charCount(sA) === afterGamma);

        log(allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED');

    } catch (e) {
        log('Error: ' + e.message);
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
