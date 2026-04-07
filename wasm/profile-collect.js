#!/usr/bin/env node
// Profile collection for wasm-split.
// Deploys the instrumented WASM, runs workloads, extracts profile data.
//
// Usage: node wasm/profile-collect.js [--type writer|calc|impress]
//
// The profile data is written to wasm/profiles/<type>.profile

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'https://wasm.atgpartners.info:6932';
const TIMEOUT = 300000;
const TYPE = process.argv.find(a => a.startsWith('--type='))?.split('=')[1] || 'writer';
const PROFILE_DIR = path.join(__dirname, 'profiles');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

async function waitForDoc(page, type) {
    if (type === 'writer') {
        await page.waitForFunction(
            () => document.querySelector('#StateWordCount')?.textContent?.includes('word'),
            { timeout: TIMEOUT }
        );
    } else if (type === 'calc') {
        await page.waitForFunction(
            () => document.querySelector('#StatusDocPos')?.textContent?.includes('Sheet'),
            { timeout: TIMEOUT }
        );
    } else if (type === 'impress') {
        await page.waitForFunction(() => {
            var o = document.getElementById('wasm-loading-overlay');
            if (o && o.style.opacity !== '0') return false;
            var nav = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
            return nav && nav.textContent && nav.textContent.includes('Slide Show');
        }, { timeout: TIMEOUT });
        await sleep(10000); // Wait for tile rendering
    }
}

(async () => {
    log(`=== Profile collection for ${TYPE} ===`);
    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    const browser = await puppeteer.launch({
        headless: 'new', protocolTimeout: 600000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
               '--enable-features=SharedArrayBuffer', '--disk-cache-size=0',
               '--js-flags=--max-old-space-size=8192'],
    });

    try {
        // Upload test documents
        const up = await browser.newPage();
        await up.goto(BASE + '/editor.html', { waitUntil: 'networkidle0' });

        const testFiles = {
            writer: [
                ['profile-simple.txt', Buffer.from('Hello World. This is a simple test document for profiling.')],
            ],
            calc: [
                ['profile-simple.xlsx', fs.readFileSync(path.resolve(__dirname, '../test/data/testdoc.xlsx'))],
            ],
            impress: [
                ['profile-simple.pptx', fs.readFileSync(path.resolve(__dirname, '../test/data/testdoc.pptx'))],
            ],
        };

        for (const [name, data] of testFiles[TYPE] || testFiles.writer) {
            await up.evaluate(async (url, n, arr) => {
                await fetch(url + '/wasm/' + encodeURIComponent(n), {
                    method: 'POST', body: new Blob([new Uint8Array(arr)])
                });
            }, BASE, name, Array.from(data));
            log(`Uploaded ${name}`);
        }
        await up.close();

        // Run profiling workloads
        const workloads = {
            writer: [
                { name: 'Open simple doc', file: 'profile-simple.txt', actions: async (page) => {
                    // Just opening and loading exercises core rendering
                    await sleep(5000);
                }},
                { name: 'Type text', file: 'profile-simple.txt', actions: async (page) => {
                    // Type some text to exercise editing path
                    for (const ch of 'The quick brown fox jumps over the lazy dog.') {
                        await page.evaluate((c) => {
                            if (globalThis.TheFakeWebSocket)
                                TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                        }, ch);
                        await sleep(200);
                    }
                    await sleep(3000);
                }},
                { name: 'Select and format', file: 'profile-simple.txt', actions: async (page) => {
                    // Select all, bold, undo
                    await page.evaluate(() => {
                        if (globalThis.TheFakeWebSocket) {
                            TheFakeWebSocket.send('key type=input char=0 key=1025 modifier=8192'); // Ctrl+A
                        }
                    });
                    await sleep(1000);
                    await page.evaluate(() => {
                        if (globalThis.TheFakeWebSocket) {
                            TheFakeWebSocket.send('key type=input char=0 key=514 modifier=8192'); // Ctrl+B
                        }
                    });
                    await sleep(2000);
                    await page.evaluate(() => {
                        if (globalThis.TheFakeWebSocket) {
                            TheFakeWebSocket.send('key type=input char=0 key=26 modifier=8192'); // Ctrl+Z
                        }
                    });
                    await sleep(2000);
                }},
            ],
            calc: [
                { name: 'Open spreadsheet', file: 'profile-simple.xlsx', actions: async (page) => {
                    await sleep(5000);
                }},
                { name: 'Edit cells', file: 'profile-simple.xlsx', actions: async (page) => {
                    // Click cell A1 and type
                    await page.evaluate(() => {
                        if (globalThis.TheFakeWebSocket)
                            TheFakeWebSocket.send('mouse type=buttondown x=1000 y=1000 count=1 buttons=1 modifier=0');
                    });
                    await sleep(1000);
                    for (const ch of '12345') {
                        await page.evaluate((c) => {
                            if (globalThis.TheFakeWebSocket)
                                TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                        }, ch);
                        await sleep(200);
                    }
                    await sleep(3000);
                }},
            ],
            impress: [
                { name: 'Open presentation', file: 'profile-simple.pptx', actions: async (page) => {
                    await sleep(10000); // Impress needs more time for tile rendering
                }},
                { name: 'Edit slide text', file: 'profile-simple.pptx', actions: async (page) => {
                    await page.evaluate(() => {
                        if (globalThis.TheFakeWebSocket) {
                            TheFakeWebSocket.send('mouse type=buttondown x=5000 y=4000 count=2 buttons=1 modifier=0');
                            TheFakeWebSocket.send('mouse type=buttonup x=5000 y=4000 count=2 buttons=1 modifier=0');
                        }
                    });
                    await sleep(2000);
                    for (const ch of 'Profile test') {
                        await page.evaluate((c) => {
                            if (globalThis.TheFakeWebSocket)
                                TheFakeWebSocket.send('key type=input char=' + c.charCodeAt(0) + ' key=0');
                        }, ch);
                        await sleep(200);
                    }
                    await sleep(3000);
                }},
            ],
        };

        const profileChunks = [];

        for (const workload of (workloads[TYPE] || workloads.writer)) {
            log(`\n--- Workload: ${workload.name} ---`);
            const page = await browser.newPage();

            const url = `${BASE}/browser/cool.html?WOPISrc=${encodeURIComponent(workload.file)}&access_token=test`;
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

            log('Waiting for document to load...');
            await waitForDoc(page, TYPE);
            log('Document loaded. Running actions...');

            await workload.actions(page);
            log('Actions complete.');

            // Extract profile by calling __write_profile
            // The function writes to WASM memory. We need to read it out.
            log('Extracting profile data...');
            const profileData = await page.evaluate(async () => {
                // The instrumented module exposes __write_profile
                if (typeof Module !== 'undefined' && Module._write_profile) {
                    // __write_profile returns the number of bytes written
                    // It writes to a buffer we provide
                    try {
                        const size = Module._write_profile(0, 0); // Get required size
                        if (size > 0) {
                            const ptr = Module._malloc(size);
                            Module._write_profile(ptr, size);
                            const data = new Uint8Array(Module.HEAPU8.buffer, ptr, size);
                            const arr = Array.from(data);
                            Module._free(ptr);
                            return { ok: true, data: arr, size };
                        }
                        return { ok: false, error: 'write_profile returned 0' };
                    } catch (e) {
                        return { ok: false, error: e.message };
                    }
                }
                // Try alternative access pattern
                if (typeof Module !== 'undefined' && Module['asm'] && Module['asm']['__write_profile']) {
                    try {
                        const fn = Module['asm']['__write_profile'];
                        const size = fn(0, 0);
                        if (size > 0) {
                            const ptr = Module._malloc(size);
                            fn(ptr, size);
                            const data = new Uint8Array(Module.HEAPU8.buffer, ptr, size);
                            const arr = Array.from(data);
                            Module._free(ptr);
                            return { ok: true, data: arr, size };
                        }
                        return { ok: false, error: 'asm.__write_profile returned 0' };
                    } catch (e) {
                        return { ok: false, error: 'asm approach: ' + e.message };
                    }
                }
                return { ok: false, error: 'No __write_profile function found on Module' };
            });

            if (profileData.ok) {
                log(`Profile collected: ${profileData.size} bytes`);
                profileChunks.push(Buffer.from(profileData.data));
            } else {
                log(`Profile extraction failed: ${profileData.error}`);
                log('(This is expected if not using the instrumented WASM binary)');
            }

            await page.close();
        }

        // Save profile
        if (profileChunks.length > 0) {
            const profileFile = path.join(PROFILE_DIR, `${TYPE}.profile`);
            // Use the last profile (most complete since it includes all prior function calls too)
            fs.writeFileSync(profileFile, profileChunks[profileChunks.length - 1]);
            log(`\nProfile saved to ${profileFile} (${profileChunks[profileChunks.length - 1].length} bytes)`);
        } else {
            log('\nNo profile data collected. Make sure the instrumented WASM is deployed.');
            log('Deploy with: cp instrumented.wasm → online-writer.wasm');
        }

    } catch (e) {
        log('Error: ' + e.message);
    } finally {
        await browser.close();
        log('Done.');
    }
})();
