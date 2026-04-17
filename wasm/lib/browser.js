// Shared browser launcher + keyboard/mouse helpers for all WASM tests.
//
// Uses Xvfb + headful Chrome so every keyboard/mouse event fires
// exactly as it would for a real user (including native paste events
// from Ctrl+V, which headless Chrome doesn't reliably generate).
//
// Usage:
//   const { launch, sleep, editorHelpers } = require('./lib/browser');
//   const { browser, cleanup } = await launch();
//   const page = await browser.newPage();
//   // ... navigate to viewer ...
//   const h = await editorHelpers(page);
//   await h.typeText('Hello');
//   await h.pressCtrl('a');
//   const cc = await h.charCount();

const puppeteer = require('puppeteer');
const { execSync, spawn } = require('child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findFreeDisplay() {
    for (let d = 99; d < 200; d++) {
        try {
            execSync(`xdpyinfo -display :${d} 2>/dev/null`, { stdio: 'pipe' });
        } catch (e) {
            return d;
        }
    }
    return 99;
}

async function launch(opts = {}) {
    const display = findFreeDisplay();
    const width = opts.width || 1280;
    const height = opts.height || 900;

    const xvfb = spawn('Xvfb', [
        `:${display}`, '-screen', '0', `${width}x${height}x24`,
        '-ac', '-nolisten', 'tcp',
    ], { stdio: 'ignore', detached: true });
    xvfb.unref();

    for (let i = 0; i < 20; i++) {
        try {
            execSync(`xdpyinfo -display :${display} 2>/dev/null`, { stdio: 'pipe' });
            break;
        } catch (e) { await sleep(200); }
    }

    const browser = await puppeteer.launch({
        headless: false,
        protocolTimeout: opts.protocolTimeout || 600000,
        env: { ...process.env, DISPLAY: `:${display}` },
        args: [
            '--no-sandbox', '--ignore-certificate-errors',
            '--enable-features=SharedArrayBuffer',
            `--window-size=${width},${height}`,
            '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        ],
    });

    const cleanup = async () => {
        try { await browser.close(); } catch (e) {}
        try { xvfb.kill('SIGTERM'); } catch (e) {}
        try { process.kill(-xvfb.pid, 'SIGTERM'); } catch(e) {}
    };
    const exitHandler = () => { cleanup(); };
    process.on('exit', exitHandler);
    process.on('SIGINT', exitHandler);
    process.on('SIGTERM', exitHandler);

    return { browser, display, cleanup };
}

// ── Editor interaction helpers ────────────────────────────────────
// All input via real keyboard/mouse. DOM reads for assertions only.

async function editorHelpers(page) {
    // Grant clipboard permissions
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.grantPermissions', {
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    });

    // Find the editor iframe
    function getEditorFrame() {
        return page.frames().find(f => f.url().includes('cool.html'));
    }

    // Wait for the editor to be fully loaded and activated
    async function waitForEditor(timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 150000);
        let frame;
        while (Date.now() < deadline) {
            await sleep(500);
            frame = getEditorFrame();
            if (frame) {
                const wc = await frame.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/\d+\s+(word|character)/i.test(wc)) {
                    const canvasOk = await frame.evaluate(() =>
                        !!document.querySelector('.leaflet-tile-container canvas, #document-container canvas')
                    ).catch(() => false);
                    if (canvasOk) {
                        // Also wait for TheFakeWebSocket (relay activated)
                        const wsReady = await frame.evaluate(() =>
                            typeof globalThis.TheFakeWebSocket !== 'undefined'
                        ).catch(() => false);
                        if (wsReady) {
                            await sleep(3000); // settle
                            return frame;
                        }
                    }
                }
            }
        }
        throw new Error('Editor did not load within ' + (timeoutMs || 150000) + 'ms');
    }

    // Click the center of the editor iframe to focus it
    async function clickEditor() {
        const frameEl = await page.$('iframe#editor-frame');
        if (frameEl) {
            const box = await frameEl.boundingBox();
            if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
        await sleep(300);
    }

    // Type text via real keyboard (auto-focuses editor first)
    async function typeText(text, opts) {
        await clickEditor();
        await page.keyboard.type(text, { delay: (opts && opts.delay) || 80 });
    }

    // Press a single key
    async function pressKey(key) {
        await page.keyboard.press(key);
    }

    // Press Ctrl+<key>
    async function pressCtrl(key) {
        await page.keyboard.down('Control');
        await page.keyboard.press(key);
        await page.keyboard.up('Control');
    }

    // Press Ctrl+Shift+<key>
    async function pressCtrlShift(key) {
        await page.keyboard.down('Control');
        await page.keyboard.down('Shift');
        await page.keyboard.press(key);
        await page.keyboard.up('Shift');
        await page.keyboard.up('Control');
    }

    // Read the character count from the status bar (DOM read only)
    async function charCount() {
        const frame = getEditorFrame();
        if (!frame) return -1;
        const wc = await frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || ''
        ).catch(() => '');
        const m = wc.match(/(\d+) characters/);
        return m ? parseInt(m[1]) : -1;
    }

    // Read the word count text from the status bar
    async function wordCountText() {
        const frame = getEditorFrame();
        if (!frame) return '';
        return frame.evaluate(() =>
            document.querySelector('#StateWordCount')?.textContent?.trim() || ''
        ).catch(() => '');
    }

    // Read clipboard contents (DOM read only)
    async function readClipboard() {
        const frame = getEditorFrame();
        if (!frame) return {};
        return frame.evaluate(async () => {
            try {
                var items = await navigator.clipboard.read();
                var r = {};
                for (var it of items) for (var t of it.types) {
                    var b = await it.getType(t);
                    r[t] = (await b.text()).substring(0, 200);
                }
                return r;
            } catch(e) { return { error: e.message }; }
        });
    }

    // Set clipboard to external content (simulates copy from another app)
    async function setClipboard(data) {
        await page.evaluate(async (d) => {
            var items = {};
            for (var k in d) items[k] = new Blob([d[k]], { type: k });
            await navigator.clipboard.write([new ClipboardItem(items)]);
        }, data);
    }

    return {
        cdp, getEditorFrame, waitForEditor, clickEditor,
        typeText, pressKey, pressCtrl, pressCtrlShift,
        charCount, wordCountText, readClipboard, setClipboard,
    };
}

module.exports = { launch, sleep, editorHelpers };
