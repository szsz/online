#!/usr/bin/env node
// Minify .js files in-place using oxc-minify (npm package, JS API only).
//
// Usage: node oxc-minify-runner.js <file1.js> <file2.js> ...
//
// Logs "before → after (-pct%)" per file. Files that fail to parse are
// skipped (logged as SKIP) instead of aborting the batch — the original
// bytes remain on disk and still flow into the brotli step.

const fs = require('fs');
const path = require('path');
const { minifySync } = require('oxc-minify');

const files = process.argv.slice(2);
if (files.length === 0) {
    process.exit(0);
}

let totalBefore = 0;
let totalAfter = 0;
let minified = 0;
let skipped = 0;

const pad = (s, n) => (s + ' '.repeat(Math.max(0, n - s.length)));
const human = (n) => {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'M';
    if (n >= 1024) return (n / 1024).toFixed(1) + 'K';
    return n + 'B';
};

for (const file of files) {
    const before = fs.readFileSync(file);
    const beforeBytes = before.length;
    totalBefore += beforeBytes;

    let result;
    try {
        result = minifySync(path.basename(file), before.toString('utf8'), {
            compress: true,
            mangle: true,
            codegen: { removeWhitespace: true },
        });
    } catch (e) {
        console.log(`  SKIP  ${pad(file, 60)} (${e.message.split('\n')[0]})`);
        totalAfter += beforeBytes;
        skipped++;
        continue;
    }

    if (result && Array.isArray(result.errors) && result.errors.length > 0) {
        // oxc returns errors as an array on the result; non-recoverable
        // parses leave .code unusable. Skip in that case.
        console.log(`  SKIP  ${pad(file, 60)} (${result.errors[0].message || 'parse error'})`);
        totalAfter += beforeBytes;
        skipped++;
        continue;
    }

    const afterBytes = Buffer.byteLength(result.code, 'utf8');
    // Sanity: if oxc-minify produced output LARGER than the input, keep
    // the original — likely a near-empty file or already-minified bundle
    // where bookkeeping bytes outweigh savings.
    if (afterBytes >= beforeBytes) {
        totalAfter += beforeBytes;
        skipped++;
        continue;
    }

    fs.writeFileSync(file, result.code, 'utf8');
    totalAfter += afterBytes;
    minified++;
    const pct = ((1 - afterBytes / beforeBytes) * 100).toFixed(1);
    console.log(`  ${pad(file, 62)} ${pad(human(beforeBytes), 7)} → ${pad(human(afterBytes), 7)} (-${pct}%)`);
}

const pct = totalBefore > 0 ? ((1 - totalAfter / totalBefore) * 100).toFixed(1) : '0.0';
console.log(`Minify summary: ${human(totalBefore)} → ${human(totalAfter)} (-${pct}%)  across ${minified} files (${skipped} skipped)`);
