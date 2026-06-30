const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const URL = 'https://szebeni-wasm-viewer.azurewebsites.net/?singleuser';
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    async function visit(label) {
        const page = await browser.newPage();
        const lines = [];
        page.on('console', m => lines.push({ type: m.type(), text: m.text() }));
        page.on('pageerror', e => lines.push({ type: 'pageerror', text: String(e) }));
        await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
        await new Promise(r => setTimeout(r, 25000));
        console.log(`[${label}] captured ${lines.length} events`);
        const stack = {};
        for (const l of lines) {
            const head = l.text.split('\n')[0].slice(0, 90);
            stack[head] = (stack[head] || 0) + 1;
        }
        const sorted = Object.entries(stack).sort((a,b) => b[1]-a[1]).slice(0, 12);
        for (const [head, n] of sorted) console.log(`  ${n.toString().padStart(4)}× ${head}`);
        fs.writeFileSync(`/tmp/spam-${label}.log`, lines.map(l => `[${l.type}] ${l.text}`).join('\n---\n'));
        await page.close();
        return lines.length;
    }

    const cold = await visit('cold');
    console.log('---');
    const warm = await visit('warm');
    console.log(`\nCOLD ${cold} lines vs WARM ${warm} lines`);
    await browser.close();
})();
