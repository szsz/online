// test-cv-filename-open.js — opening files whose names have spaces, parens,
// or awkward dots must work in the content-viewer.
//
// content-preview puts the filename into the Emscripten-FS path
// (/tmp/<fsName>, used by constructCoolUrl to load and by exportCurrentDocument
// to read back). A raw name with spaces / parentheses / multiple or edge dots
// breaks LO's local-file open, so these documents never load. The fix
// sanitizes fsName (keeping the real name for display + download). This test
// opens a copy of new.docx under each tricky name and asserts it becomes
// interactive (editor usable) — i.e. the file actually opened.
//
// Usage: node wasm/tests/content-viewer/test-cv-filename-open.js [base-url]

'use strict';

const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');

const BASE = (process.argv[2] || process.env.BASE_URL
    || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const SRC = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const WORK = '/tmp/cv-filenames';
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);

const NAMES = [
    'Interview March 30 16-00.docx',
    'alma..docx',
    'korte. .docx',
    'test (1).docx',
];

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
let allPassed = true;
function check(label, cond, ev) {
    if (cond) log(`  ✓ ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function interactive(page) {
    return page.evaluate(() => {
        if (document.querySelector('[role="status"][aria-label="Loading"]')) return false;
        const s = [...document.querySelectorAll('button')].find(b => /^save$/i.test((b.textContent || '').trim()));
        return !!(s && !s.disabled);
    }).catch(() => false);
}
async function charCount(page) {
    const fr = page.frames().find(f => (f.url() || '').includes('cool.html'));
    if (!fr) return -1;
    const t = await fr.evaluate(() => document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
    const m = t.match(/([\d,]+)\s*character/);
    return m ? parseInt(m[1].replace(/,/g, '')) : -1;
}

(async () => {
    if (!fs.existsSync(SRC)) { check('source fixture present', false, SRC); process.exit(2); }
    fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });
    const bytes = fs.readFileSync(SRC);
    log('viewer: ' + BASE);

    // Fresh browser per file so the filename result isn't confounded by
    // warm-cache / sequential-open state — each open is an independent cold load.
    for (const name of NAMES) {
        const p = path.join(WORK, name);
        fs.writeFileSync(p, bytes);
        log(`open "${name}"`);
        const { browser } = await launch({ headless: 'new' });
        const page = await browser.newPage();
        try {
            await openViaContentViewer(browser, BASE, p, { page, iframeTimeout: 45000 });
            const ok = await (async () => {
                const d = Date.now() + LOAD_BUDGET;
                while (Date.now() < d) { if (await interactive(page)) return true; await sleep(500); }
                return false;
            })();
            await sleep(1500);
            const cc = await charCount(page);
            check(`open "${name}"`, ok && cc >= 0, `interactive=${ok} chars=${cc}`);
        } catch (e) {
            check(`open "${name}"`, false, (e.message || String(e)).slice(0, 120));
        } finally {
            try { await browser.close(); } catch (e) {}
        }
    }
    log(allPassed ? 'ALL PASS' : 'SOME FAILED');
    process.exit(allPassed ? 0 : 1);
})();
