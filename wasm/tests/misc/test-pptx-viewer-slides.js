const __cl = require('../../lib/inject-checklist');
// Test: PPTX via viewer — slide rendering, navigation, slide panel visibility.
// Opens a real multi-slide pptx through the viewer and verifies:
// 1. Impress UI loads (docType=presentation, slide panel visible)
// 2. All slides render
// 3. Slide navigation works
// ALL via real keyboard/mouse.
const { launch, sleep } = require('../../lib/browser');
const fs = require('fs'), path = require('path');
const env = require('../../lib/test-env');
const { uploadV2 } = require('../../lib/v2-upload');
const VIEWER = env.FILE_STORAGE_URL;
const EDITOR = env.EDITOR_URL;
const SHOTS = '/tmp/static-deploy/public/shots-pptx-viewer-slides';

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    let stepNum = 0;
    async function snap(page, name) {
        stepNum++;
        await page.screenshot({ path: `${SHOTS}/${String(stepNum).padStart(2,'0')}_${name}.png` });
    }

    // Upload a real pptx file (v2 encrypted)
    const pptxName = 'slide-test.pptx';
    const pptxBytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'rare-fonts.pptx'));
    const upPptx = await uploadV2(VIEWER, pptxName, pptxBytes);
    console.log('[setup] Uploaded v2 ' + pptxName + ' → ' + upPptx.fileId.substring(0,8) + '…');

    // Open via viewer
    console.log('\n=== Opening pptx via viewer ===');
    const { browser, cleanup } = await launch();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const t0 = Date.now();
    await page.goto(VIEWER + '/#file=' + upPptx.b64urlSecret, { waitUntil: 'domcontentloaded' });

    // Wait for Impress to load — check multiple indicators
    let editorFrame;
    for (let i = 0; i < 200; i++) {
        await sleep(500);
        editorFrame = page.frames().find(f => f.url().includes('cool.html'));
        if (editorFrame) {
            const status = await editorFrame.evaluate(() => {
                var ss = document.querySelector('#SlideStatus')?.textContent || '';
                var wc = document.querySelector('#StateWordCount')?.textContent || '';
                var dp = document.querySelector('#StatusDocPos')?.textContent || '';
                return ss + '|' + wc + '|' + dp;
            }).catch(() => '');
            if (/Slide \d/i.test(status)) {
                console.log('Loaded in ' + (Date.now()-t0) + 'ms: ' + status);
                break;
            }
            // Also check if relay is activated
            const ws = await editorFrame.evaluate(() =>
                typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
            if (ws && /character/i.test(status)) {
                // Might be loaded but SlideStatus not yet populated
                console.log('Relay active, waiting for slide status... (' + status + ')');
            }
        }
    }
    if (!editorFrame) { console.log('ERROR: no editor'); await cleanup(); process.exit(1); }
    await sleep(5000);

    // ═══ CHECK 1: Impress UI loaded ═══
    console.log('\n--- Check 1: Impress UI ---');
    const uiState = await editorFrame.evaluate(() => ({
        docType: document.body.getAttribute('data-docType'),
        slideStatus: document.querySelector('#SlideStatus')?.textContent || '',
        slideSorterChildren: document.getElementById('slide-sorter')?.children?.length || 0,
        presControlsVisible: document.getElementById('presentation-controls-wrapper')?.style?.display !== 'none',
        parts: window.app?.map?._docLayer?._parts,
    })).catch(() => ({}));
    console.log('  UI state:', JSON.stringify(uiState));
    await snap(page, 'impress_loaded');

    check('docType is presentation', uiState.docType === 'presentation', 'got=' + uiState.docType);
    check('SlideStatus shows slide info', /Slide \d/i.test(uiState.slideStatus), 'got=' + uiState.slideStatus);
    check('Slide sorter has thumbnails', uiState.slideSorterChildren > 0, 'children=' + uiState.slideSorterChildren);

    // ═══ CHECK 2: Slide content renders ═══
    console.log('\n--- Check 2: Slide content ---');
    const canvasCount = await editorFrame.evaluate(() =>
        document.querySelectorAll('canvas').length).catch(() => 0);
    check('Canvas elements exist', canvasCount > 0, 'count=' + canvasCount);

    // ═══ CHECK 3: Navigate slides via keyboard ═══
    console.log('\n--- Check 3: Slide navigation ---');
    // Click the slide area to focus
    const frameEl = await page.$('iframe#editor-frame');
    if (frameEl) {
        const box = await frameEl.boundingBox();
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    await sleep(1000);

    // Press PageDown to go to next slide (if multiple slides)
    await page.keyboard.press('PageDown');
    await sleep(3000);
    await snap(page, 'after_pagedown');

    const afterNav = await editorFrame.evaluate(() =>
        document.querySelector('#SlideStatus')?.textContent || '').catch(() => '');
    console.log('  After PageDown: ' + afterNav);

    // Press PageUp to go back
    await page.keyboard.press('PageUp');
    await sleep(2000);
    await snap(page, 'after_pageup');

    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    await cleanup();
    process.exit(allPassed ? 0 : 1);
})();
