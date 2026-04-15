#!/usr/bin/env node
// precompress-br.js — Brotli-compress a list of files in place.
//
// Usage:
//   node precompress-br.js <base-dir> <relative-path> [<relative-path> ...]
//
// Writes <base-dir>/<relative-path>.br alongside each input. Uses the
// maximum brotli quality (11) — the point of pre-compression is to pay
// the CPU cost once per deploy rather than once per request.
//
// Skips files that don't exist, and skips files whose .br counterpart
// is already newer than the source (idempotent across repeated deploys).

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const [, , baseDirArg, ...relPaths] = process.argv;
if (!baseDirArg || relPaths.length === 0) {
    console.error('usage: precompress-br.js <base-dir> <rel-path>...');
    process.exit(1);
}
const baseDir = path.resolve(baseDirArg);

// Convert bytes → human-readable.
const fmt = (n) => n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB'
                 : n > 1 << 10 ? (n / (1 << 10)).toFixed(1) + ' KB'
                               : n + ' B';

function compressOne(relPath) {
    const src = path.join(baseDir, relPath);
    const dst = src + '.br';

    if (!fs.existsSync(src)) {
        console.log(`  skip (missing): ${relPath}`);
        return;
    }
    const srcStat = fs.statSync(src);
    if (fs.existsSync(dst)) {
        const dstStat = fs.statSync(dst);
        if (dstStat.mtimeMs >= srcStat.mtimeMs) {
            console.log(`  skip (up-to-date): ${relPath}.br (${fmt(dstStat.size)})`);
            return;
        }
    }

    const t0 = Date.now();
    const input = fs.readFileSync(src);
    const output = zlib.brotliCompressSync(input, {
        params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
        },
    });
    fs.writeFileSync(dst, output);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    const ratio = (100 * output.length / input.length).toFixed(0);
    console.log(`  ${relPath}: ${fmt(input.length)} -> ${fmt(output.length)} (${ratio}%) in ${dt}s`);
}

for (const rel of relPaths) {
    compressOne(rel);
}
