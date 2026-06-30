#!/usr/bin/env node
// journey-to-report.js — Phase 2 of the user-journey recorder.
//
// Renders a recorded journey bundle (from journey-recorder.js) as a
// human-readable HTML timeline so a bug journey can be REVIEWED and
// discussed: every event in order with its timestamp, target, and details,
// the fixtures used, and a compact "what happened" narration. Claude (or a
// human) reads this to localize a reported bug before/after codegen.
//
// Usage:
//   node wasm/journey-to-report.js <journey.json> [out.html]
//
// Default output: /tmp/static-deploy/public/reports/journey-<slug>.html
// (matches the reports convention so it's viewable on the stack).

'use strict';
const fs = require('fs');
const path = require('path');

function die(m) { console.error('journey-to-report: ' + m); process.exit(1); }

const inFile = process.argv[2];
if (!inFile) die('usage: node journey-to-report.js <journey.json> [out.html]');
let b;
try { b = JSON.parse(fs.readFileSync(inFile, 'utf8')); }
catch (e) { die('cannot read/parse ' + inFile + ': ' + e.message); }
if (!b || b.version !== 1 || !Array.isArray(b.events)) die('not a v1 journey bundle');

const slug = path.basename(inFile).replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]+/g, '-');
const outFile = process.argv[3]
    || path.join('/tmp/static-deploy/public/reports', 'journey-' + slug + '.html');

const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ms = t => (t / 1000).toFixed(2) + 's';

// One-line human description of an event for the "detail" column.
function describe(ev) {
    switch (ev.type) {
        case 'upload': return 'uploaded fixture ' + (ev.fixtureRef || '?');
        case 'open': return 'opened ' + (ev.name || ev.fixtureRef || '?')
            + (ev.docType ? ' (' + ev.docType + ')' : '');
        case 'hashchange': return 'document switched (hash nav)';
        case 'docReady': return 'document ready' + (ev.name ? ' — ' + ev.name : '');
        case 'pointerdown':
        case 'pointerup':
            return ev.frame === 'editor'
                ? 'canvas ' + ev.type.replace('pointer', '') + ' at ('
                    + (ev.nx != null ? ev.nx.toFixed(3) : '?') + ', '
                    + (ev.ny != null ? ev.ny.toFixed(3) : '?') + ') norm'
                : 'click ' + esc(ev.selector || '');
        case 'keydown': {
            const mods = ['ctrl', 'shift', 'alt', 'meta'].filter(m => ev[m])
                .map(m => m[0].toUpperCase() + m.slice(1));
            return 'key ' + (mods.length ? mods.join('+') + '+' : '') + (ev.key || '?')
                + (ev.frame ? '  [' + ev.frame + ']' : '');
        }
        case 'wheel': return 'scroll dy=' + (ev.dy || 0) + ' dx=' + (ev.dx || 0)
            + (ev.frame ? '  [' + ev.frame + ']' : '');
        default: return ev.type;
    }
}

const typeColor = {
    upload: '#7c4dff', open: '#1565c0', hashchange: '#1565c0', docReady: '#2e7d32',
    pointerdown: '#ef6c00', pointerup: '#ef6c00', keydown: '#00838f', wheel: '#5d4037',
};

const rows = b.events.map((ev, i) => `
  <tr>
    <td class="t">${ms(ev.t)}</td>
    <td><span class="badge" style="background:${typeColor[ev.type] || '#555'}">${esc(ev.type)}</span></td>
    <td class="frame">${esc(ev.frame || '')}</td>
    <td class="detail">${esc(describe(ev))}</td>
  </tr>`).join('');

const fixtureRows = (b.fixtures || []).map(f => `
  <tr><td>${esc(f.ref)}</td><td>${esc(f.name)}</td><td>${esc(f.docType)}</td>
      <td>${(f.size / 1024).toFixed(1)} KB</td><td class="mono">${esc((f.sha256 || '').slice(0, 16))}…</td></tr>`).join('');

const counts = {};
b.events.forEach(e => { counts[e.type] = (counts[e.type] || 0) + 1; });
const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
const duration = b.events.length ? ms(b.events[b.events.length - 1].t) : '0s';

const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Journey — ${esc(slug)}</title>
<style>
 body{font:13px -apple-system,Segoe UI,Arial,sans-serif;margin:24px;color:#222;background:#fafafa;}
 h1{font-size:18px;} h2{font-size:14px;margin-top:24px;}
 .meta{color:#666;font-size:12px;margin-bottom:8px;}
 table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);}
 th,td{text-align:left;padding:5px 9px;border-bottom:1px solid #eee;vertical-align:top;}
 th{background:#f0f0f0;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#555;}
 td.t{font-variant-numeric:tabular-nums;color:#888;white-space:nowrap;width:64px;}
 td.frame{color:#999;width:54px;} td.detail{font-family:ui-monospace,Menlo,monospace;font-size:12px;}
 .badge{color:#fff;border-radius:4px;padding:1px 7px;font-size:11px;}
 .mono{font-family:ui-monospace,Menlo,monospace;}
 .sum{background:#fff;padding:10px 12px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
</style></head><body>
<h1>User journey — ${esc(slug)}</h1>
<div class="meta">recorded ${esc(b.recordedAt || '?')} · ${esc(b.viewerUrl || '')} ·
 viewport ${b.viewport ? b.viewport.width + '×' + b.viewport.height : '?'}</div>
<div class="sum"><b>${b.events.length} events</b> over ${duration} · ${esc(summary)}</div>
<h2>Fixtures (${(b.fixtures || []).length})</h2>
<table><thead><tr><th>ref</th><th>name</th><th>type</th><th>size</th><th>sha256</th></tr></thead>
<tbody>${fixtureRows || '<tr><td colspan="5">none</td></tr>'}</tbody></table>
<h2>Timeline (${b.events.length} events)</h2>
<table><thead><tr><th>t</th><th>type</th><th>frame</th><th>detail</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log('Wrote ' + outFile);
console.log(b.events.length + ' events over ' + duration + ' · ' + summary);
