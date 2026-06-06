const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
    const URL = 'https://szebeni-wasm-viewer.azurewebsites.net/?singleuser';
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    const allLines = [];
    const stack = {};  // map: top-of-stack-fn → count

    page.on('console', m => {
        const txt = m.text();
        allLines.push({ type: m.type(), text: txt });
        const head = txt.split('\n')[0].slice(0, 80);
        stack[head] = (stack[head] || 0) + 1;
    });
    page.on('pageerror', e => {
        allLines.push({ type: 'pageerror', text: String(e) });
    });

    console.log('[probe] navigating to', URL);
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });

    console.log('[probe] waiting 30s for spam to accumulate...');
    await new Promise(r => setTimeout(r, 30000));

    console.log('[probe] uploading new.docx via the UI...');
    // We just want cold-open landing page chatter, no upload needed
    
    console.log(`[probe] captured ${allLines.length} console events total`);
    console.log('[probe] top 15 unique heads by occurrence:');
    const sorted = Object.entries(stack).sort((a,b) => b[1]-a[1]).slice(0, 15);
    for (const [head, n] of sorted) console.log(`  ${n.toString().padStart(4)}× ${head}`);

    const mailboxLines = allLines.filter(l => /mailbox|checkMailbox|_mb/.test(l.text));
    console.log(`[probe] mailbox lines: ${mailboxLines.length}`);
    if (mailboxLines.length > 0) {
        console.log('[probe] sample mailbox lines:');
        for (const l of mailboxLines.slice(0, 5)) {
            console.log('  ' + l.type + ': ' + l.text.slice(0, 200));
        }
    }

    fs.writeFileSync('/tmp/mailbox-spam-full.log',
        allLines.map(l => `[${l.type}] ${l.text}`).join('\n---\n'));
    console.log('[probe] full log: /tmp/mailbox-spam-full.log');

    await browser.close();
})();
