// Test 3: 3 browsers co-editing via relay
// Document: "Hello World" (1 line)
// A types "ABC" at start, B types "XYZ" at end, C types "PQR" in middle
// Expected: "ABCHelloPQR WorldXYZ" = 20 chars
// All input goes through relay. Sequential phases with convergence waits.
const puppeteer = require('puppeteer');
const fs = require('fs');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots3';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    console.log(`  [snap] ${filename}`);
}

async function getStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}

function charCount(status) {
    const m = status.match(/(\d+) characters/);
    return m ? parseInt(m[1]) : -1;
}

async function waitForReady(page, label, count) {
    console.log(`[${label}] Waiting for ${count} remote client(s)...`);
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
        const logs = await page.evaluate(() => window._logs ? window._logs.filter(l =>
            l.includes(') ready')
        ) : []);
        if (logs.length >= count) {
            console.log(`[${label}] ${count} client(s) ready (${((Date.now()-t0)/1000).toFixed(1)}s)`);
            return true;
        }
        await sleep(2000);
        process.stdout.write('.');
    }
    console.log(`\n[${label}] Timeout`);
    return false;
}

// Wait until at least one page shows expected chars
async function waitForAnyCharCount(pages, expected, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        for (const p of pages) {
            const s = await getStatus(p);
            if (charCount(s) === expected) return true;
        }
        await sleep(500);
    }
    return false;
}

(async () => {
    console.log('=== Test 3: 3 Browsers, 1 line, ABC/PQR/XYZ ===\n');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    let allPassed = true;
    function check(label, condition) {
        if (condition) {
            console.log(`  ✓ ${label}`);
        } else {
            console.log(`  ✗ FAIL: ${label}`);
            allPassed = false;
        }
    }

    try {
        // Upload
        const up = await browser.newPage();
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        await up.evaluate(async (url) => {
            await fetch(url + '/wasm/test3.txt', {
                method: 'POST',
                body: new Blob(['Hello World'], { type: 'application/octet-stream' }),
            });
        }, BASE);
        await up.close();
        console.log('[setup] Uploaded "Hello World"\n');

        let ROOM = 'test3-' + Date.now();
        let relay = encodeURIComponent(`wss://wasm.atgpartners.info:9091/room/${ROOM}`);
        let coolUrl = `${BASE}/browser/cool.html?WOPISrc=test3.txt&relay=${relay}&access_token=test`;

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
                    console.log(`[${label}] Opening (attempt ${attempt})...`);
                    await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
                    await page.waitForFunction(() => {
                        const el = document.querySelector('#StateWordCount');
                        return el && el.textContent && el.textContent.includes('characters');
                    }, { timeout: TIMEOUT });
                    console.log(`[${label}] Loaded: "${await getStatus(page)}"`);
                    return page;
                } catch(e) {
                    console.log(`[${label}] Attempt ${attempt} failed: ${e.message}`);
                    await page.close();
                    if (attempt === retries) throw e;
                    await sleep(5000);
                }
            }
        }

        // Open all 3 browsers. If any fails, restart all with a fresh room.
        let pageA, pageB, pageC;
        for (let roomAttempt = 1; roomAttempt <= 3; roomAttempt++) {
            try {
                ROOM = 'test3-' + Date.now();
                relay = encodeURIComponent(`wss://wasm.atgpartners.info:9091/room/${ROOM}`);
                coolUrl = `${BASE}/browser/cool.html?WOPISrc=test3.txt&relay=${relay}&access_token=test`;
                console.log(`\n--- Room attempt ${roomAttempt}: ${ROOM} ---`);
                pageA = await openDoc('A', 1);
                await sleep(10000);
                pageB = await openDoc('B', 1);
                await sleep(10000);
                pageC = await openDoc('C', 1);
                break;
            } catch(e) {
                console.log(`Room attempt ${roomAttempt} failed, retrying with fresh room...`);
                try { if (pageA) await pageA.close(); } catch(x) {}
                try { if (pageB) await pageB.close(); } catch(x) {}
                try { if (pageC) await pageC.close(); } catch(x) {}
                pageA = pageB = pageC = null;
                await sleep(5000);
            }
        }
        if (!pageA || !pageB || !pageC) throw new Error('Could not open all 3 browsers');
        await sleep(15000);

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        await snap(pageC, 'C_initial');
        check('Initial: all 11 chars',
            charCount(await getStatus(pageA)) === 11 &&
            charCount(await getStatus(pageB)) === 11 &&
            charCount(await getStatus(pageC)) === 11);

        // 3 browsers = 3 viewIds. Each browser creates 3 remote clients (including own).
        console.log('\n--- Waiting for remote clients ---');
        const readyA = await waitForReady(pageA, 'A', 2);
        const readyB = await waitForReady(pageB, 'B', 2);
        const readyC = await waitForReady(pageC, 'C', 2);
        if (!readyA || !readyB || !readyC) throw new Error('Not all ready');

        console.log('\n=== Phase 1: A types ABC at start (default cursor pos 0) ===\n');
        await sleep(2000);

        for (const ch of ['A', 'B', 'C']) {
            console.log(`[A] Types "${ch}"...`);
            await pageA.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            await sleep(8000);
            const expected = 11 + 'ABC'.indexOf(ch) + 1;
            await waitForAnyCharCount([pageA, pageB, pageC], expected, 5000);
            const sA = await getStatus(pageA);
            const sB = await getStatus(pageB);
            const sC = await getStatus(pageC);
            console.log(`  A="${sA}" B="${sB}" C="${sC}"`);
        }

        // Convergence
        console.log('\n[wait] 10s convergence...');
        await sleep(10000);
        await snap(pageA, 'A_after_ABC');
        await snap(pageB, 'B_after_ABC');
        await snap(pageC, 'C_after_ABC');
        let sA = await getStatus(pageA);
        let sB = await getStatus(pageB);
        let sC = await getStatus(pageC);
        console.log(`[converge] A="${sA}" B="${sB}" C="${sC}"`);
        check('All at 14 after ABC',
            charCount(sA) === 14 && charCount(sB) === 14 && charCount(sC) === 14);

        // Phase 2: B moves to end and types XYZ
        console.log('\n=== Phase 2: B types XYZ at end ===\n');
        console.log('[B] Ctrl+End');
        await pageB.evaluate(() => {
            globalThis.TheFakeWebSocket.send('key type=input char=0 key=9221');
            globalThis.TheFakeWebSocket.send('key type=up char=0 key=9221');
        });
        await sleep(3000);

        for (const ch of ['X', 'Y', 'Z']) {
            console.log(`[B] Types "${ch}"...`);
            await pageB.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            await sleep(8000);
            const expected = 14 + 'XYZ'.indexOf(ch) + 1;
            await waitForAnyCharCount([pageA, pageB, pageC], expected, 5000);
            const sA = await getStatus(pageA);
            const sB = await getStatus(pageB);
            const sC = await getStatus(pageC);
            console.log(`  A="${sA}" B="${sB}" C="${sC}"`);
        }

        // Convergence
        console.log('\n[wait] 10s convergence...');
        await sleep(10000);
        await snap(pageA, 'A_after_XYZ');
        await snap(pageB, 'B_after_XYZ');
        await snap(pageC, 'C_after_XYZ');
        sA = await getStatus(pageA);
        sB = await getStatus(pageB);
        sC = await getStatus(pageC);
        console.log(`[converge] A="${sA}" B="${sB}" C="${sC}"`);
        check('All at 17 after XYZ',
            charCount(sA) === 17 && charCount(sB) === 17 && charCount(sC) === 17);

        // Phase 3: C clicks middle (between "ABC" and "Hello") and types PQR
        // Document is now "ABCHello WorldXYZ". The space is between "Hello" and "World".
        // Click at x=2000 should land in the middle area.
        console.log('\n=== Phase 3: C types PQR in middle ===\n');
        console.log('[C] Click middle of document');
        await pageC.evaluate(() => {
            globalThis.TheFakeWebSocket.send('mouse type=buttondown x=2000 y=1000 count=1 buttons=1 modifier=0');
            globalThis.TheFakeWebSocket.send('mouse type=buttonup x=2000 y=1000 count=1 buttons=1 modifier=0');
        });
        await sleep(3000);

        for (const ch of ['P', 'Q', 'R']) {
            console.log(`[C] Types "${ch}"...`);
            await pageC.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            await sleep(8000);
            const expected = 17 + 'PQR'.indexOf(ch) + 1;
            await waitForAnyCharCount([pageA, pageB, pageC], expected, 5000);
            const sA = await getStatus(pageA);
            const sB = await getStatus(pageB);
            const sC = await getStatus(pageC);
            console.log(`  A="${sA}" B="${sB}" C="${sC}"`);
        }

        // Final
        console.log('\n[wait] 10s final settle...');
        await sleep(10000);
        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');
        await snap(pageC, 'C_final');
        sA = await getStatus(pageA);
        sB = await getStatus(pageB);
        sC = await getStatus(pageC);
        console.log(`\n[final] A="${sA}" B="${sB}" C="${sC}"`);
        check('All at 20 chars',
            charCount(sA) === 20 && charCount(sB) === 20 && charCount(sC) === 20);

        console.log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
        console.log('\nDone.');
        process.exit(allPassed ? 0 : 1);
    }
})();
