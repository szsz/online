const __cl = require('./lib/inject-checklist');
// Co-editing test: 2 browsers typing via real keyboard, verify convergence.
// ALL input via keyboard/mouse — no TheFakeWebSocket.send() calls.
// Expected: "ABCHello WorldXYZ" = 17 chars, identical on both browsers.
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots';

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await sleep(500);
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    console.log(`  [snap] ${filename}`);
}

// DOM read only — extract word count text
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
            console.log(`[${label}] ${count} client(s) ready (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            return true;
        }
        await sleep(2000);
        process.stdout.write('.');
    }
    console.log(`\n[${label}] Timeout`);
    return false;
}

(async () => {
    console.log('=== Co-editing: real keyboard input, content verification ===\n');

    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

    let allPassed = true;
    function check(label, condition) {
        __cl.recordCheck(label, condition);
        if (condition) console.log(`  ✓ ${label}`);
        else { console.log(`  ✗ FAIL: ${label}`); allPassed = false; }
    }

    try {
        // Upload test document
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

        // Click the editor canvas to focus it
        async function clickCanvas(page) {
            await page.mouse.click(640, 400);
            await sleep(500);
        }

        const pageA = await openDoc('A');
        await sleep(10000);
        const pageB = await openDoc('B');
        await sleep(15000);

        await snap(pageA, 'A_initial');
        await snap(pageB, 'B_initial');
        check('Initial: both 11 chars',
            charCount(await getStatus(pageA)) === 11 &&
            charCount(await getStatus(pageB)) === 11);

        console.log('\n--- Waiting for remote clients ---');
        const readyA = await waitForReady(pageA, 'A', 1);
        const readyB = await waitForReady(pageB, 'B', 1);
        if (!readyA || !readyB) throw new Error('Not ready');

        console.log('\n=== Typing ===\n');
        await sleep(2000);

        // Phase 1: A types ABC at cursor position 0 (real keyboard)
        await clickCanvas(pageA);
        for (const ch of ['A', 'B', 'C']) {
            console.log(`\n[A] Types "${ch}"...`);
            await pageA.keyboard.type(ch, { delay: 50 });
            const expected = 11 + 'ABC'.indexOf(ch) + 1;
            await sleep(8000);
            await snap(pageA, `A_after_${ch}`);
            await snap(pageB, `B_after_${ch}`);
            const sA = await getStatus(pageA);
            const sB = await getStatus(pageB);
            check(`After "${ch}": B=${charCount(sB)} (expected ${expected})`,
                charCount(sB) === expected);
            console.log(`  A="${sA}"  B="${sB}"`);
        }

        // Wait for convergence
        console.log('\n[wait] 10s for A to converge...');
        await sleep(10000);
        let convA = await getStatus(pageA);
        let convB = await getStatus(pageB);
        console.log(`[converge] A="${convA}" B="${convB}"`);
        check('Both at 14 after ABC', charCount(convA) === 14 && charCount(convB) === 14);

        // Phase 2: B moves to end (Ctrl+End) and types XYZ (real keyboard)
        console.log('\n[B] Ctrl+End');
        await clickCanvas(pageB);
        await pageB.keyboard.down('Control');
        await pageB.keyboard.press('End');
        await pageB.keyboard.up('Control');
        await sleep(3000);

        for (const ch of ['X', 'Y', 'Z']) {
            console.log(`\n[B] Types "${ch}"...`);
            await pageB.keyboard.type(ch, { delay: 50 });
            const expected = 14 + 'XYZ'.indexOf(ch) + 1;
            await sleep(8000);
            await snap(pageA, `A_after_${ch}`);
            await snap(pageB, `B_after_${ch}`);
            const sA = await getStatus(pageA);
            const sB = await getStatus(pageB);
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
        await cleanup();
        console.log('\nDone.');
        process.exit(allPassed ? 0 : 1);
    }
})();
