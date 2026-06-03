// Test: two browsers type at different cursor positions
// A clicks at start, B clicks at end, A types "AAA", B types "BBB"
// Expected: "AAAHello WorldBBB" (not "Hello WorldAAABBB")
const puppeteer = require('puppeteer');
const fs = require('fs');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function snap(page, name) {
    const dir = '/tmp/static-deploy/public/screenshots';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${ts()}_${name}.png` });
    console.log(`  [snap] ${name}`);
}

async function getStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}

(async () => {
    console.log('=== Cursor Position Test ===\n');
    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload
        const up = await browser.newPage();
        await up.goto(BASE, { waitUntil: 'networkidle0' });
        await up.evaluate(async (url) => {
            await fetch(url + '/wasm/cursor-test.txt', {
                method: 'POST',
                body: new Blob(['Hello World'], { type: 'application/octet-stream' }),
            });
        }, BASE);
        await up.close();
        console.log('[setup] Uploaded "cursor-test.txt" = "Hello World"\n');

        const ROOM = 'cursor-' + Date.now();
        const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=cursor-test.txt&relay=${relay}&access_token=test`;

        async function openDoc(label) {
            const page = await browser.newPage();
            await page.evaluateOnNewDocument(() => {
                window._logs = [];
                const orig = console.log;
                console.log = function() { window._logs.push(Array.from(arguments).join(' ')); orig.apply(console, arguments); };
            });
            await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await page.waitForFunction(() => {
                const el = document.querySelector('#StateWordCount');
                return el && el.textContent && el.textContent.includes('characters');
            }, { timeout: TIMEOUT });
            console.log(`[${label}] Loaded: "${await getStatus(page)}"`);
            return page;
        }

        const pageA = await openDoc('A');
        console.log('[wait] 10s before opening B...');
        await sleep(10000);
        const pageB = await openDoc('B');
        console.log('\n[wait] 15s stabilization...');
        await sleep(15000);
        await snap(pageA, '1_A_initial');
        await snap(pageB, '1_B_initial');

        // --- A: place cursor at start via mouse click + Home ---
        console.log('\n[A] Placing cursor at START...');
        await pageA.evaluate(() => {
            // Click at start of doc then Home
            globalThis.TheFakeWebSocket.send('mouse type=buttondown x=1000 y=1000 count=1 buttons=1 modifier=0');
            globalThis.TheFakeWebSocket.send('mouse type=buttonup x=1000 y=1000 count=1 buttons=1 modifier=0');
        });
        await sleep(1000);
        await pageA.evaluate(() => {
            globalThis.TheFakeWebSocket.send('key type=input char=0 key=1028'); // Home
            globalThis.TheFakeWebSocket.send('key type=up char=0 key=1028');
        });
        await sleep(2000);

        // --- B: place cursor at end via mouse click + End ---
        console.log('[B] Placing cursor at END...');
        await pageB.evaluate(() => {
            globalThis.TheFakeWebSocket.send('mouse type=buttondown x=5000 y=1000 count=1 buttons=1 modifier=0');
            globalThis.TheFakeWebSocket.send('mouse type=buttonup x=5000 y=1000 count=1 buttons=1 modifier=0');
        });
        await sleep(1000);
        await pageB.evaluate(() => {
            globalThis.TheFakeWebSocket.send('key type=input char=0 key=1029'); // End
            globalThis.TheFakeWebSocket.send('key type=up char=0 key=1029');
        });
        await sleep(2000);

        await snap(pageA, '2_A_cursors_placed');
        await snap(pageB, '2_B_cursors_placed');

        // --- A types "AAA" via textinput (proven to work) ---
        console.log('\n[A] Typing "AAA" via textinput...');
        await pageA.evaluate(() => {
            globalThis.TheFakeWebSocket.send('textinput id=0 text=A');
            globalThis.TheFakeWebSocket.send('textinput id=0 text=A');
            globalThis.TheFakeWebSocket.send('textinput id=0 text=A');
        });
        await sleep(5000);
        await snap(pageA, '3_A_after_AAA');
        console.log(`[A] Status: "${await getStatus(pageA)}"`);

        // --- B types "BBB" via textinput ---
        console.log('[B] Typing "BBB" via textinput...');
        await pageB.evaluate(() => {
            globalThis.TheFakeWebSocket.send('textinput id=0 text=B');
            globalThis.TheFakeWebSocket.send('textinput id=0 text=B');
            globalThis.TheFakeWebSocket.send('textinput id=0 text=B');
        });
        await sleep(5000);
        await snap(pageB, '3_B_after_BBB');
        console.log(`[B] Status: "${await getStatus(pageB)}"`);

        // --- Wait for remote sessions to load + sync ---
        // Each remote client: ~35s C++ init + JS flush
        console.log('\n[wait] 60s for remote sessions to load and sync...');
        await sleep(60000);

        await snap(pageA, '4_A_final');
        await snap(pageB, '4_B_final');
        const finalA = await getStatus(pageA);
        const finalB = await getStatus(pageB);
        console.log(`\n[final] A="${finalA}" B="${finalB}"`);

        // Expected: "AAAHello WorldBBB" = 17 chars
        // Bug case: "Hello WorldAAABBB" = 17 chars (both typed at end because shared cursor)
        const parseChars = s => parseInt((s.match(/([\d,]+)\s*char/) || ['','0'])[1].replace(/,/g, ''));
        const cA = parseChars(finalA);
        const cB = parseChars(finalB);
        console.log(`Chars: A=${cA} B=${cB} (expected 17 each)`);

        if (cA === cB && cA === 17) {
            console.log('✓ Char count matches');
        } else {
            console.log('✗ Char count mismatch: A=' + cA + ' B=' + cB);
        }

        // Dump relay logs
        console.log('\n--- A relay logs ---');
        (await pageA.evaluate(() => window._logs.filter(l => l.includes('[relay]')))).forEach(l => console.log('  ' + l));
        console.log('\n--- B relay logs ---');
        (await pageB.evaluate(() => window._logs.filter(l => l.includes('[relay]')))).forEach(l => console.log('  ' + l));
        console.log('\nScreenshots: https://wasm.atgpartners.info:6932/screenshots/');

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
        console.log('\nDone.');
    }
})();
