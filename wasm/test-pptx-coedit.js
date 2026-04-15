const __cl = require('./lib/inject-checklist');
// Test: 2-browser PPTX (Impress) co-editing
// Verifies both browsers load the same pptx via relay and both have Impress UI
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const RELAY_BASE = env.RELAY_URL;
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-pptx-coedit';
const DOC_NAME = 'testdoc.pptx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', DOC_NAME);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const filename = `${String(++shotNum).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path: `${SHOT_DIR}/${filename}` });
    log(`[snap] ${filename}`);
}

let allPassed = true;
function check(label, condition) { __cl.recordCheck(label, condition);
    if (condition) { log(`  ✓ ${label}`); }
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

async function waitForImpress(page, label) {
    log(`[${label}] Waiting for Impress...`);
    try {
        await page.waitForFunction(() => {
            var overlay = document.getElementById('wasm-loading-overlay');
            if (overlay && overlay.style.opacity !== '0') return false;
            var nav = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
            if (nav && nav.textContent && nav.textContent.includes('Slide Show')) return true;
            var thumbs = document.querySelectorAll('#slide-sorter img, #slide-sorter canvas');
            if (thumbs.length > 0) return true;
            return false;
        }, { timeout: TIMEOUT });
        await sleep(5000); // Let tiles render
        log(`[${label}] Impress loaded`);
        return true;
    } catch (e) {
        log(`[${label}] Timeout: ${e.message}`);
        return false;
    }
}

(async () => {
    log('=== PPTX 2-Browser Co-editing Test ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) {
        log('ERROR: ' + DOC_PATH + ' not found');
        process.exit(1);
    }

    // Use separate browser instances to avoid CPU starvation
    const browserA = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    const browserB = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload
        const up = await browserA.newPage();
        await up.goto(BASE, { waitUntil: 'networkidle0' });
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (url, name, arr) => {
            await fetch(url + '/wasm/' + encodeURIComponent(name), {
                method: 'POST', body: new Blob([new Uint8Array(arr)])
            });
        }, BASE, DOC_NAME, Array.from(bytes));
        await up.close();
        log('Uploaded ' + DOC_NAME);

        const ROOM = 'pptx-coedit-' + Date.now();
        const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(DOC_NAME)}&relay=${relay}&access_token=test`;

        // Open Browser A
        log('\n--- Browser A ---');
        const pageA = await browserA.newPage();
        await pageA.evaluateOnNewDocument(() => {
            window._logs = [];
            const orig = console.log;
            console.log = function() {
                window._logs.push(Array.from(arguments).join(' '));
                orig.apply(console, arguments);
            };
        });
        await pageA.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        const loadedA = await waitForImpress(pageA, 'A');
        check('Browser A: Impress loaded', loadedA);
        await snap(pageA, 'A_loaded');

        // Open Browser B (with delay)
        await sleep(5000);
        log('\n--- Browser B ---');
        const pageB = await browserB.newPage();
        await pageB.evaluateOnNewDocument(() => {
            window._logs = [];
            const orig = console.log;
            console.log = function() {
                window._logs.push(Array.from(arguments).join(' '));
                orig.apply(console, arguments);
            };
        });
        await pageB.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        const loadedB = await waitForImpress(pageB, 'B');
        check('Browser B: Impress loaded', loadedB);
        await snap(pageB, 'B_loaded');

        // Wait for remote clients
        log('\n--- Checking remote clients ---');
        await sleep(15000);

        const readyA = await pageA.evaluate(() =>
            (window._logs || []).some(l => l.includes(') ready'))
        );
        const readyB = await pageB.evaluate(() =>
            (window._logs || []).some(l => l.includes(') ready'))
        );
        check('A sees remote client', readyA);
        check('B sees remote client', readyB);

        // Browser A types on slide
        log('\n--- Browser A: typing ---');
        await pageA.evaluate(() => {
            if (globalThis.TheFakeWebSocket) {
                TheFakeWebSocket.send('mouse type=buttondown x=5000 y=4000 count=2 buttons=1 modifier=0');
                TheFakeWebSocket.send('mouse type=buttonup x=5000 y=4000 count=2 buttons=1 modifier=0');
            }
        });
        await sleep(3000);

        for (const ch of 'AAA') {
            await pageA.evaluate((c) => {
                if (globalThis.TheFakeWebSocket)
                    TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
            }, ch);
            await sleep(1000);
        }
        log('[A] Typed AAA');
        await sleep(5000);
        await snap(pageA, 'A_after_AAA');
        await snap(pageB, 'B_after_AAA');

        // Browser B types on slide
        log('\n--- Browser B: typing ---');
        await pageB.evaluate(() => {
            if (globalThis.TheFakeWebSocket) {
                TheFakeWebSocket.send('mouse type=buttondown x=5000 y=7000 count=2 buttons=1 modifier=0');
                TheFakeWebSocket.send('mouse type=buttonup x=5000 y=7000 count=2 buttons=1 modifier=0');
            }
        });
        await sleep(3000);

        for (const ch of 'BBB') {
            await pageB.evaluate((c) => {
                if (globalThis.TheFakeWebSocket)
                    TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
            }, ch);
            await sleep(1000);
        }
        log('[B] Typed BBB');
        await sleep(5000);
        await snap(pageA, 'A_after_BBB');
        await snap(pageB, 'B_after_BBB');

        // Final check - both still have Impress UI
        const uiA = await pageA.evaluate(() => {
            var el = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
            return el && el.textContent && el.textContent.includes('Slide Show');
        });
        const uiB = await pageB.evaluate(() => {
            var el = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
            return el && el.textContent && el.textContent.includes('Slide Show');
        });
        check('A: Impress UI intact', uiA);
        check('B: Impress UI intact', uiB);

        await snap(pageA, 'A_final');
        await snap(pageB, 'B_final');

        log('\n' + (allPassed ? '✓ ALL PPTX CO-EDITING CHECKS PASSED' : '✗ SOME CHECKS FAILED'));

    } catch (e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browserA.close();
        await browserB.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
