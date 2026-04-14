const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const VIEWER = 'https://viewer.szebeni.hu:6934';
const DOC_NAME = 'profile-canvas.odt';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new', args: ['--no-sandbox','--ignore-certificate-errors','--enable-features=SharedArrayBuffer'],
    });
    const up = await browser.newPage();
    await up.goto(VIEWER + '/');
    const bytes = fs.readFileSync(path.join(__dirname,'..','test','data','3pages.odt'));
    await up.evaluate(async (n,a) => fetch('/api/files/'+encodeURIComponent(n),{method:'POST',body:new Blob([new Uint8Array(a)])}), DOC_NAME, Array.from(bytes));
    await up.close();

    const page = await browser.newPage();
    await page.goto(VIEWER + '/');
    while (true) {
        await sleep(500);
        const fr = page.frames().find(f => f.url().includes('cool.html'));
        if (fr && await fr.evaluate(() => !!window.__wasmPrewarmReady).catch(()=>false)) break;
    }
    console.log('Pre-warm done. Sampling canvas every 50ms during switch...');
    const fr = page.frames().find(f => f.url().includes('cool.html'));
    const baselineCanvas = await fr.evaluate(() => {
        const c = document.querySelector('canvas');
        return c ? c.toDataURL().substring(0, 200) : null;
    });
    console.log('Baseline canvas hash:', baselineCanvas?.substring(0,60));
    const t0 = Date.now();
    await page.evaluate(n => document.querySelector(`.file[data-name="${n}"]`).click(), DOC_NAME);
    console.log('Clicked at t=0');
    let firstCanvasChange = -1, firstWcChange = -1;
    for (let i = 0; i < 200; i++) {
        await sleep(50);
        try {
            const state = await fr.evaluate(() => {
                const c = document.querySelector('canvas');
                const wc = document.querySelector('#StateWordCount');
                return {
                    canvas: c ? c.toDataURL().substring(0, 200) : null,
                    wc: wc ? wc.textContent : '',
                };
            });
            const t = Date.now() - t0;
            if (firstCanvasChange < 0 && state.canvas && state.canvas !== baselineCanvas) {
                firstCanvasChange = t;
                console.log(`+${t}ms: CANVAS pixels changed`);
            }
            if (firstWcChange < 0 && /\d/.test(state.wc) && state.wc.match(/(\d+)\s*words/)?.[1] >= '1') {
                const m = state.wc.match(/(\d+)/);
                if (m && parseInt(m[1]) >= 1) {
                    firstWcChange = t;
                    console.log(`+${t}ms: WC text "${state.wc}"`);
                    break;
                }
            }
        } catch(e) {}
    }
    console.log(`\nFirst canvas pixel change: ${firstCanvasChange}ms`);
    console.log(`First wc text update:      ${firstWcChange}ms`);
    await browser.close();
})();
