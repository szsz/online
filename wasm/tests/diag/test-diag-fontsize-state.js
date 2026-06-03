// Diagnostic: when A picks FontHeight=24, does B's kit emit
// `statechanged: .uno:FontHeight=24`? If yes, bug is JS-side (combobox
// doesn't apply state). If no, bug is C++ (kit doesn't emit on
// remote-applied edit) → #177.
const __cl = require('../../lib/inject-checklist');
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs');
const env = require('../../lib/test-env');
const v2 = require('../../lib/v2-upload');

const VIEWER = env.FILE_STORAGE_URL;
const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

async function getEditorFrame(page) {
    return page.frames().find(f => f.url().includes('cool.html'));
}

(async () => {
    log('=== Diag: B receives statechanged on remote FontHeight ===');
    const FIXTURE = require('path').join(__dirname, '..', 'test', 'data', 'new.docx');
    const bytes = fs.readFileSync(FIXTURE);
    const up = await v2.uploadV2(VIEWER, 'fhdiag-' + Date.now() + '.docx', bytes);

    const aMsgs = [], bMsgs = [];
    async function open(label, sink) {
        const ctx = await launch();
        const page = await ctx.browser.newPage();
        page.on('console', m => {
            const t = m.text();
            // Capture statechanged + FontHeight + uno dispatch — anything related
            if (/statechanged|FontHeight|relay.*uno|Kit←relay.*uno/i.test(t)) {
                sink.push(`[${label}] ` + t.substring(0, 200));
            }
        });
        await page.goto(VIEWER + '/#file=' + up.b64urlSecret, { timeout: 60000 });
        // Wait for the doc to load (90s).
        for (let i = 0; i < 180; i++) {
            await sleep(500);
            const fr = await getEditorFrame(page);
            if (fr) {
                const wc = await fr.evaluate(() =>
                    document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
                if (/character/i.test(wc)) { log(`${label} loaded after ${i*0.5}s`); break; }
            }
        }
        return { ctx, page };
    }

    const A = await open('A', aMsgs);
    const B = await open('B', bMsgs);
    await sleep(5000);

    log('A: dispatching uno .uno:FontHeight 24 directly via TheFakeWebSocket');
    const frA = await getEditorFrame(A.page);
    await frA.evaluate(() => {
        // Click into doc, select all, set font height
        globalThis.TheFakeWebSocket.send('key type=input char=0 key=9221'); // End
        globalThis.TheFakeWebSocket.send('key type=input char=65 key=512'); // Ctrl-A
        setTimeout(() => {
            const msg = 'uno .uno:FontHeight {"FontHeight.Height": {"type":"float","value":"24"}}';
            globalThis.TheFakeWebSocket.send(msg);
        }, 300);
    });

    log('Waiting 8s for state propagation...');
    await sleep(8000);

    log('=== A statechanged events ===');
    aMsgs.filter(s => s.includes('statechanged')).slice(0, 15).forEach(m => log(m));
    log(`(A captured ${aMsgs.length} relevant lines total)`);

    log('=== B statechanged events ===');
    bMsgs.filter(s => s.includes('statechanged')).slice(0, 15).forEach(m => log(m));
    log(`(B captured ${bMsgs.length} relevant lines total)`);

    log('=== A FontHeight-specific ===');
    aMsgs.filter(s => /FontHeight/i.test(s)).slice(0, 10).forEach(m => log(m));
    log('=== B FontHeight-specific ===');
    bMsgs.filter(s => /FontHeight/i.test(s)).slice(0, 10).forEach(m => log(m));

    fs.writeFileSync('/tmp/diag-fontsize-A.log', aMsgs.join('\n'));
    fs.writeFileSync('/tmp/diag-fontsize-B.log', bMsgs.join('\n'));
    log('Full logs: /tmp/diag-fontsize-A.log, /tmp/diag-fontsize-B.log');

    await A.ctx.browser.close();
    await B.ctx.browser.close();
    process.exit(0);
})().catch(e => { console.error('crash:', e); process.exit(2); });
