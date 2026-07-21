// test-cv-chart.js — a document with an embedded chart opens + renders in the
// content-viewer. Adapted from tests/misc/test-chart.js.
'use strict';
const fs = require('fs'); const path = require('path');
const { launch, sleep } = require('../../lib/browser');
const { scaleTimeout } = require('../../lib/test-env');
const { openViaContentViewer } = require('../../lib/open-via-content-viewer');
const BASE = (process.argv[2] || process.env.BASE_URL || 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');
const DOCX = path.join(__dirname, '..', '..', '..', 'test', 'data', 'chart-test.docx');
const LOAD_BUDGET = parseInt(process.env.LOAD_BUDGET || '150000', 10);
const T0 = Date.now(); const log = m => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s] ${m}`);
let ok = true; const check=(l,c,e)=>{ if(c)log('  ✓ '+l+(e?' ['+e+']':'')); else {log('  ✗ FAIL: '+l+(e?' ['+e+']':''));ok=false;} };
const efr = p => p.frames().find(f => (f.url()||'').includes('cool.html'));
async function interactive(p){return p.evaluate(()=>{if(document.querySelector('[role="status"][aria-label="Loading"]'))return false;const s=[...document.querySelectorAll('button')].find(b=>/^save$/i.test((b.textContent||'').trim()));return !!(s&&!s.disabled);}).catch(()=>false);}
async function waitI(p,b){const d=Date.now()+b;while(Date.now()<d){if(await interactive(p))return true;await sleep(500);}return false;}
(async () => {
  if(!fs.existsSync(DOCX)){check('fixture present',false,DOCX);process.exit(2);}
  log('viewer: '+BASE);
  const { browser } = await launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await openViaContentViewer(browser, BASE, DOCX, { page, iframeTimeout: 45000 });
    check('chart doc became interactive', await waitI(page, LOAD_BUDGET));
    // Poll for the status bar to populate: #StateWordCount appears only once the
    // canvas has rendered the doc, which lags the viewer's "interactive" state —
    // a fixed sleep read it empty (status=""). Same render-timing fix as the
    // other CV tests.
    let st = '';
    const stDeadline = Date.now() + scaleTimeout(30000);
    while (Date.now() < stDeadline) {
      const fr0 = efr(page);
      st = fr0 ? await fr0.evaluate(()=>document.querySelector('#StateWordCount')?.textContent||'').catch(()=>'') : '';
      if (/character/i.test(st)) break;
      await sleep(500);
    }
    const fr = efr(page);
    check('chart doc loaded (status bar populated)', /character/i.test(st), 'status="'+st+'"');
    const canvas = fr ? await fr.evaluate(()=>document.querySelectorAll('canvas').length>0).catch(()=>false) : false;
    check('editor canvas rendered', canvas);
    try{fs.mkdirSync('/tmp/content-viewer-report/chart',{recursive:true});await page.screenshot({path:'/tmp/content-viewer-report/chart/chart.png'});}catch(e){}
  } catch (e) { check('harness ran without exception', false, (e.stack||String(e)).slice(0,200)); }
  finally { try { await browser.close(); } catch(e){} }
  log(ok?'ALL PASS':'SOME FAILED'); process.exit(ok?0:1);
})();
