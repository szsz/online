// E2E test with REAL keystrokes (not postMobileMessage shortcuts)
const puppeteer = require('puppeteer');
const fs = require('fs');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function snap(page, name) {
    const dir = '/tmp/static-deploy/public/screenshots';
    fs.mkdirSync(dir, { recursive: true });
    const path = `${dir}/${ts()}_${name}.png`;
    await page.screenshot({ path });
    console.log(`  [snap] ${name}`);
    return path;
}

async function getStatus(page) {
    return page.evaluate(() => {
        const el = document.querySelector('#StateWordCount');
        return el ? el.textContent.trim() : 'NOT FOUND';
    });
}

(async () => {
    console.log('=== E2E Test with Real Keystrokes ===\n');

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload test file
        const uploadPage = await browser.newPage();
        await uploadPage.goto(`${BASE}/editor.html`, { waitUntil: 'networkidle0' });
        await uploadPage.evaluate(async (url) => {
            await fetch(url + '/wasm/realkey-test.txt', {
                method: 'POST',
                body: new Blob(['Hello World'], { type: 'application/octet-stream' }),
            });
        }, BASE);
        await uploadPage.close();
        console.log('[setup] Uploaded "realkey-test.txt" = "Hello World"\n');

        const ROOM = 'realkey-' + Date.now();
        const relay = encodeURIComponent(`wss://wasm.atgpartners.info:9091/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=realkey-test.txt&relay=${relay}&access_token=test`;

        // Helper: open and wait for full load
        async function openDoc(label) {
            const page = await browser.newPage();
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

        // --- Open both ---
        const pageA = await openDoc('A');
        const pageB = await openDoc('B');
        console.log('\n[wait] 10s stabilization...');
        await sleep(10000);
        await snap(pageA, '1_A_initial');
        await snap(pageB, '1_B_initial');
        console.log(`[status] A="${await getStatus(pageA)}" B="${await getStatus(pageB)}"\n`);

        // --- Click in document A to place cursor ---
        console.log('[A] Clicking in document to place cursor...');
        // Click on the canvas to position cursor
        const canvasA = await pageA.$('canvas');
        if (canvasA) {
            const box = await canvasA.boundingBox();
            await pageA.mouse.click(box.x + 100, box.y + 30);
            await sleep(1000);
            // Double click to ensure focus
            await pageA.mouse.click(box.x + 100, box.y + 30);
            await sleep(1000);
        }

        // Focus the input area that COOL uses for keyboard
        await pageA.evaluate(() => {
            const textarea = document.querySelector('#clipboard-area');
            if (textarea) {
                textarea.focus();
                console.log('[test] Focused clipboard-area');
            } else {
                console.log('[test] clipboard-area not found!');
            }
        });
        await sleep(1000);

        // --- A types "XYZ" using REAL keyboard ---
        console.log('[A] Typing "XYZ" with real keyboard...');
        await pageA.keyboard.press('Home'); // Go to start
        await sleep(500);
        for (const ch of 'XYZ') {
            await pageA.keyboard.press(ch);
            await sleep(300);
        }

        console.log('[wait] 5s...');
        await sleep(5000);

        // Brief pause for rendering
        await sleep(2000);

        await snap(pageA, '2_A_after_typing');
        console.log(`[status] A="${await getStatus(pageA)}"\n`);

        // Wait for sync
        console.log('[wait] 15s for sync...');
        await sleep(15000);

        await snap(pageB, '2_B_after_sync');
        console.log(`[status] A="${await getStatus(pageA)}" B="${await getStatus(pageB)}"`);

        // Check both relay logs
        const logsA = await pageA.evaluate(() => window._logs.filter(l => l.includes('[relay]')));
        console.log('\n[A] Relay logs:');
        logsA.forEach(l => console.log('  ' + l));
        const logsB = await pageB.evaluate(() => window._logs.filter(l => l.includes('[relay]')));
        console.log('\n[B] Relay logs:');
        logsB.forEach(l => console.log('  ' + l));

        // Final screenshots
        await snap(pageA, '3_A_final');
        await snap(pageB, '3_B_final');

        console.log('\n--- Screenshots at https://wasm.atgpartners.info:6932/screenshots/ ---');

    } catch (e) {
        console.error('\nError:', e.message);
    } finally {
        await browser.close();
        console.log('\nDone.');
    }
})();
