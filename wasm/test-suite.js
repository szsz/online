#!/usr/bin/env node
// Co-editing test suite
// Runs all co-editing tests in sequence and reports results.
//
// Usage:
//   node wasm/test-suite.js              # run all tests
//   node wasm/test-suite.js relay        # run only relay test
//   node wasm/test-suite.js 2browser     # run only 2-browser test
//   node wasm/test-suite.js 3browser     # run only 3-browser test

const { execSync, spawn } = require('child_process');
const path = require('path');

const TESTS = {
    relay: {
        name: 'Relay Server',
        file: 'test-relay.js',
        desc: '2 WebSocket clients verify relay broadcast and ordering',
    },
    '2browser': {
        name: '2-Browser Co-Editing',
        file: 'test-cursor-debug.js',
        desc: 'A types ABC at start, B types XYZ at end → "ABCHello WorldXYZ"',
    },
    '3browser': {
        name: '3-Browser Co-Editing',
        file: 'test-3browsers.js',
        desc: 'A types ABC, B types XYZ, C types PQR → 20 chars identical on all',
    },
    docx: {
        name: '3-Browser DOCX Co-Editing',
        file: 'test-docx.js',
        desc: '3 browsers edit test document.docx with ALPHA/BETA/GAMMA at different positions',
    },
};

function runTest(key) {
    const test = TESTS[key];
    const file = path.join(__dirname, test.file);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${test.name}`);
    console.log(`  ${test.desc}`);
    console.log(`  File: ${test.file}`);
    console.log(`${'='.repeat(60)}\n`);

    return new Promise((resolve) => {
        const child = spawn('node', [file], {
            cwd: path.dirname(file),
            stdio: 'inherit',
            timeout: 600000,
        });

        child.on('close', (code) => {
            resolve({ key, name: test.name, code });
        });

        child.on('error', (err) => {
            console.error(`Failed to start ${test.file}: ${err.message}`);
            resolve({ key, name: test.name, code: 1 });
        });
    });
}

async function main() {
    const filter = process.argv[2];
    const keys = filter ? [filter] : Object.keys(TESTS);

    console.log('╔══════════════════════════════════════════╗');
    console.log('║     Co-Editing Test Suite                ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log(`\nTests to run: ${keys.join(', ')}\n`);

    const results = [];
    for (const key of keys) {
        if (!TESTS[key]) {
            console.error(`Unknown test: ${key}`);
            console.error(`Available: ${Object.keys(TESTS).join(', ')}`);
            process.exit(1);
        }
        const result = await runTest(key);
        results.push(result);
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('  SUMMARY');
    console.log(`${'='.repeat(60)}\n`);

    let allPassed = true;
    for (const r of results) {
        const status = r.code === 0 ? '✓ PASS' : '✗ FAIL';
        if (r.code !== 0) allPassed = false;
        console.log(`  ${status}  ${r.name}`);
    }

    console.log(`\n  ${allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
    process.exit(allPassed ? 0 : 1);
}

main();
