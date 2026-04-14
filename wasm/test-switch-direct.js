const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const EDITOR = 'https://wasm.atgpartners.info:6932';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDoc(frame, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        try {
            const r = await frame.evaluate(() => {
                const wc = document.querySelector('#StateWordCount');
                return wc?.textContent || '';
            });
            if (/\d.*word/.test(r)) return Date.now() - t0;
        } catch(e) {}
        await sleep(200);
    }
    return -1;
}

(async () => {
    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer'],
    });
    try {
        // Upload two docs
        const up = await browser.newPage();
        await up.goto(EDITOR + '/editor.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
        const doc1 = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'test document.docx'));
        const doc2 = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', '3pages.odt'));
        await up.evaluate(async (u, arr1, arr2) => {
            await fetch(u + '/wasm/doc1.docx', { method: 'POST', body: new Blob([new Uint8Array(arr1)]) });
            await fetch(u + '/wasm/doc2.odt', { method: 'POST', body: new Blob([new Uint8Array(arr2)]) });
        }, EDITOR, Array.from(doc1), Array.from(doc2));
        await up.close();
        console.log('Uploaded both docs');

        const page = await browser.newPage();
        const coolLogs = [];
        page.on('console', msg => {
            const t = msg.text();
            if (/docbroker|switchdoc|DocumentBroker|SWITCHDOC|load|Kit|ChildSession/i.test(t)) {
                coolLogs.push(t);
            }
        });
        page.on('pageerror', e => console.log('PE: ' + e.message));

        // Load doc1 — let it fully render
        const t0 = Date.now();
        await page.goto(EDITOR + '/browser/cool.html?WOPISrc=doc1.docx&access_token=test',
            { waitUntil: 'domcontentloaded', timeout: 30000 });
        const loaded = await waitForDoc(page.mainFrame(), 120000);
        console.log(`doc1 loaded in ${loaded}ms`);
        await sleep(2000);

        // Now try to switch — first clear logs
        coolLogs.length = 0;
        console.log('--- Sending switchdocument ---');
        const tSwitch = Date.now();
        await page.evaluate(() => {
            if (typeof postMobileMessage === 'function') {
                postMobileMessage('switchdocument url=' + window.location.origin + '/wasm/doc2.odt');
            } else {
                console.log('postMobileMessage not available!');
            }
        });

        // Wait and capture what happens
        for (let i = 0; i < 60; i++) {
            await sleep(1000);
            const wc = await page.evaluate(() => document.querySelector('#StateWordCount')?.textContent || '');
            if (wc.includes('word') && wc.match(/[\d,]+/)) {
                console.log(`After ${i+1}s: wc=[${wc}]`);
            }
            if (i === 0 || i === 5 || i === 15 || i === 30) {
                console.log(`[t+${i}s] wc=[${wc}]`);
            }
        }

        console.log(`\n--- COOL LOGS (${coolLogs.length}) ---`);
        coolLogs.slice(0, 40).forEach(l => console.log('  ' + l.substring(0, 250)));
    } finally {
        await browser.close();
    }
})();
