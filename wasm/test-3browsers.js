// Test 3: 3 browsers, 5 lines, each browser types at different positions
// Each line starts as "Hello World"
// A clicks beginning of line → types "ABC"
// B clicks end of line → types "XYZ"
// C clicks middle (between Hello and World) → types "PQR"
// Expected per line: "ABCHelloPQR WorldXYZ"
const puppeteer = require('puppeteer');
const fs = require('fs');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 600000;

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
    console.log('=== Test 3: 3 Browsers, 5 Lines ===\n');
    const browser = await puppeteer.launch({
        headless: 'new',
        protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload 5 lines of "Hello World"
        const up = await browser.newPage();
        await up.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        await up.evaluate(async (url) => {
            const lines = Array(5).fill('Hello World').join('\n');
            await fetch(url + '/wasm/test3.txt', {
                method: 'POST',
                body: new Blob([lines], { type: 'application/octet-stream' }),
            });
        }, BASE);
        await up.close();
        console.log('[setup] Uploaded 5 lines of "Hello World"\n');

        const ROOM = 'test3-' + Date.now();
        const relay = encodeURIComponent(`wss://wasm.atgpartners.info:9091/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=test3.txt&relay=${relay}&access_token=test`;

        async function openDoc(label) {
            const page = await browser.newPage();
            await page.evaluateOnNewDocument(() => {
                window._logs = [];
                const orig = console.log;
                console.log = function() { window._logs.push(Array.from(arguments).join(' ')); orig.apply(console, arguments); };
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

        // Open 3 browsers with stagger
        const pageA = await openDoc('A');
        console.log('[wait] 10s before B...');
        await sleep(10000);
        const pageB = await openDoc('B');
        console.log('[wait] 10s before C...');
        await sleep(10000);
        const pageC = await openDoc('C');

        console.log('\n[wait] 15s stabilization...');
        await sleep(15000);
        await snap(pageA, '1_initial');
        console.log(`[initial] A="${await getStatus(pageA)}" B="${await getStatus(pageB)}" C="${await getStatus(pageC)}"`);

        // For each of the 5 lines, A types ABC at start, C types PQR in middle, B types XYZ at end
        // We'll do all 5 lines in sequence
        // Line positions (twips): each line ~about 250 twips apart, starting ~1000
        // We use mouse clicks at approximate positions

        for (let line = 0; line < 5; line++) {
            const y = 1000 + line * 400; // Approximate y position for each line
            console.log(`\n--- Line ${line + 1} (y=${y}) ---`);

            // A clicks beginning of line
            await pageA.evaluate((y) => {
                globalThis.TheFakeWebSocket.send('mouse type=buttondown x=500 y=' + y + ' count=1 buttons=1 modifier=0');
                globalThis.TheFakeWebSocket.send('mouse type=buttonup x=500 y=' + y + ' count=1 buttons=1 modifier=0');
            }, y);
            await sleep(500);
            await pageA.evaluate(() => {
                globalThis.TheFakeWebSocket.send('key type=input char=0 key=1028'); // Home
                globalThis.TheFakeWebSocket.send('key type=up char=0 key=1028');
            });

            // B clicks end of line
            await pageB.evaluate((y) => {
                globalThis.TheFakeWebSocket.send('mouse type=buttondown x=5000 y=' + y + ' count=1 buttons=1 modifier=0');
                globalThis.TheFakeWebSocket.send('mouse type=buttonup x=5000 y=' + y + ' count=1 buttons=1 modifier=0');
            }, y);
            await sleep(500);
            await pageB.evaluate(() => {
                globalThis.TheFakeWebSocket.send('key type=input char=0 key=1029'); // End
                globalThis.TheFakeWebSocket.send('key type=up char=0 key=1029');
            });

            // C clicks middle of line (between Hello and World)
            await pageC.evaluate((y) => {
                globalThis.TheFakeWebSocket.send('mouse type=buttondown x=2500 y=' + y + ' count=1 buttons=1 modifier=0');
                globalThis.TheFakeWebSocket.send('mouse type=buttonup x=2500 y=' + y + ' count=1 buttons=1 modifier=0');
            }, y);

            await sleep(1000);

            // A types "ABC"
            await pageA.evaluate(() => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=A');
                globalThis.TheFakeWebSocket.send('textinput id=0 text=B');
                globalThis.TheFakeWebSocket.send('textinput id=0 text=C');
            });

            // B types "XYZ"
            await pageB.evaluate(() => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=X');
                globalThis.TheFakeWebSocket.send('textinput id=0 text=Y');
                globalThis.TheFakeWebSocket.send('textinput id=0 text=Z');
            });

            // C types "PQR"
            await pageC.evaluate(() => {
                globalThis.TheFakeWebSocket.send('textinput id=0 text=P');
                globalThis.TheFakeWebSocket.send('textinput id=0 text=Q');
                globalThis.TheFakeWebSocket.send('textinput id=0 text=R');
            });

            await sleep(2000);
        }

        // Wait for all remote sessions to load and process
        console.log('\n[wait] 90s for all remote sessions to load and sync...');
        await sleep(90000);

        await snap(pageA, '2_A_final');
        await snap(pageB, '2_B_final');
        await snap(pageC, '2_C_final');

        const sA = await getStatus(pageA);
        const sB = await getStatus(pageB);
        const sC = await getStatus(pageC);
        console.log(`\n[final] A="${sA}" B="${sB}" C="${sC}"`);

        // Original: 5 lines × "Hello World" = 5 × 11 = 55 chars + 4 newlines = 59
        // Added: 5 lines × (ABC + PQR + XYZ) = 5 × 9 = 45
        // Expected total: 59 + 45 = 104 characters
        // (word count may differ)

        console.log('\nExpected: each line "ABCHelloPQR WorldXYZ" or similar');
        console.log('Screenshots: https://wasm.atgpartners.info:6932/screenshots/');

    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
        console.log('\nDone.');
    }
})();
