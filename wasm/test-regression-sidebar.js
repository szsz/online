const __cl = require('./lib/inject-checklist');
// Regression test: sidebar collapses to a thin bar when a file is opened, and
// re-expands when the user moves the mouse to the left edge or clicks the bar.
//
// Why this regression exists: with a 300px sidebar permanently visible the
// editor canvas was cramped on small screens; the user asked for the file
// list to collapse to a 12px hot-zone after opening a document so the editor
// gets the full viewport.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const env = require('./lib/test-env');

const VIEWER = env.FILE_STORAGE_URL;
const SHOT_DIR = '/tmp/static-deploy/public/shots-regression-sidebar';
const DOC_NAME = 'sidebar-test.docx';
const DOC_PATH = path.join(__dirname, '..', 'test', 'data', 'new.docx');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`); }

let shotNum = 0;
async function snap(page, name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${String(++shotNum).padStart(2,'0')}_${name}.png`;
    try { await page.screenshot({ path: `${SHOT_DIR}/${f}` }); } catch(e) {}
}

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}${ev?' ['+ev+']':''}`); allPassed = false; }
}

async function getSidebarState(page) {
    return page.evaluate(() => {
        const files = document.getElementById('files');
        const body = document.body;
        return {
            collapsedClass: body.classList.contains('docs-collapsed'),
            hoverClass:     body.classList.contains('docs-hover'),
            width:          files ? files.getBoundingClientRect().width : -1,
        };
    });
}

(async () => {
    log('=== Regression: sidebar collapse on file open ===');
    fs.rmSync(SHOT_DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    if (!fs.existsSync(DOC_PATH)) { log('ERROR: fixture missing: ' + DOC_PATH); process.exit(1); }

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });

    try {
        // Upload via the viewer's file-storage API
        const up = await browser.newPage();
        await up.goto(VIEWER + '/');
        const bytes = fs.readFileSync(DOC_PATH);
        await up.evaluate(async (n, a) => {
            await fetch('/api/files/' + encodeURIComponent(n), {
                method: 'POST', body: new Blob([new Uint8Array(a)]),
            });
        }, DOC_NAME, Array.from(bytes));
        await up.close();
        log('Uploaded ' + DOC_NAME);

        const page = await browser.newPage();
        await page.setCacheEnabled(false);
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(VIEWER + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#files');
        // Wait for the file list to populate
        await page.waitForFunction(n => !!document.querySelector(`.file[data-name="${n}"]`),
            {}, DOC_NAME);

        await snap(page, 'initial');
        let s = await getSidebarState(page);
        log(`Initial sidebar: width=${s.width}px, collapsed=${s.collapsedClass}`);
        check('Sidebar starts expanded (>= 200px wide)', s.width >= 200);
        check('No docs-collapsed class initially', s.collapsedClass === false);

        // Click the file
        await page.evaluate(n => {
            document.querySelector(`.file[data-name="${n}"]`).click();
        }, DOC_NAME);
        // Collapse should be immediate (synchronous in openFile)
        await sleep(200);

        await snap(page, 'after_click');
        s = await getSidebarState(page);
        log(`After click sidebar: width=${s.width}px, collapsed=${s.collapsedClass}`);
        check('docs-collapsed class added on file open', s.collapsedClass === true);
        check('Sidebar visually narrow after open (<= 30px)', s.width > 0 && s.width <= 30,
              'width=' + s.width);

        // Trigger the hover-zone mouseenter to expand. We dispatch the event
        // directly because puppeteer's mouse simulation through the iframe
        // is unreliable in headless mode (the iframe captures mousemove
        // events before they bubble back to the parent doc).
        await page.evaluate(() => {
            document.getElementById('sidebar-hover-zone').dispatchEvent(
                new MouseEvent('mouseenter', { bubbles: false }));
        });
        await sleep(300);
        await snap(page, 'hover_expanded');
        s = await getSidebarState(page);
        log(`After hover sidebar: width=${s.width}px, hover=${s.hoverClass}`);
        check('docs-hover class added on edge hover', s.hoverClass === true);
        check('Sidebar expands on hover (>= 200px)', s.width >= 200);
        check('Still has docs-collapsed (overlay mode, not pinned open)',
              s.collapsedClass === true);

        // Simulate the cursor entering an element outside the sidebar (e.g.
        // the editor pane). The document-level mouseover handler should
        // schedule a collapse.
        await page.evaluate(() => {
            const ep = document.getElementById('editor-pane');
            const ev = new MouseEvent('mouseover', { bubbles: true, cancelable: true });
            ep.dispatchEvent(ev);
        });
        await sleep(800);  // 500ms scheduleCollapse + buffer
        await snap(page, 'hover_left');
        s = await getSidebarState(page);
        log(`After mouse-out sidebar: width=${s.width}px, hover=${s.hoverClass}`);
        check('docs-hover removed when cursor moves outside sidebar', s.hoverClass === false);
        check('Sidebar re-collapses to thin bar (<= 30px)', s.width > 0 && s.width <= 30);

        // Click the thin bar to re-expand. Dispatch a click event on #files
        // itself (target===filesEl) to simulate clicking on the bar background.
        await page.evaluate(() => {
            const fl = document.getElementById('files');
            fl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await sleep(300);
        await snap(page, 'click_expanded');
        s = await getSidebarState(page);
        log(`After click-bar sidebar: width=${s.width}px, hover=${s.hoverClass}`);
        check('Click on collapsed bar expands sidebar', s.hoverClass === true && s.width >= 200);

        log('\n' + (allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'));
    } catch(e) {
        log('Error: ' + e.message);
        allPassed = false;
    } finally {
        await browser.close();
        log('Done.');
        process.exit(allPassed ? 0 : 1);
    }
})();
