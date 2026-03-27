// Stress test: late join co-editing
// Phase 1: A opens doc, types ALPHA
// Phase 2: B late-joins, gets saved state, types BETA
// Phase 3: C late-joins while A+B active, types GAMMA
// Phase 4: A leaves, D late-joins, types DELTA
// All remaining browsers must converge to identical char count.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-latejoin';
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
    const filename = `${String(++shotNum).padStart(2,'0')}_${elapsed()}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    log(`[snap] ${filename}`);
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

async function waitForReady(page, label, count) {
    log(`[${label}] Waiting for ${count} remote client(s)...`);
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
        const logs = await page.evaluate(() => window._logs ? window._logs.filter(l =>
            l.includes(') ready')
        ) : []);
        if (logs.length >= count) {
            log(`[${label}] ${count} client(s) ready (${((Date.now()-t0)/1000).toFixed(1)}s)`);
            return true;
        }
        await sleep(2000);
    }
    log(`[${label}] Timeout waiting for remote clients`);
    return false;
}

// Wait for char count to reach or exceed expected on at least one page
async function waitForChars(pages, expected, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        for (const [label, page] of pages) {
            const s = await getStatus(page);
            if (charCount(s) >= expected) return true;
        }
        await sleep(1000);
    }
    return false;
}

(async () => {
    log('=== Stress test: late join co-editing ===');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    // Upload docx
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
        if (condition) { log(`✓ ${label}`); }
        else { log(`✗ FAIL: ${label}`); allPassed = false; }
    }

    // Use a persistent room for the entire test
    const ROOM = 'latejoin-' + Date.now();
    const relay = encodeURIComponent(`wss://wasm.atgpartners.info:9091/room/${ROOM}`);
    const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOC_NAME)}&relay=${relay}&access_token=test`;

    async function openDoc(label) {
        for (let attempt = 1; attempt <= 3; attempt++) {
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
                const t0 = Date.now();
                await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
                await page.waitForFunction(() => {
                    const el = document.querySelector('#StateWordCount');
                    return el && el.textContent && el.textContent.includes('characters');
                }, { timeout: TIMEOUT });
                const dur = ((Date.now() - t0) / 1000).toFixed(1);
                log(`[${label}] Loaded in ${dur}s: "${await getStatus(page)}"`);
                return page;
            } catch (e) {
                log(`[${label}] Attempt ${attempt} failed: ${e.message}`);
                await page.close();
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
            await sleep(2000);
        }
        await sleep(5000);
    }

    try {
        // Upload
        log('Uploading ' + DOC_NAME);
        const up = await browser.newPage();
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        const docBytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (url, name, arr) => {
            await fetch(url + '/wasm/' + encodeURIComponent(name), {
                method: 'POST',
                body: new Blob([new Uint8Array(arr)])
            });
        }, BASE, DOC_NAME, Array.from(docBytes));
        await up.close();
        log('Uploaded');

        // ===== PHASE 1: A opens, types ALPHA =====
        log('\n===== Phase 1: A opens first, types ALPHA =====');
        const pageA = await openDoc('A');
        const initChars = charCount(await getStatus(pageA));
        log(`Initial doc: ${initChars} chars`);
        await snap(pageA, 'A_initial');

        // No remote clients needed for first browser (no one else)
        await sleep(5000);

        await typeText(pageA, 'A', 'ALPHA');
        await sleep(10000);
        const afterAlpha = charCount(await getStatus(pageA));
        await snap(pageA, 'A_after_ALPHA');
        log(`After ALPHA: A=${afterAlpha} (expected ${initChars + 5})`);
        check('ALPHA inserted', afterAlpha === initChars + 5);

        // ===== PHASE 2: B late-joins, types BETA =====
        log('\n===== Phase 2: B late-joins =====');
        const pageB = await openDoc('B');
        const bChars = charCount(await getStatus(pageB));
        await snap(pageB, 'B_initial');
        log(`B loaded: ${bChars} chars`);
        check('B got saved state from A', bChars >= afterAlpha);

        // Wait for remote clients (B sees A)
        await waitForReady(pageB, 'B', 1);
        await waitForReady(pageA, 'A', 1);
        await sleep(5000);

        await typeText(pageB, 'B', 'BETA');
        await sleep(20000);
        const aAfterBeta = charCount(await getStatus(pageA));
        const bAfterBeta = charCount(await getStatus(pageB));
        await snap(pageA, 'A_after_BETA');
        await snap(pageB, 'B_after_BETA');
        log(`After BETA: A=${aAfterBeta} B=${bAfterBeta}`);
        check('A and B same count after BETA', aAfterBeta === bAfterBeta);

        // ===== PHASE 3: C late-joins while A+B active =====
        log('\n===== Phase 3: C late-joins =====');
        const pageC = await openDoc('C');
        const cChars = charCount(await getStatus(pageC));
        await snap(pageC, 'C_initial');
        log(`C loaded: ${cChars} chars`);
        check('C got saved state from A or B', cChars >= afterAlpha + 4);

        await waitForReady(pageC, 'C', 2);
        await sleep(5000);

        await typeText(pageC, 'C', 'GAMMA');
        await sleep(15000);
        const aAfterGamma = charCount(await getStatus(pageA));
        const bAfterGamma = charCount(await getStatus(pageB));
        const cAfterGamma = charCount(await getStatus(pageC));
        await snap(pageA, 'A_after_GAMMA');
        await snap(pageB, 'B_after_GAMMA');
        await snap(pageC, 'C_after_GAMMA');
        log(`After GAMMA: A=${aAfterGamma} B=${bAfterGamma} C=${cAfterGamma}`);
        check('A, B, C same count after GAMMA', aAfterGamma === bAfterGamma && bAfterGamma === cAfterGamma);

        // ===== PHASE 4: A leaves, D late-joins =====
        log('\n===== Phase 4: A leaves, D late-joins =====');
        await pageA.close();
        log('A closed');
        await sleep(5000);

        const pageD = await openDoc('D');
        const dChars = charCount(await getStatus(pageD));
        await snap(pageD, 'D_initial');
        log(`D loaded: ${dChars} chars`);
        check('D got saved state', dChars >= afterAlpha + 9);

        await waitForReady(pageD, 'D', 2);
        await sleep(5000);

        await typeText(pageD, 'D', 'DELTA');
        await sleep(15000);
        const bAfterDelta = charCount(await getStatus(pageB));
        const cAfterDelta = charCount(await getStatus(pageC));
        const dAfterDelta = charCount(await getStatus(pageD));
        await snap(pageB, 'B_after_DELTA');
        await snap(pageC, 'C_after_DELTA');
        await snap(pageD, 'D_after_DELTA');
        log(`After DELTA: B=${bAfterDelta} C=${cAfterDelta} D=${dAfterDelta}`);
        check('B, C, D same count after DELTA', bAfterDelta === cAfterDelta && cAfterDelta === dAfterDelta);

        // Final
        await snap(pageB, 'B_final');
        await snap(pageC, 'C_final');
        await snap(pageD, 'D_final');
        log(`\nFinal: B=${bAfterDelta} C=${cAfterDelta} D=${dAfterDelta}`);

        log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
