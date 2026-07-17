#!/usr/bin/env node
// cv-run-report.js — render the CV test-run provenance table pages.
//
// Usage: node cv-run-report.js <run.json> <out-dir> [existing-runs.json]
//
//   run.json     this run's record: { runId, startedUtc, wallSeconds,
//                provenance: { cp_commit, cp_branch, cp_url,
//                              editor_version, editor_commit, editor_build_id,
//                              lo_build_id, lo_commit },
//                results: [ { slug, title, status, seconds, log } ] }
//   out-dir      writes <out-dir>/index.html (per-run page) and
//                <out-dir>/runs.json + <out-dir>/runs-index.html (rolling
//                table, newest first, seeded from existing-runs.json).
//
// The rolling table is what the user consults: one row per run with the
// content-preview commit, editor commit+version, LO commit+version, the
// pass/fail tally, and a link to the per-run report.

'use strict';

const fs = require('fs');
const path = require('path');

const [runJsonPath, outDir, existingRunsPath] = process.argv.slice(2);
if (!runJsonPath || !outDir) {
    console.error('usage: cv-run-report.js <run.json> <out-dir> [existing-runs.json]');
    process.exit(2);
}
const run = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const short = sha => (sha || '').slice(0, 10);
const ghOnline = sha => sha ? `https://github.com/szsz/online/commit/${sha}` : '';
const ghLo = sha => sha ? `https://github.com/szsz/libreoffice-core-wasm/commit/${sha}` : '';
const cpCommit = sha => sha ? `https://bitbucket.org/tresorit/content-preview/commits/${sha}` : '';
// Pinned-vs-deployed verdict for the content-preview commit.
const cpMatch = (pinned, deployed) => {
    if (!pinned) return '';
    if (!deployed) return ' <span style="color:#888">(deployed unknown)</span>';
    return pinned === deployed
        ? ' <span style="color:#22863a">&#10003; matches pin</span>'
        : ' <span style="color:#cb2431">&#10007; differs from pin ' + `<code>${short(pinned)}</code></span>`;
};

const STYLE = `
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#222}
h1{border-bottom:2px solid #333;padding-bottom:.3em}
table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:14px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:middle}
th{background:#f4f4f4}
tr.pass td.s{background:#dfd} tr.fail td.s{background:#fdd}
td.mono,code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.tally-pass{color:#22863a;font-weight:600} .tally-fail{color:#cb2431;font-weight:600}
.prov th{width:220px;background:#fafafa;font-weight:600}
`;

// ── Per-run page ────────────────────────────────────────────────────
const p = run.provenance || {};
const passCount = run.results.filter(r => r.status === 'pass').length;
const failCount = run.results.length - passCount;

const provRows = [
    ['Content-viewer (content-preview) commit',
        `${p.cp_commit ? `<a href="${cpCommit(p.cp_commit)}"><code>${esc(short(p.cp_commit))}</code></a>` : '<i>unknown</i>'}` +
        `${p.cp_branch ? ' <small>(' + esc(p.cp_branch) + ')</small>' : ''}` +
        `${cpMatch(p.cp_commit_pinned, p.cp_commit)}`],
    ['Editor version (flat CDN build)', `<code>${esc(p.editor_version || '')}</code>`],
    ['Editor (online) commit', p.editor_commit
        ? `<a href="${ghOnline(p.editor_commit)}"><code>${esc(short(p.editor_commit))}</code></a>` : '<i>unknown</i>'],
    ['Editor build id', `<code>${esc(p.editor_build_id || '')}</code>`],
    ['LO build id', `<code>${esc(p.lo_build_id || '')}</code>`],
    ['LO commit', p.lo_commit
        ? `<a href="${ghLo(p.lo_commit)}"><code>${esc(short(p.lo_commit))}</code></a>` : '<i>unknown</i>'],
    ['Target', `<code>${esc(p.target_url || '')}</code>`],
].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n');

const resultRows = run.results.map((r, i) =>
    `<tr class="${r.status}"><td>${i + 1}</td><td>${esc(r.title)}</td>` +
    `<td class="s">${r.status}</td><td>${r.seconds}s</td>` +
    `<td><a href="logs/${esc(r.slug)}.log">log</a></td></tr>`).join('\n');

fs.writeFileSync(path.join(outDir, 'index.html'), `<!doctype html><html><head>
<meta charset="utf-8"/><title>CV test run ${esc(run.runId)}</title><style>${STYLE}</style></head><body>
<h1>Content-viewer test run — ${esc(run.startedUtc)}</h1>
<p><span class="tally-pass">${passCount} passed</span> ·
<span class="tally-fail">${failCount} failed</span> ·
${run.results.length} total · wall ${run.wallSeconds}s ·
<a href="../">all runs</a></p>
<h2>Provenance</h2><table class="prov">${provRows}</table>
<h2>Results</h2>
<table><thead><tr><th>#</th><th>Test</th><th>Status</th><th>Time</th><th>Log</th></tr></thead>
<tbody>${resultRows}</tbody></table>
</body></html>\n`);

// ── Rolling table ───────────────────────────────────────────────────
let runs = [];
if (existingRunsPath && fs.existsSync(existingRunsPath)) {
    try { runs = JSON.parse(fs.readFileSync(existingRunsPath, 'utf8')); } catch (e) { runs = []; }
}
runs = runs.filter(r => r.runId !== run.runId);
runs.unshift({
    runId: run.runId, startedUtc: run.startedUtc,
    pass: passCount, fail: failCount, total: run.results.length,
    provenance: p,
});
runs = runs.slice(0, 100);
fs.writeFileSync(path.join(outDir, 'runs.json'), JSON.stringify(runs, null, 2));

const rollingRows = runs.map(r => {
    const q = r.provenance || {};
    return `<tr class="${r.fail ? 'fail' : 'pass'}">` +
        `<td>${esc(r.startedUtc)}</td>` +
        `<td class="mono">${esc(short(q.cp_commit))}</td>` +
        `<td class="mono">${q.editor_commit ? `<a href="${ghOnline(q.editor_commit)}">${esc(short(q.editor_commit))}</a>` : '?'}<br/><small>${esc(q.editor_version || '')}</small></td>` +
        `<td class="mono">${q.lo_commit ? `<a href="${ghLo(q.lo_commit)}">${esc(short(q.lo_commit))}</a>` : '?'}<br/><small>${esc(q.lo_build_id || '')}</small></td>` +
        `<td class="s"><span class="tally-pass">${r.pass}p</span> / <span class="tally-fail">${r.fail}f</span></td>` +
        `<td><a href="${esc(r.runId)}/">report</a></td></tr>`;
}).join('\n');

fs.writeFileSync(path.join(outDir, 'runs-index.html'), `<!doctype html><html><head>
<meta charset="utf-8"/><title>Content-viewer test runs</title><style>${STYLE}</style></head><body>
<h1>Content-viewer test runs</h1>
<p>One row per suite run against the Tresorit content viewer. Newest first.</p>
<table><thead><tr><th>Run (UTC)</th><th>Content-viewer<br/>commit</th>
<th>Editor<br/>commit / version</th><th>LO<br/>commit / build</th>
<th>Results</th><th>Report</th></tr></thead>
<tbody>${rollingRows}</tbody></table>
</body></html>\n`);

console.log(`per-run:  ${path.join(outDir, 'index.html')}`);
console.log(`rolling:  ${path.join(outDir, 'runs-index.html')} (${runs.length} runs)`);
