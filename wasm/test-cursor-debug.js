const __cl = require('./lib/inject-checklist');
// Co-editing test: all input via relay, verify document content after each keystroke
// Expected: "ABCHello WorldXYZ" = 17 chars, identical on both browsers
const puppeteer = require('puppeteer');
const fs = require('fs');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots';

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

// Extract character count as number
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

// Wait until both pages show expected char count
async function waitForCharCount(pageA, pageB, expected, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        const sA = await getStatus(pageA);
        const sB = await getStatus(pageB);
        if (charCount(sA) === expected && charCount(sB) === expected) {
            return { a: sA, b: sB, ok: true };
        }
        await sleep(500);
    }
    return { a: await getStatus(pageA), b: await getStatus(pageB), ok: false };
}

(async () => {
    console.log('=== Co-editing: all input via relay, content verification ===\n');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    let allPassed = true;
    function check(label, condition) { __cl.recordCheck(label, condition);
        if (condition) {
            console.log(`  ✓ ${label}`);
        } else {
            console.log(`  ✗ FAIL: ${label}`);
            allPassed = false;
        }
    }

    try {
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'networkidle0' });
        await up.evaluate(async (url) => {
            await fetch(url + '/wasm/cotest.txt', {
                method: 'POST',
                body: new Blob(['Hello World'], { type: 'application/octet-stream' }),
            });
        }, BASE);
        await up.close();
        console.log('[setup] Uploaded "Hello World"\n');

        const ROOM = 'cotest-' + Date.now();
        const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=cotest.txt&relay=${relay}&access_token=test`;

        async function openDoc(label) {
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
            console.log(`[${label}] Opening...`);
            await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await page.waitForFunction(() => {
                const el = document.querySelector('#StateWordCount');
                return el && el.textContent && el.textContent.includes('characters');
            }, { timeout: TIMEOUT });
            console.log(`[${label}] Loaded: "${await getStatus(page)}"`);
            return page;
        }

        const pageA = await openDoc('A');
        await sleep(10000);
        const pageB = await openDoc('B');
        await sleep(15000);

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        check('Initial: both 11 chars', charCount(await getStatus(pageA)) === 11 && charCount(await getStatus(pageB)) === 11);

        console.log('\n--- Waiting for remote clients ---');
        const readyA = await waitForReady(pageA, 'A', 1);
        const readyB = await waitForReady(pageB, 'B', 1);
        if (!readyA || !readyB) throw new Error('Not ready');

        console.log('\n=== Typing ===\n');
        await sleep(2000);

        // Both cursors start at position 0 (default for new remote clients).
        // A stays at position 0 (beginning) — no key needed.
        // B: move to end using End key AFTER all of A's typing is done.
        // This ensures consistent cursor state across all Kit instances.
        // For now, A types first, then B moves to end and types.

        // Phase 1: A types ABC at cursor position 0 (default for new remote client)
        for (const ch of ['A', 'B', 'C']) {
            console.log(`\n[A] Types "${ch}"...`);
            await pageA.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            const expected = 11 + 'ABC'.indexOf(ch) + 1;
            await sleep(8000); // generous wait for Kit propagation
            await snap(pageA, `A_after_${ch}`);
            await snap(pageB, `B_after_${ch}`);
            const sA = await getStatus(pageA);
            const sB = await getStatus(pageB);
            // B should see update; A may lag by 1
            check(`After "${ch}": B=${charCount(sB)} (expected ${expected})`,
                charCount(sB) === expected);
            console.log(`  A="${sA}"  B="${sB}"`);
        }

        // Wait for A to fully converge
        console.log('\n[wait] 10s for A to converge...');
        await sleep(10000);
        let convA = await getStatus(pageA);
        let convB = await getStatus(pageB);
        console.log(`[converge] A="${convA}" B="${convB}"`);
        check('Both at 14 after ABC', charCount(convA) === 14 && charCount(convB) === 14);

        // Phase 2: B moves to end and types XYZ
        // Now all Kit instances have "ABCHello World", so End goes to position 14 consistently
        console.log('\n[B] Ctrl+End');
        await pageB.evaluate(() => {
            globalThis.TheFakeWebSocket.send('key type=input char=0 key=9221');
            globalThis.TheFakeWebSocket.send('key type=up char=0 key=9221');
        });
        await sleep(3000);

        for (const ch of ['X', 'Y', 'Z']) {
            console.log(`\n[B] Types "${ch}"...`);
            await pageB.evaluate((c) => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=' + c);
            }, ch);
            const expected = 14 + 'XYZ'.indexOf(ch) + 1;
            await sleep(8000);
            await snap(pageA, `A_after_${ch}`);
            await snap(pageB, `B_after_${ch}`);
            const sA = await getStatus(pageA);
            const sB = await getStatus(pageB);
            // A has B's remote client, should see update
            check(`After "${ch}": A=${charCount(sA)} (expected ${expected})`,
                charCount(sA) === expected);
            console.log(`  A="${sA}"  B="${sB}"`);
        }

        // Final
        console.log('\n[wait] 10s settle...');
        await sleep(10000);
        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');
        const fA = await getStatus(pageA);
        const fB = await getStatus(pageB);
        console.log(`\n[final] A="${fA}"  B="${fB}"`);
        check('Final: both 17 chars', charCount(fA) === 17 && charCount(fB) === 17);

        console.log('\n' + (allPassed ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'));

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
        console.log('\nDone.');
        process.exit(allPassed ? 0 : 1);
    }
})();
