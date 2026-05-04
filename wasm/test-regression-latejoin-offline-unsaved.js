const __cl = require('./lib/inject-checklist');
// Regression: A types (unsaved), A goes offline, B joins.
//
// A's edits are in the relay message log but NOT in a checkpoint.
// When B joins with no active peers, the relay serves the OLD checkpoint
// (before A's edits) plus the message log. B should replay the messages
// to catch up.
//
// Bug: If the relay's message log doesn't include A's edits, or if
// the message replay doesn't work, B opens with stale/blank content.
//
// Determinism notes (iter 200+, this rewrite):
//   The previous version used wall-clock sleep() between phases:
//     - sleep(5000) after A's last keystroke   — assumed all UI frames
//                                                 had reached the relay
//     - sleep(5000) after cA()                 — assumed the relay had
//                                                 noticed the disconnect
//     - sleep(10000) after B's editor was up   — assumed checkpoint
//                                                 download + replay had
//                                                 finished + Kit had
//                                                 rendered the result
//   Under JOBS=2 contention any one of these slips and the char-count
//   check reads B too early, producing a flake that looks identical to
//   the cluster-A bug it's supposed to detect ("B sees stale chars").
//
//   Replaced each blind sleep with a synchronous gate against the
//   relay broker's /debug/api/rooms/<roomId> endpoint and the iframe's
//   own postMessage / console signals:
//     - Phase 1 end:  poll relay until room.seq is stable AND
//                     logMsgs >= edits-typed (A's frames are in the log)
//     - Phase 1.5:    after A closes, poll relay until activeCount === 0
//                     (A's WS is fully gone before B joins — otherwise
//                     B might activate as a "first client" before the
//                     broker has switched to "checkpoint exists, serve
//                     log" mode, masking the bug)
//     - Phase 2 end:  capture B's iframe console; wait for
//                     "Replay mode OFF" (the relay-adapter's own
//                     signal that buffered frames have been delivered
//                     to Kit), then poll char count until two consecutive
//                     reads agree
//   These three signals come from the system itself — they don't move
//   under contention, so the test is contention-blind.

const { launch, sleep } = require('./lib/browser');
const fs = require('fs'), path = require('path');
const env = require('./lib/test-env');
const { uploadV2 } = require('./lib/v2-upload');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const VIEWER = env.FILE_STORAGE_URL;
const RELAY_HTTP = env.RELAY_HTTP_URL;
const SHOTS = '/tmp/static-deploy/public/shots-regression-latejoin-offline-unsaved';

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log(`  ✓ ${label}`);
    else { console.log(`  ✗ FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}
function charCount(s) { const m = s && s.match(/(\d+) characters/); return m ? parseInt(m[1]) : -1; }

// Fetch the broker's room summary. Returns null on 404 (room doesn't
// exist yet or has been cleaned up) and on any network error so callers
// can poll without unwrapping exceptions.
function fetchRoomSummary(roomId) {
    return new Promise((resolve) => {
        const u = new URL(RELAY_HTTP.replace(/\/$/, '') + '/debug/api/rooms/' + encodeURIComponent(roomId));
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname, method: 'GET',
            rejectUnauthorized: false,
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode !== 200) { resolve(null); return; }
                try { resolve(JSON.parse(data).room || null); }
                catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(5000, () => { try { req.destroy(); } catch(e) {} resolve(null); });
        req.end();
    });
}

// Wait for the relay broker to report that all UI frames from the
// already-typed input have landed in the room's messageLog. We don't
// need an exact count — just a stable seq that's monotonic on a 1-second
// window, plus a non-empty log. minLog must clear the presence frame
// (seq=1 from 0x06) plus at least a few of A's typing frames so we
// don't false-positive when only the presence message has been broadcast.
async function waitForRelayQuiescent(roomId, minLogMsgs, deadlineMs) {
    let lastSeq = -1;
    let stableSince = 0;
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        const room = await fetchRoomSummary(roomId);
        if (room) {
            if (room.seq === lastSeq && room.logMsgs >= minLogMsgs) {
                if (!stableSince) stableSince = Date.now();
                if (Date.now() - stableSince >= 1500) {
                    console.log('  [relay] quiescent: seq=' + room.seq + ' logMsgs=' + room.logMsgs +
                                ' active=' + room.activeCount);
                    return room;
                }
            } else {
                lastSeq = room.seq;
                stableSince = 0;
            }
        }
        await sleep(500);
    }
    throw new Error('Relay never went quiescent within ' + deadlineMs + 'ms (lastSeq=' + lastSeq + ')');
}

// Wait for the broker to report no active clients in the room. After
// A's WS closes the broker decrements activeCount synchronously; the
// room is only deleted 60 s later, so we just want activeCount === 0.
async function waitForNoActiveClients(roomId, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        const room = await fetchRoomSummary(roomId);
        if (!room || room.activeCount === 0) {
            if (room) {
                console.log('  [relay] active=0 (clientCount=' + room.clientCount +
                            ', logMsgs=' + room.logMsgs + ')');
            } else {
                console.log('  [relay] room cleaned up — A is fully gone');
            }
            return room;
        }
        await sleep(500);
    }
    throw new Error('Relay still has active clients after ' + deadlineMs + 'ms');
}

// Read the char count from the editor's status bar. -1 if the iframe or
// the status node hasn't rendered yet.
async function readCharCount(frame) {
    if (!frame) return -1;
    const wc = await frame.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''
    ).catch(() => '');
    return charCount(wc);
}

// Wait for the char count on `frame` to settle: two consecutive reads
// at least `windowMs` apart that agree. Catches the race where Kit has
// applied some — but not yet all — replay frames.
async function waitForStableCharCount(frame, windowMs, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    let prev = await readCharCount(frame);
    let stableSince = 0;
    while (Date.now() < deadline) {
        await sleep(500);
        const cc = await readCharCount(frame);
        if (cc > 0 && cc === prev) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= windowMs) return cc;
        } else {
            prev = cc;
            stableSince = 0;
        }
    }
    return prev; // best-effort; caller decides whether to fail
}

(async () => {
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });

    let stepNum = 0;
    async function snap(page, name) {
        stepNum++;
        await page.screenshot({ path: `${SHOTS}/${String(stepNum).padStart(2,'0')}_${name}.png` });
    }

    const docName = 'ljoffline-' + Date.now() + '.docx';
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'test', 'data', 'new.docx'));
    const { b64urlSecret, fileId } = await uploadV2(VIEWER, docName, bytes);
    console.log('[setup] Uploaded v2 ' + docName + ' (initial ~19 chars) → ' + fileId.substring(0,8) + '…');
    // Roomid at the broker is the WOPISrc, which is the v2 fileId for v2 files
    // (see viewer-public/index.html: openFile(fileId, ...)).
    const roomId = fileId;

    // ═══ Phase 1: A opens, types, does NOT save, then CLOSES ═══
    console.log('\n=== Phase 1: A opens, types (NO save), closes ===');
    const { browser: bA, cleanup: cA } = await launch();
    const pA = await bA.newPage();
    await pA.setViewport({ width: 1280, height: 900 });
    // Capture A's relay-adapter logs so a flake postmortem can see whether
    // A actually sent the typed frames before being closed.
    pA.on('console', m => {
        const t = m.text();
        if (/\[relay\]/.test(t)) console.log('    [A:relay] ' + t.substring(0, 160));
    });
    await pA.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

    let fA;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        fA = pA.frames().find(f => f.url().includes('cool.html'));
        if (fA) {
            const wc = await fA.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await fA.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!fA) throw new Error('A failed');
    // Wait until the editor will actually accept input. Two signals:
    //   1. The relay broker has A as an active client AND a checkpoint
    //      is registered (subsequent input frames will be broadcast +
    //      logged) — broker-side authoritative.
    //   2. The viewer parent's `relayActivated` flag is true, which the
    //      iframe sets via the RelayActivated postMessage. Without this
    //      the editor's own activation guard ("Dropping input not
    //      activated yet") silently swallows keystrokes — exactly the
    //      symptom the previous sleep(5000) hid by accident.
    // Both gates must clear; otherwise the typed characters are lost.
    {
        const deadline = Date.now() + env.scaleTimeout(30000);
        while (Date.now() < deadline) {
            const room = await fetchRoomSummary(roomId);
            const parentReady = await pA.evaluate(
                () => !!window.relayActivated
            ).catch(() => false);
            if (room && room.activeCount >= 1 && room.checkpointHash && parentReady) break;
            await sleep(500);
        }
    }
    // Settle: the iframe's interceptedSend wires up TheFakeWebSocket.send
    // *after* RelayActivated fires (a microtask later). 1 s is plenty.
    await sleep(1000);

    async function clickA() {
        const el = await pA.$('iframe#editor-frame');
        if (el) { const b = await el.boundingBox(); if (b) await pA.mouse.click(b.x+b.width/2, b.y+b.height/2); }
        await sleep(300);
    }

    const ccA0 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  A initial: ' + ccA0 + ' chars');

    // Type content
    await clickA();
    await pA.keyboard.type('UNSAVED_CONTENT_FROM_A ', { delay: 40 });

    // Wait for the typed chars to land in A's local Kit. This is a UI-side
    // confirmation that A's keystrokes have been processed; it doesn't yet
    // prove the relay log is up to date — that's the next gate.
    {
        const deadline = Date.now() + env.scaleTimeout(15000);
        while (Date.now() < deadline) {
            const cc = await readCharCount(fA);
            if (cc - ccA0 >= 23) break;
            await sleep(250);
        }
    }
    const ccA1 = charCount(await fA.evaluate(() =>
        document.querySelector('#StateWordCount')?.textContent?.trim() || ''));
    console.log('  A after typing: ' + ccA1 + ' chars');
    check('A typed 23 chars', ccA1 - ccA0 === 23, 'delta=' + (ccA1 - ccA0));
    await snap(pA, 'A_after_type');

    // Wait for A's input frames to be flushed to the relay's messageLog.
    // 23 characters generate at minimum 23 user-input frames (+ a bunch
    // of cursor / state-change frames). 5 logged frames is a safe lower
    // bound for "A actually sent something". If the relay is contented,
    // we just wait longer — seq will advance a little slower but
    // monotonically.
    await waitForRelayQuiescent(roomId, 5, env.scaleTimeout(30000));

    // A does NOT press Ctrl+S — edits are only in relay message log
    console.log('  [A] Closing WITHOUT saving...');
    await cA();
    console.log('  A closed. Relay has messages but checkpoint is from initial activation.');
    // Wait for the broker to report no active peers (replaces sleep(5000)).
    // This guarantees Phase 2 will hit the "checkpoint exists, no active
    // peers" branch in serveCheckpoint instead of the "active peer
    // present" branch — which is exactly the bug-detection scenario the
    // test is meant to exercise.
    await waitForNoActiveClients(roomId, env.scaleTimeout(30000));
    {
        // Sanity: the unsaved tail must still be present in the room. If
        // it's not, the test can't possibly detect the cluster-A bug
        // because there's nothing to replay. (The room is GC'd 60 s after
        // last client disconnect, well outside our window.)
        const room = await fetchRoomSummary(roomId);
        check('Relay still holds A\'s unsaved messageLog after disconnect',
            room && room.logMsgs >= 5,
            room ? ('logMsgs=' + room.logMsgs) : 'room=null');
    }

    // ═══ Phase 2: B opens the same doc ═══
    console.log('\n=== Phase 2: B opens same doc (A is gone, unsaved edits in relay) ===');
    const { browser: bB, cleanup: cB } = await launch();
    const pB = await bB.newPage();
    await pB.setViewport({ width: 1280, height: 900 });
    // Listen for relay-adapter milestones from B's iframe. Two events
    // matter:
    //   - 'Replay mode ON'  — B has sent 0x06 and is buffering relay
    //                          replay frames for local Kit
    //   - 'Replay mode OFF — N messages applied to local Kit' — every
    //     replay frame has been pushed to Kit (after the 0x02 self-join
    //     announcement and the kitMessageQueue drain). This is the
    //     authoritative signal that whatever the relay had to give B
    //     has been delivered.
    let bReplayOn = false;
    let bReplayOffMsgCount = -1;
    pB.on('console', m => {
        const t = m.text();
        if (/\[relay\]/.test(t)) console.log('    [B:relay] ' + t.substring(0, 160));
        if (/Replay mode ON/.test(t)) bReplayOn = true;
        const off = t.match(/Replay mode OFF — (\d+) messages applied/);
        if (off) bReplayOffMsgCount = parseInt(off[1], 10);
    });
    await pB.goto(VIEWER + '/#file=' + b64urlSecret, { waitUntil: 'domcontentloaded' });

    let fB;
    for (let i = 0; i < 300; i++) {
        await sleep(500);
        fB = pB.frames().find(f => f.url().includes('cool.html'));
        if (fB) {
            const wc = await fB.evaluate(() =>
                document.querySelector('#StateWordCount')?.textContent || '').catch(() => '');
            if (/\d+\s+character/i.test(wc)) {
                const ws = await fB.evaluate(() =>
                    typeof globalThis.TheFakeWebSocket !== 'undefined').catch(() => false);
                if (ws) break;
            }
        }
    }
    if (!fB) throw new Error('B failed');

    // Wait for B's relay-adapter to report replay completion. Without
    // this, Kit may have rendered the (unmodified) checkpoint already
    // but not yet applied the messageLog frames — exactly the moment
    // the old test would read a stale char count and report a flake.
    //
    // If the bug under test fires (the relay didn't actually have A's
    // edits, or B's adapter dropped them), bReplayOn flips but
    // bReplayOffMsgCount stays at 0 — the assertions below will catch
    // that as the real bug rather than as a timeout.
    {
        const deadline = Date.now() + env.scaleTimeout(60000);
        while (Date.now() < deadline) {
            if (bReplayOn && bReplayOffMsgCount >= 0) break;
            await sleep(200);
        }
        if (!bReplayOn) {
            console.log('  [warn] B never logged "Replay mode ON" — adapter signals missing?');
        } else {
            console.log('  [B] replay drained, ' + bReplayOffMsgCount + ' frames applied to Kit');
        }
    }

    // Belt-and-braces: even after replay drains, Kit's render of the
    // applied frames is async (it goes through coolwsd's internal
    // message queue). Poll char count until it stabilises so the
    // assertion reads the post-render value, not a transient.
    const ccB0 = await waitForStableCharCount(fB, 1500, env.scaleTimeout(30000));
    await snap(pB, 'B_after_open');
    console.log('  B after open: ' + ccB0 + ' chars (A had ' + ccA1 + ')');

    // THE KEY CHECKS
    check('B sees A content (within ±5)', Math.abs(ccB0 - ccA1) <= 5,
        'B=' + ccB0 + ' A=' + ccA1 + ' diff=' + Math.abs(ccB0 - ccA1));
    check('B is NOT blank/initial (>25 chars)', ccB0 > 25,
        'B=' + ccB0 + ' (initial was ~19)');

    // Check stored (encrypted) file size via v2 endpoint. (Reported size
    // is ciphertext: plaintext + 28B AES-GCM IV + tag.)
    const storedSize = await pB.evaluate(async (id) => {
        const r = await fetch('/api/v2/file/' + id);
        if (!r.ok) return -1;
        return (await r.json()).size;
    }, fileId);
    console.log('  Stored file (ciphertext) size: ' + storedSize + ' bytes');

    await cB();
    console.log('\n' + (allPassed ? '✓ ALL PASSED' : '✗ SOME FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
