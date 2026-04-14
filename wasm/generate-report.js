#!/usr/bin/env node
// generate-report.js — Generates an HTML test report from screenshots.
//
// Usage:
//   node generate-report.js --name "Test Name" --desc "Description" \
//       --shots /tmp/static-deploy/public/shots-foo \
//       --output /tmp/static-deploy/public/reports/foo.html \
//       [--status pass|fail]

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
    const idx = args.indexOf('--' + name);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
}

const name    = flag('name')   || 'Unnamed Test';
const desc    = flag('desc')   || '';
const shotsDir = flag('shots') || '';
const output  = flag('output') || '';
const status  = (flag('status') || 'pass').toLowerCase();  // pass | fail

if (!output) {
    console.error('Error: --output is required');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Collect screenshots
// ---------------------------------------------------------------------------
let screenshots = [];
if (shotsDir && fs.existsSync(shotsDir)) {
    screenshots = fs.readdirSync(shotsDir)
        .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
        .sort();
}

// Compute the relative path from the report HTML to the shots directory.
// Both live under /tmp/static-deploy/public/ so we use path.relative.
const reportDir = path.dirname(output);
const relShotsDir = shotsDir ? path.relative(reportDir, shotsDir) : '';

// ---------------------------------------------------------------------------
// Build the timestamp
// ---------------------------------------------------------------------------
const now = new Date();
const timestamp = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------
const passed = status === 'pass';
const badgeColor = passed ? '#16a34a' : '#dc2626';
const badgeLabel = passed ? 'PASS' : 'FAIL';

// ---------------------------------------------------------------------------
// Checklist (written by the test via lib/checklist.js)
// ---------------------------------------------------------------------------
let checklist = null;
if (shotsDir) {
    const checklistFile = path.join(shotsDir, 'checklist.json');
    if (fs.existsSync(checklistFile)) {
        try { checklist = JSON.parse(fs.readFileSync(checklistFile, 'utf8')); }
        catch (e) { console.warn('Failed to parse checklist:', e.message); }
    }
}
let checklistHTML = '';
if (checklist && checklist.items && checklist.items.length) {
    const items = checklist.items.map(it => {
        const icon = it.passed ? '✅' : '❌';
        const color = it.passed ? '#16a34a' : '#dc2626';
        const ev = it.evidence ? `<span class="evidence">${escapeHtml(String(it.evidence)).slice(0,300)}</span>` : '';
        return `<li class="check-item" style="border-left:3px solid ${color};"><span class="check-icon">${icon}</span><span class="check-name">${escapeHtml(it.name)}</span>${ev}</li>`;
    }).join('');
    const passed = checklist.items.filter(x => x.passed).length;
    const total = checklist.items.length;
    checklistHTML = `
    <h2 class="section-title">Checklist <span class="check-summary">(${passed}/${total})</span></h2>
    <ul class="checklist">${items}</ul>
    <hr class="divider" />`;
} else {
    checklistHTML = '<p style="color:#888;">No structured checklist recorded.</p><hr class="divider" />';
}

function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ---------------------------------------------------------------------------
// Screenshot HTML
// ---------------------------------------------------------------------------
let screenshotHTML = '';
if (screenshots.length === 0) {
    screenshotHTML = '<p style="color:#888;">No screenshots found.</p>';
} else {
    for (const file of screenshots) {
        const caption = file.replace(/\.\w+$/, '').replace(/[_-]/g, ' ');
        const src = relShotsDir + '/' + file;
        screenshotHTML += `
        <div class="shot">
            <img src="${src}" alt="${caption}" />
            <div class="caption">${file}</div>
        </div>
        <hr class="divider" />`;
    }
}

// ---------------------------------------------------------------------------
// Full HTML
// ---------------------------------------------------------------------------
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name} — Test Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fff; color: #1a1a1a;
    line-height: 1.5;
  }
  .container { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .back { display: inline-block; margin-bottom: 1.5rem; font-size: 0.9rem; }
  h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 0.5rem; }
  .badge {
    display: inline-block; padding: 0.2rem 0.75rem; border-radius: 4px;
    color: #fff; font-weight: 600; font-size: 0.95rem;
    background: ${badgeColor};
  }
  .desc { margin: 1rem 0 1.5rem; font-size: 1rem; color: #444; }
  .shot { margin: 1.5rem 0 0.5rem; }
  .shot img { width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 6px; }
  .caption { font-size: 0.85rem; color: #888; margin-top: 0.35rem; font-family: monospace; }
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
  .section-title { font-size: 1.25rem; margin: 1.25rem 0 0.5rem; }
  .check-summary { font-size: 0.85rem; font-weight: normal; color: #666; }
  .checklist { list-style: none; padding: 0; margin: 0; }
  .check-item {
    background: #fafafa; padding: 0.5rem 0.75rem; margin-bottom: 4px;
    border-radius: 0 4px 4px 0; display: flex; align-items: baseline; gap: 0.5rem;
  }
  .check-icon { font-size: 1rem; }
  .check-name { font-size: 0.95rem; }
  .evidence {
    margin-left: auto; font-family: monospace; font-size: 0.78rem;
    color: #666; max-width: 50%; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
</head>
<body>
<div class="container">
  <a class="back" href="index.html">&larr; Back to Summary</a>
  <h1>${name}</h1>
  <div class="meta">${timestamp}</div>
  <span class="badge">${badgeLabel}</span>
  <div class="desc">${desc}</div>
  <hr class="divider" />
  ${checklistHTML}
  <h2 class="section-title">Screenshots</h2>
  ${screenshotHTML}
</div>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html, 'utf8');
console.log(`Report written: ${output}  [${badgeLabel}]`);
