// test-cv-xlsx-sheet-nav.js — Calc sheet UI works in the content-viewer.
// Adapted from tests/regression/test-regression-xlsx-sheet-nav.js. The bundled
// fixture is single-sheet, so this asserts the Calc sheet chrome renders +
// the sheet-nav controls are present/functional in the embed (the content-
// viewer-relevant concern), rather than multi-sheet switching.
'use strict';
const fs = require('fs'); const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');
const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const XLSX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'testdoc.xlsx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);
const T0 = Date.now(); const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
let ok = true; const check=(l,c,e)=>{ if(c)log('  ✓ '+l+(e?' ['+e+']':'')); else {log('  ✗ FAIL: '+l+(e?' ['+e+']':''));ok=false;} };
const efr = p => p.frames().find(f => (f.url()||'').includes('cool.html'));
async function interactive(p){return p.evaluate(()=>{if(document.querySelector('[role="status"][aria-label="Loading"]'))return false;const s=[...document.querySelectorAll('button')].find(b=>/^save$/i.test((b.textContent||'').trim()));return !!(s&&!s.disabled);}).catch(()=>false);}
async function waitI(p,b){const d=Date.now()+b;while(Date.now()<d){if(await interactive(p))return true;await sleep(500);}return false;}
(async () => {
  if(!fs.existsSync(XLSX)){check('fixture present',false,XLSX);process.exit(2);}
  log('viewer: '+BASE);
  const { browser } = await launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await openViaContentViewer(browser, BASE, XLSX, { page, iframeTimeout: 45000 });
    check('Calc doc became interactive', await waitI(page, LOAD_BUDGET));
    await sleep(2500);
    const fr = efr(page);
    const info = fr ? await fr.evaluate(() => ({
      status: document.querySelector('#StatusDocPos')?.textContent || '',
      tab: !!document.querySelector('#spreadsheet-tab0, [id^="spreadsheet-tab"]'),
      nav: !!document.querySelector('#nextrecord-button, #lastrecord-button'),
    })).catch(()=>({})) : {};
    check('Calc sheet status present (Sheet N of M)', /Sheet\s*\d+\s*of/i.test(info.status||''), 'status="'+(info.status||'')+'"');
    check('sheet tab rendered', !!info.tab);
    check('sheet-nav buttons present', !!info.nav);
    // Click a nav button — must not crash the editor (still interactive).
    if (fr && info.nav) { try { await fr.evaluate(()=>{const b=document.querySelector('#lastrecord-button');b&&b.click();}); } catch(e){} await sleep(1200); }
    check('editor still interactive after sheet-nav click', await interactive(page));
    try{fs.mkdirSync('/tmp/content-viewer-report/xlsx',{recursive:true});await page.screenshot({path:'/tmp/content-viewer-report/xlsx/calc.png'});}catch(e){}
  } catch (e) { check('harness ran without exception', false, (e.stack||String(e)).slice(0,200)); }
  finally { try { await browser.close(); } catch(e){} }
  log(ok?'ALL PASS':'SOME FAILED'); process.exit(ok?0:1);
})();
