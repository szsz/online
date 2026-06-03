const puppeteer = require('puppeteer');
(async () => {
    let pass = 0, fail = 0;
    for (let i = 1; i <= 2; i++) {
        const userDir = '/tmp/cold-only-' + Date.now();
        const browser = await puppeteer.launch({
            headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'],
            ignoreHTTPSErrors:true, userDataDir: userDir,
            defaultViewport:{width:1280,height:800},
        });
        const page = await browser.newPage();
        try {
            const t0 = Date.now();
            await page.goto('https://viewer.szebeni.hu/#file=oFEV3Kl6xln4lr8rX5r95g', { waitUntil:'load', timeout:30000 });
            await new Promise(r => setTimeout(r, 60000));
            const editor = page.frames().find(f => f.url().includes('cool.html'));
            const dom = editor ? await editor.evaluate(() => {
                const c = document.querySelector('canvas');
                return { docName: document.querySelector('#document-name-input')?.value || '', canvasW: c?.width || 0 };
            }) : { docName:'?' };
            const ok = dom.canvasW > 200;
            console.log(`visit ${i}: doc="${dom.docName}" canvas=${dom.canvasW}px in ${((Date.now()-t0)/1000).toFixed(1)}s ${ok?'✓':'✗'}`);
            ok ? pass++ : fail++;
        } catch (e) { fail++; console.log(`visit ${i}: error ${e.message}`); }
        await browser.close();
        require('fs').rmSync(userDir, { recursive:true, force:true });
    }
    console.log(`\nresult: ${pass} pass, ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
})();
