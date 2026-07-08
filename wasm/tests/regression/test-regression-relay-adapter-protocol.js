// Regression: relay-adapter.js source has the expected frame-type
// constants in the right places.
//
// Background: the WebSocket protocol between relay-adapter and
// message-relay uses single-byte frame-type prefixes (0x00 = user
// input, 0x06 = checkpoint register, 0x07 = activation, etc. —
// see wasm/docs/CO-EDITING-ARCHITECTURE.md "Relay protocol — frames" for the
// full table). A refactor that swaps types or removes a sender
// silently breaks coordination across browsers (relay drops the
// frame as unknown-type → peers never see updates → silent
// divergence diagnosed only by user complaints).
//
// What this test asserts on the deployed relay-adapter.js:
//   1. The file is fetchable.
//   2. Source contains a sendToRelay(0x00, ...) call — the user-
//      input frame, the most-common frame type. Removing this
//      breaks every typing → peer flow.
//   3. Source contains a sendToRelay(0x06, ...) call — the first-
//      client checkpoint registration. Removing this breaks
//      late-join coordination (memory: "Late Join WORKING").
//   4. The ENCRYPTED_TYPES map contains 0x00 — user-input frames
//      are end-to-end encrypted via the URL-fragment secret. If
//      0x00 falls out of the map, plaintext input frames hit the
//      relay (privacy regression).
//
// This is a static check on deployed source — no real WebSocket
// connection. Runtime <500ms with one GET.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

(async () => {
    console.log('=== Regression: relay-adapter frame-type protocol ===');
    const t0 = Date.now();

    // Resolve hashed relay-adapter via __assetMap (cache-bust).
    let url;
    try {
        const cool = await fetch(EDITOR + '/browser/cool.html');
        const html = await cool.text();
        const m = html.match(/window\.__assetMap\s*=\s*(\{[^}]+\})/);
        const map = m ? JSON.parse(m[1]) : {};
        url = EDITOR + '/browser/' + (map['relay-adapter.js'] || 'relay-adapter.js');
    } catch (e) {
        check('relay-adapter URL resolved', false, e.message);
        process.exit(1);
    }
    check('relay-adapter URL resolved via __assetMap', true, url);

    let src;
    try {
        const r = await fetch(url);
        check('relay-adapter fetched', r.ok, `HTTP ${r.status}`);
        if (!r.ok) process.exit(1);
        src = await r.text();
    } catch (e) {
        check('relay-adapter fetched', false, e.message);
        process.exit(1);
    }

    // 0x00 = user input frame. Many call sites — at least one must
    // exist in the deployed source.
    const userInput = (src.match(/sendToRelay\s*\(\s*0x00\b/g) || []).length;
    check('sendToRelay(0x00, ...) — user-input frame senders present',
          userInput >= 1, `${userInput} call sites`);

    // 0x06 = first-client checkpoint registration.
    const checkpoint = (src.match(/sendToRelay\s*\(\s*0x06\b/g) || []).length;
    check('sendToRelay(0x06, ...) — checkpoint register present',
          checkpoint >= 1, `${checkpoint} call sites`);

    // ENCRYPTED_TYPES must include 0x00. The map shape is
    // `{ 0x00: true }` so we look for that key with `true`.
    const encMap = src.match(/ENCRYPTED_TYPES\s*=\s*\{\s*([^}]+)\}/);
    check('ENCRYPTED_TYPES map present', !!encMap,
          encMap ? encMap[1].slice(0, 80) : '(missing)');
    if (encMap) {
        check('ENCRYPTED_TYPES contains 0x00 (user-input frames are E2E encrypted)',
              /\b0x00\s*:\s*true\b/.test(encMap[1]),
              encMap[1].slice(0, 80));
    }

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
