// Regression: user-journey recorder, Phase 1 (capture + download).
//
// Drives a real ?record session: upload a doc, open it, click the canvas,
// type text, then click the recorder's "Stop & Download" control. Captures
// the downloaded journey JSON via CDP and asserts it contains the uploaded
// fixture (plaintext bytes, base64) plus the real input events — including
// the in-canvas keydowns forwarded from the cross-origin editor iframe.
//
// Real user-input only: clicks/keys via page.mouse/page.keyboard; the Stop
// button via page.click on the visible control. Outcome = the actual
// downloaded artifact, parsed from disk.

const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const TIMEOUT = env.scaleTimeout(180000);
const FIXTURE = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const DL_DIR = '/tmp/journey-recorder-dl-' + process.pid;
const SHOT_DIR = '/tmp/static-deploy/public/shots-journey-recorder';

const T0 = Date.now();
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const log = m => console.log(`[${elapsed()}] ${m}`);

let allPassed = true;
function check(label, cond) {
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png` }).catch(() => {});
}

function waitForWriter(frame) {
    return frame.waitForFunction(() => {
        const wc = document.querySelector('#StateWordCount');
        return wc && wc.textContent && wc.textContent.includes('characters');
    }, { timeout: TIMEOUT });
}

async function waitForFileIframe(page) {
    const t0 = Date.now();
    while (Date.now() - t0 < TIMEOUT) {
        const src = await page.evaluate(() => {
            const el = document.getElementById('editor-frame');
            return el && el.src ? el.src : '';
        }).catch(() => '');
        if (src.indexOf('cool.html') >= 0 && src.indexOf('__prewarm_blank') < 0) {
            const f = page.frames().find(fr => fr.url() === src);
            if (f) return f;
        }
        await sleep(250);
    }
    return null;
}

function readDownloadedJourney() {
    const files = fs.existsSync(DL_DIR)
        ? fs.readdirSync(DL_DIR).filter(f => /^journey-.*\.json$/.test(f)) : [];
    if (!files.length) return null;
    const p = path.join(DL_DIR, files[0]);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

(async () => {
    fs.mkdirSync(DL_DIR, { recursive: true });
    const { browser, cleanup } = await launch();
    const bytes = fs.readFileSync(FIXTURE);
    try {
        // Upload, then open the viewer with ?record (top window).
        const up = await uploadV2(VIEWER, 'new.docx', bytes);
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 900 });

        // Route browser downloads to our temp dir so we can read the bundle.
        const client = await page.createCDPSession();
        await client.send('Page.setDownloadBehavior',
            { behavior: 'allow', downloadPath: DL_DIR });

        const url = VIEWER.replace(/\/+$/, '') + '/?record#file=' + up.b64urlSecret;
        log('open ?record session: ' + url.slice(0, 90));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const frame = await waitForFileIframe(page);
        check('editor iframe loaded', !!frame);
        if (frame) await waitForWriter(frame);
        log('doc ready');

        // The recorder control must be present + show "Recording".
        await page.waitForSelector('#journey-recorder-control', { visible: true, timeout: 15000 });
        const recording = await page.evaluate(() =>
            /Recording/.test(document.querySelector('#journey-recorder-control')?.textContent || ''));
        check('recorder control visible + recording', recording);
        await snap(page, '01_recording');

        // Real input into the document canvas (lands in the editor iframe →
        // forwarded to the recorder as JourneyInput).
        await sleep(2500);                 // relay-adapter activation gate
        await page.mouse.click(640, 400);
        await sleep(600);
        await page.keyboard.type('JourneyRec', { delay: 40 });
        await sleep(1500);
        await snap(page, '02_typed');

        // Stop & Download via the real control button.
        await page.click('#journey-recorder-control #jr-stop');
        log('clicked Stop & Download');

        // Poll for the downloaded journey JSON.
        let journey = null;
        for (let i = 0; i < 40 && !journey; i++) { await sleep(500); journey = readDownloadedJourney(); }
        check('journey JSON downloaded', !!journey);

        if (journey) {
            log(`journey: ${journey.events.length} events, ${journey.fixtures.length} fixture(s)`);
            check('bundle version 1', journey.version === 1);
            check('1 fixture captured', journey.fixtures.length === 1);
            const fx = journey.fixtures[0] || {};
            check('fixture has plaintext bytes (base64) of correct size',
                !!fx.bytesB64 && fx.size === bytes.length);
            check('fixture bytes round-trip to the original file',
                !!fx.bytesB64 && Buffer.from(fx.bytesB64, 'base64').equals(bytes));
            const types = journey.events.map(e => e.type);
            check('captured an upload or open event',
                types.includes('upload') || types.includes('open'));
            const editorKeys = journey.events.filter(
                e => e.type === 'keydown' && e.frame === 'editor');
            check('captured in-canvas keydowns from the editor iframe (≥3)',
                editorKeys.length >= 3);
            const editorPointers = journey.events.filter(
                e => (e.type === 'pointerdown' || e.type === 'pointerup') && e.frame === 'editor');
            check('captured an in-canvas pointer event (normalized coords)',
                editorPointers.some(e => typeof e.nx === 'number' && e.nx >= 0 && e.nx <= 1));
        }

        await page.close();
        log('\n' + '='.repeat(50));
        if (allPassed) log('✓ ALL JOURNEY-RECORDER TESTS PASSED');
        else { log('✗ SOME TESTS FAILED'); process.exitCode = 1; }
    } catch (err) {
        log('FAIL: ' + err.message);
        console.error(err);
        process.exitCode = 1;
    } finally {
        await cleanup();
        try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch (e) {}
    }
})();
