const puppeteer = require('puppeteer');
const fs = require('fs');
const EDITOR = 'https://wasm.atgpartners.info:6932';
const SHOT = '/tmp/static-deploy/public/shots-progress';
fs.mkdirSync(SHOT, { recursive: true });

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.goto(EDITOR + '/editor.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async (u) => {
        await fetch(u + '/wasm/progress-test.txt', { method: 'POST', body: new Blob(['hi']) });
    }, EDITOR);
    await page.close();

    const p = await ctx.newPage();
    p.on('console', m => { if (/progress|overlay|wasm-loader|profile/i.test(m.text())) console.log('>>', m.text()); });
    await p.goto(EDITOR + '/browser/cool.html?WOPISrc=progress-test.txt&access_token=test',
        { waitUntil: 'domcontentloaded' });

    // Snap every 1.5s to show progress
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
            const state = await p.evaluate(() => ({
                overlay: !!document.getElementById('wasm-loading-overlay'),
                label: document.getElementById('wasm-progress-label')?.textContent,
                pct: document.getElementById('wasm-progress-bar-fill')?.style.width,
                detail: document.getElementById('wasm-progress-detail')?.textContent,
            }));
            await p.screenshot({ path: `${SHOT}/${String(i).padStart(2,'0')}.png` }).catch(()=>{});
            console.log(`t=${(i*1.5).toFixed(1)}s  overlay=${state.overlay}  label=[${state.label}]  pct=${state.pct}  detail=${state.detail?.substring(0,80)}`);
            if (!state.overlay) break;
        } catch(e) { break; }
    }
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
