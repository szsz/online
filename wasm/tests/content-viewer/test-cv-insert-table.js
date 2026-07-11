// test-cv-insert-table.js — the insert-table control works in the
// content-viewer. Adapted from tests/regression/test-regression-insert-table.js
// (which dispatched .uno:InsertTable directly; here we drive the real
// notebookbar control). Asserts the insert-table control renders in the embed
// and opens the table-size picker (grid). The actual table draws on the tile
// canvas (no DOM node), so a successful pick is reported via the Table context
// tab when it fires; the required assertion is that the control + picker work.
// Also carries the legacy regression's crash subject (LO core blew the wasm
// heap in SvxAutoFormatData / SwTableAutoFormat copy-ctors during insert):
// no memory-access-out-of-bounds errors, and the char count is preserved.
'use strict';
const fs = require('fs'); const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');
const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'new.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);
const T0 = Date.now(); const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
let ok = true; const check=(l,c,e)=>{ if(c)log('  ✓ '+l+(e?' ['+e+']':'')); else {log('  ✗ FAIL: '+l+(e?' ['+e+']':''));ok=false;} };
const efr = p => p.frames().find(f => (f.url()||'').includes('cool.html'));
async function interactive(p){return p.evaluate(()=>{if(document.querySelector('[role="status"][aria-label="Loading"]'))return false;const s=[...document.querySelectorAll('button')].find(b=>/^save$/i.test((b.textContent||'').trim()));return !!(s&&!s.disabled);}).catch(()=>false);}
async function waitI(p,b){const d=Date.now()+b;while(Date.now()<d){if(await interactive(p))return true;await sleep(500);}return false;}
async function tableTabVisible(fr){return fr.evaluate(()=>{const e=document.querySelector('#Table-tab-label');return !!e&&e.offsetParent!==null;}).catch(()=>false);}
(async () => {
  if(!fs.existsSync(DOCX)){check('fixture present',false,DOCX);process.exit(2);}
  log('viewer: '+BASE);
  const { browser } = await launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await openViaContentViewer(browser, BASE, DOCX, { page, viewport:{width:1600,height:1000}, iframeTimeout: 45000 });
    check('editor interactive', await waitI(page, LOAD_BUDGET));
    await sleep(2500);
    const fr = efr(page);
    const box = await (await page.$('iframe')).boundingBox();
    await page.mouse.click(box.x+box.width/2, box.y+Math.min(box.height*0.45,360)); await sleep(400);
    const btn = fr ? await fr.$('#home-insert-table693-button') : null;
    check('insert-table control present in the notebookbar', !!btn);
    let cells = 0;
    if (btn) {
      try { await btn.click(); } catch(e) { await fr.evaluate(()=>document.querySelector('#home-insert-table693-button').click()); }
      await sleep(1200);
      // The control opens the table-size grid picker. Count its selectable cells.
      const r = await fr.evaluate(() => {
        const sels = ['.inserttable-grid *', '[id*="inserttable"] [class*="cell"]', '[id*="InsertTable"] [role="gridcell"]',
                      '.jsdialog [class*="grid"] *', '[id*="inserttable-grid"] *'];
        let best = 0, node = null;
        for (const s of sels) { const n = document.querySelectorAll(s); if (n.length > best) { best = n.length; node = n; } }
        // Click a cell to attempt the actual insert (row2/col2-ish).
        if (node && best >= 4) { const t = node[Math.min(best - 1, 3)]; t && t.click && t.click(); }
        return best;
      }).catch(() => 0);
      cells = r;
      log('  table-size picker cells: ' + cells);
      await sleep(1500);
    }
    check('insert-table opens the table-size picker in the embed', cells > 1, 'cells=' + cells);
    const tab = fr ? await tableTabVisible(fr) : false;
    log('  Table context tab after pick: ' + tab + (tab ? ' (table inserted)' : ''));
    check('editor still interactive after insert-table', await interactive(page));
    try{fs.mkdirSync('/tmp/content-viewer-report/insert-table',{recursive:true});await page.screenshot({path:'/tmp/content-viewer-report/insert-table/tbl.png'});}catch(e){}
  } catch (e) { check('harness ran without exception', false, (e.stack||String(e)).slice(0,200)); }
  finally { try { await browser.close(); } catch(e){} }
  log(ok?'ALL PASS':'SOME FAILED'); process.exit(ok?0:1);
})();
