const __cl = require('./lib/inject-checklist');
// Regression test: a user-initiated save (Ctrl+S) must:
//   1. produce a fresh checkpoint on the relay
//   2. upload the saved file to viewer storage (/api/v2/file/<fileId>)
//
// Migrated to the viewer flow:
//   - uploads via uploadV2
//   - opens via openSecretInBrowser
//   - reads back saved ciphertext via downloadV2 to check the size and
//     updatedAt advanced after Ctrl+S
//   - probes the relay's /room/<room>/file endpoint to confirm a
//     checkpoint is registered after user save (room key is the encrypted
//     name; viewer's relayRoom() derives it from the same docName the
//     test uploaded)
const { launch, sleep } = require('./lib/browser');
const fs = require('fs');
const env = require('./lib/test-env');
const { uploadV2, downloadV2 } = require('./lib/v2-upload');
const { openSecretInBrowser } = require('./lib/open-via-viewer');
const { pickLib } = require('./lib/fetch-url');

const VIEWER = env.FILE_STORAGE_URL;
const RELAY_BASE = env.RELAY_URL;
const RELAY_HTTP = RELAY_BASE.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const TIMEOUT = env.scaleTimeout(300000);
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-user-save';

const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

function httpGet(urlStr) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const lib = pickLib(urlStr);
        const req = lib.request({
            hostname: u.hostname, port: u.port, path: u.pathname,
            method: 'GET', rejectUnauthorized: false,
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

async function clickCanvas(page) {
    await page.mouse.click(640, 400);
    await sleep(500);
}

(async () => {
    log('=== Regression: user save → checkpoint + storage upload ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    const { browser, cleanup } = await launch();

    const STAMP = Date.now();
    const NAME = 'usersave-' + STAMP + '.txt';
    const INITIAL = 'Hello';
    const TYPED = 'XYZ';

    try {
        const up = await uploadV2(VIEWER, NAME, Buffer.from(INITIAL, 'utf8'));
        log(`Uploaded "${INITIAL}" via v2 → fileId ${up.fileId.substring(0,8)}…`);

        // Viewer's openFileBySecret stages the file under fileId, and
        // viewer.relayRoom(name) is called with fileId — so the relay
        // room key is the opaque fileId, not the plaintext name. The
        // 64-hex fileId is URL-safe, so no encoding needed.
        const ROOM_URL = RELAY_HTTP + '/room/' + up.fileId + '/file';

        // Initial relay state — should be 404 (no checkpoint yet).
        const initialRelay = await httpGet(ROOM_URL);
        log(`Initial relay status: ${initialRelay.status}`);
        check('Relay has no checkpoint before any save', initialRelay.status === 404);

        // Initial storage state — capture size + updatedAt baseline.
        const initialDl = await downloadV2(VIEWER, up.secret);
        log(`Initial storage size: ${initialDl.size}B, updatedAt: ${initialDl.updatedAt}`);

        const { page, editorFrame } = await openSecretInBrowser(
            browser, VIEWER, up.b64urlSecret,
            { iframeTimeout: TIMEOUT, gotoTimeout: env.scaleTimeout(60000),
              isolatedContext: true });
        await editorFrame.waitForFunction(() =>
            document.querySelector('#StateWordCount')?.textContent?.includes('characters'),
            { timeout: TIMEOUT });
        log('Editor loaded');
        await sleep(8000);

        // After activation the FIRST-client save runs automatically; capture
        // the post-activate baseline so we measure only the user save delta.
        await sleep(2000);
        const afterActivateRelay = await httpGet(ROOM_URL);
        const postActivateRelayHash = afterActivateRelay.status === 200
            ? JSON.parse(afterActivateRelay.body.toString()).hash : null;
        log(`After activation, relay hash: ${(postActivateRelayHash||'').substring(0, 16)}…`);
        const postActivateDl = await downloadV2(VIEWER, up.secret);
        log(`After activation, storage size: ${postActivateDl.size}B, updatedAt: ${postActivateDl.updatedAt}`);

        // ── Type some text ───────────────────────────────────────────
        log('\n--- Typing "' + TYPED + '" ---');
        await clickCanvas(page);
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await sleep(800);
        for (const c of TYPED) {
            await page.keyboard.type(c, { delay: 50 });
            await sleep(400);
        }
        await sleep(2000);
        const wcAfterType = await editorFrame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent || '');
        log(`After typing: "${wcAfterType.trim()}"`);

        // ── User save (Ctrl+S) ──────────────────────────────────────
        log('\n--- Dispatching Ctrl+S (real keyboard) ---');
        await page.keyboard.down('Control');
        await page.keyboard.press('s');
        await page.keyboard.up('Control');

        await sleep(10000);

        // ── Verify storage updated ───────────────────────────────────
        const afterDl = await downloadV2(VIEWER, up.secret);
        log(`Post-save storage size: ${afterDl.size}B, updatedAt: ${afterDl.updatedAt}`);

        check('Storage updatedAt advanced after user save',
              afterDl.updatedAt > postActivateDl.updatedAt,
              `before=${postActivateDl.updatedAt} after=${afterDl.updatedAt}`);
        // Ciphertext is non-deterministic (AES-GCM with random IV), but
        // total size includes IV+tag+plaintext-length, so a larger plaintext
        // produces a larger ciphertext.
        check('Storage size grew after user save (typed text round-tripped)',
              afterDl.size > postActivateDl.size,
              `before=${postActivateDl.size} after=${afterDl.size}`);

        // Plaintext decrypt: the saved file should contain the typed text.
        const savedPlain = afterDl.bytes.toString('utf8');
        check('Saved plaintext contains the typed text',
              savedPlain.includes(TYPED),
              'first 80 chars: ' + savedPlain.substring(0, 80));

        // ── Verify relay checkpoint updated ──────────────────────────
        const afterRelay = await httpGet(ROOM_URL);
        const afterRelayHash = afterRelay.status === 200
            ? JSON.parse(afterRelay.body.toString()).hash : null;
        log(`Post-save relay hash: ${(afterRelayHash||'').substring(0, 16)}…`);
        check('Relay has a checkpoint after user save',
              afterRelay.status === 200 && !!afterRelayHash);
        check('Relay checkpoint hash CHANGED from post-activate baseline',
              afterRelayHash && afterRelayHash !== postActivateRelayHash,
              'before=' + (postActivateRelayHash||'').substring(0, 12) +
              ' after=' + (afterRelayHash||'').substring(0, 12));

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch (e) {
        log('Error: ' + (e.stack || e.message));
        allPassed = false;
    } finally {
        await cleanup();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
