// Detailed timing profile of a single hot-switch.
// Captures: click → upload → bridge sees hash → bridge calls postMobileMessage
//           → C++ handle_cool_message → fetch URL → write VFS → documentLoad
//           → status + loaded frames → first canvas update → wc text changes
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const EDITOR = env.EDITOR_URL;
const DOC_NAME = 'profile-switch.odt';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', '3pages.odt');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });

    // Pre-upload doc to viewer
    const up = await browser.newPage();
    await up.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
    const bytes = fs.readFileSync(DOC_PATH);
    await up.evaluate(async (n, arr) => {
        await fetch('/api/files/' + encodeURIComponent(n), {
            method: 'POST', body: new Blob([new Uint8Array(arr)]),
        });
    }, DOC_NAME, Array.from(bytes));
    await up.close();

    const page = await browser.newPage();

    // Capture EVERYTHING with timestamps so we can build a precise timeline
    const events = [];
    const tStart = Date.now();
    function ev(label, detail) {
        events.push({ t: Date.now() - tStart, label, detail: detail || '' });
    }
    page.on('console', m => {
        const text = m.text();
        // wasm-loader profile marks
        const profM = text.match(/^\[profile \+(\d+(?:\.\d+)?)ms\]\s+(\S+)\s*(.*)/);
        if (profM) {
            events.push({ t: Date.now() - tStart, label: 'iframe:'+profM[2], detail: profM[3] });
            return;
        }
        // C++ SWITCHDOC log lines
        const sm = text.match(/SWITCHDOC: (.+)/);
        if (sm) {
            events.push({ t: Date.now() - tStart, label: 'cpp:SWITCHDOC', detail: sm[1].substring(0, 100) });
            return;
        }
        // KitWS handleMessage
        if (text.includes('KitWS handleMessage') && text.includes('switchdocument')) {
            events.push({ t: Date.now() - tStart, label: 'kit:got_switchdoc', detail: '' });
            return;
        }
        // handle_cool_message
        if (text.includes('handle_cool_message') && text.includes('switchdocument')) {
            events.push({ t: Date.now() - tStart, label: 'wasm:handle_cool_message', detail: '' });
            return;
        }
    });

    // Open viewer, wait full pre-warm
    ev('test:goto_viewer');
    await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
    ev('test:viewer_loaded');

    // Wait for iframe ready
    let ready = false;
    while (!ready) {
        await sleep(500);
        try {
            const fr = page.frames().find(f => f.url().includes('cool.html'));
            if (fr) ready = await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(() => false);
        } catch(e) {}
    }
    ev('test:prewarm_ready');

    // Click file — START switch profile
    ev('test:click_file_START');
    const switchStart = Date.now();
    await page.evaluate((n) => {
        document.querySelector(`.file[data-name="${n}"]`).click();
    }, DOC_NAME);
    ev('test:after_click');

    // Wait for word count to change (real doc rendered)
    const editorFrame = page.frames().find(f => f.url().includes('cool.html'));
    let renderedAt = 0;
    for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
            const wc = await editorFrame.evaluate(() => document.querySelector('#StateWordCount')?.textContent || '');
            if (/\d/.test(wc) && (wc.includes('word') || wc.includes('character'))) {
                const m = wc.match(/(\d+)\s+words/);
                const words = m ? parseInt(m[1]) : 0;
                if (words >= 1) {
                    ev('test:wc_has_real_words', wc);
                    renderedAt = Date.now() - switchStart;
                    break;
                }
            }
        } catch(e) {}
    }

    // Print full timeline
    console.log('\n══════════ HOT-SWITCH PROFILE ══════════');
    console.log(`Total switch wall time: ${renderedAt}ms\n`);
    console.log('Timestamp(ms) │ Δ(ms) │ Event');
    console.log('──────────────┼───────┼──────────────────────────');
    let prev = events.length > 0 ? events[0].t : 0;
    // Normalize to switch start
    const switchStartT = events.find(e => e.label === 'test:click_file_START')?.t || 0;
    for (const e of events) {
        const tRel = e.t - switchStartT;
        const dt = e.t - prev;
        const rel = (tRel >= 0 ? '+' : '') + tRel;
        console.log(`  ${rel.padStart(6)}ms     │ ${dt.toString().padStart(4)}  │ ${e.label} ${e.detail}`.substring(0, 200));
        prev = e.t;
    }
    console.log('────────────────────────────────────────');
    console.log(`Total ${renderedAt}ms from click → real document visible`);

    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
