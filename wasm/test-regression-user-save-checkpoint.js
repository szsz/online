const __cl = require('./lib/inject-checklist');
// Regression test: a user-initiated save (.uno:Save / Ctrl+S) must
//   1. produce a fresh checkpoint on the relay
//   2. upload the saved file to /api/files/<name> on the storage server
//
// Method:
//   - Open one browser, type some text so the doc is dirty.
//   - Capture the relay's stored checkpointHash and the storage's
//     X-Content-Hash for /api/files/<name> BEFORE the save.
//   - Dispatch `uno .uno:Save`.
//   - Wait. After the save+upload completes, both should reflect the
//     new content (and the two hashes should match each other).
const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');
const env = require('./lib/test-env');

const BASE = env.EDITOR_URL;
const VIEWER = env.FILE_STORAGE_URL;
const RELAY_BASE = env.RELAY_URL;
const RELAY_HTTP = RELAY_BASE.replace(/^wss?:/, 'https:');
const TIMEOUT = 300000;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-user-save';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

function httpGet(urlStr, opts) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, port: u.port, path: u.pathname,
            method: opts && opts.method || 'GET',
            rejectUnauthorized: false,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    log('=== Regression: user save → checkpoint + storage upload ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    const STAMP = Date.now();
    const NAME = 'usersave-' + STAMP + '.txt';
    const ROOM = 'usersave-' + STAMP;
    const INITIAL = 'Hello';
    const TYPED = 'XYZ';
    const FINAL_CHARS = INITIAL.length + TYPED.length;   // 8

    try {
        // Upload initial content via /api/files (storage) — so a reload
        // path or a new joiner could fetch it. Also POST it to /wasm/<name>
        // so cool.html can load it directly.
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        await up.evaluate(async (n, c) => {
            await fetch('/api/files/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([c]),
            });
        }, NAME, INITIAL);
        await up.evaluate(async (base, n, c) => {
            await fetch(base + '/wasm/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([c]),
            });
        }, BASE, NAME, INITIAL);
        await up.close();
        log(`Uploaded initial "${INITIAL}" → /api/files/${NAME} + /wasm/${NAME}`);

        // ── Capture initial state ────────────────────────────────────
        const initialFile = await httpGet(VIEWER + '/api/files/' + encodeURIComponent(NAME));
        const initialHash = (initialFile.headers['x-content-hash'] || '').toString();
        log(`Initial /api/files hash: ${initialHash || '(legacy / none)'}`);

        // Initial relay state — should be 404 (no checkpoint registered yet).
        const initialRelay = await httpGet(RELAY_HTTP + '/room/' + encodeURIComponent(ROOM) + '/file');
        log(`Initial relay /room/.../file status: ${initialRelay.status} ` +
            `body: ${initialRelay.body.toString().substring(0, 120)}`);
        check('Relay has no checkpoint before any save', initialRelay.status === 404);

        // ── Open the editor ──────────────────────────────────────────
        const relay = encodeURIComponent(`${RELAY_BASE}/room/${ROOM}`);
        const fileStorageUrl = encodeURIComponent(VIEWER);
        const coolUrl = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(NAME)}` +
                        `&relay=${relay}&access_token=test&fileStorageUrl=${fileStorageUrl}`;

        const page = await browser.newPage();
        await page.goto(coolUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await page.waitForFunction(() =>
            document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
            { timeout: TIMEOUT });
        log('Editor loaded');
        await sleep(8000);                             // settle, initial save

        // After activation the FIRST-client save runs automatically; that
        // also produces a checkpoint. We want to test the USER save in
        // isolation, so capture the post-activate state and then make
        // a user edit + user save.
        await sleep(2000);
        const afterActivate = await httpGet(RELAY_HTTP + '/room/' + encodeURIComponent(ROOM) + '/file');
        const postActivateRelayHash = afterActivate.status === 200
            ? JSON.parse(afterActivate.body.toString()).hash : null;
        log(`After activation, relay hash: ${(postActivateRelayHash||'').substring(0, 16)}…`);
        const postActivateStorage = await httpGet(VIEWER + '/api/files/' + encodeURIComponent(NAME));
        const postActivateStorageHash = (postActivateStorage.headers['x-content-hash']||'').toString();
        log(`After activation, /api/files hash: ${postActivateStorageHash.substring(0, 16)}…`);

        // ── Type some text ───────────────────────────────────────────
        log('\n--- Typing "' + TYPED + '" ---');
        // GoToEndOfDoc to land at end (5 chars in) before typing.
        await page.evaluate(() => TheFakeWebSocket.send('uno .uno:GoToEndOfDoc'));
        await sleep(800);
        for (const c of TYPED) {
            await page.evaluate((c) => TheFakeWebSocket.send('textinput id=0 text=' + c), c);
            await sleep(400);
        }
        await sleep(2000);
        const wcAfterType = await page.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '');
        log(`After typing: "${wcAfterType.trim()}"`);

        // ── User save (.uno:Save) ────────────────────────────────────
        log('\n--- Dispatching uno .uno:Save (Ctrl+S) ---');
        const saveTime = Date.now();
        await page.evaluate(() => TheFakeWebSocket.send('uno .uno:Save'));

        // Wait for the save+upload pipeline to flush. saveAndUploadCheckpoint
        // has a built-in 1.5 s delay before reading /wasm + uploading; give
        // generous total budget.
        await sleep(8000);

        // ── Verify storage updated ───────────────────────────────────
        const afterStorage = await httpGet(VIEWER + '/api/files/' + encodeURIComponent(NAME));
        const afterStorageHash = (afterStorage.headers['x-content-hash']||'').toString();
        const afterStorageSize = afterStorage.body.length;
        log(`Post-save /api/files hash: ${afterStorageHash.substring(0, 16)}… (${afterStorageSize}B)`);

        check('Storage hash present after user save', !!afterStorageHash);
        check('Storage hash CHANGED from post-activate baseline (new content uploaded)',
              afterStorageHash && afterStorageHash !== postActivateStorageHash,
              'before=' + (postActivateStorageHash||'').substring(0, 12) +
              ' after=' + afterStorageHash.substring(0, 12));

        // ── Verify relay checkpoint updated ──────────────────────────
        const afterRelay = await httpGet(RELAY_HTTP + '/room/' + encodeURIComponent(ROOM) + '/file');
        const afterRelayHash = afterRelay.status === 200
            ? JSON.parse(afterRelay.body.toString()).hash : null;
        log(`Post-save relay hash: ${(afterRelayHash||'').substring(0, 16)}…`);
        check('Relay has a checkpoint after user save', afterRelay.status === 200 && !!afterRelayHash);
        check('Relay checkpoint hash CHANGED from post-activate baseline',
              afterRelayHash && afterRelayHash !== postActivateRelayHash,
              'before=' + (postActivateRelayHash||'').substring(0, 12) +
              ' after=' + (afterRelayHash||'').substring(0, 12));
        check('Relay checkpoint hash MATCHES storage hash (same content)',
              afterRelayHash === afterStorageHash,
              'relay=' + (afterRelayHash||'').substring(0, 16) +
              ' storage=' + afterStorageHash.substring(0, 16));

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
