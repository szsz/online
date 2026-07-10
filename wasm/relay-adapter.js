// Strict-ordering relay adapter for COOL WASM co-editing.
// Guarantees zero divergence: all browsers apply events in the same order.
//
// Protocol:
//   - All user input (key, mouse, textinput) goes through the relay
//   - Relay assigns monotonic sequence numbers to every broadcast
//   - This client processes messages strictly in seq order
//   - Late join: download state file from relay, replay buffered messages, then activate
//   - Client cannot send until fully synced (join-ready sent and acknowledged)
//
// Activate by adding ?relay=wss://host:port/room/id to the URL.

(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var relayUrl = params.get('relay');
    // Module-scope WOPISrc — referenced by fetchKey() and activateClient()
    // before initiateJoin() runs. Without this declaration the free lookup
    // throws ReferenceError under `use strict` and aborts encryption init.
    var wopiSrc = params.get('WOPISrc') || '';
    // Content-viewer mode (Tresorit content-preview embed): the content viewer
    // owns save via same-origin reach-in (app.map.save + Module.FS.readFile),
    // so relay-adapter's own checkpoint save must not fire — with an empty
    // WOPISrc it would fetch /wasm/ and 404. Detected by localFileId + no
    // WOPISrc, same discriminator as main.js / wasm-loader.js.
    var isContentViewer = (!!params.get('localFileId') && !wopiSrc);
    // Content-viewer CO-EDIT mode: content-preview adds ?relay=… alongside
    // ?localFileId=…, so isContentViewer stays true (WOPISrc stays empty —
    // room identity lives in the relay WS URL, /room/<key>) while
    // singleUserMode goes false. The doc bytes come from the same-origin
    // /shared-file/<roomKey> store on content-viewer-server.js: the creator
    // page POSTs them there before opening the editor, and every joiner's
    // page GETs them into its own SW cache before boot — so by the time
    // this adapter runs, /local-file/<localFileId> always serves the doc.
    var cvLocalFileId = params.get('localFileId') || '';
    function cvRoomKey() {
        var m = (relayUrl || '').match(/\/room\/([^/?#]+)/);
        return m ? m[1] : '';
    }
    // Latest hot-switch target room (updated by RelaySwitchRoom). Used to
    // gate the late-join switchdoc (0x05 handler) against stale 0x05s from
    // rapid A→B→A switches — see the switchdoc-storm fix there. Distinct
    // module-scope name so the 0x05 handler's local `wopiSrc` doesn't
    // shadow it.
    var currentRoomDoc = wopiSrc;
    // Even without a relay URL (single-user mode), we still set up
    // the save/hash tracking so conflict detection works. We just
    // skip the WebSocket connection and relay-specific messaging.
    var singleUserMode = !relayUrl;
    if (singleUserMode) {
        console.log('[relay] Single-user mode — no relay, save/hash tracking only');
    } else {
        console.log('[relay] Connecting to ' + relayUrl);
    }

    var ws = singleUserMode ? null : new WebSocket(relayUrl);
    if (ws) ws.binaryType = 'arraybuffer';

    var connected = false;
    var coolwsdReady = false;
    var activated = false;       // true after join-ready acknowledged
    var sendQueue = [];
    // Buffer for user-input messages (key/mouse/uno/etc.) sent by COOL.js
    // BEFORE the relay-adapter has finished activating in a new (or
    // switched) room. Without this, keystrokes that arrive in the
    // narrow window between RelaySwitchRoom and activateClient → 0x06
    // get dropped silently with "Dropping input (not activated yet)".
    // Capped to 200 entries so a never-activating session can't grow
    // unbounded.
    var _preActivateQueue = [];
    var _preActivateQueueCap = 200;
    var recvQueue = [];          // messages received before COOLWSD ready
    var myViewId = Math.floor(Math.random() * 0x7FFFFF);
    var lastSeq = 0;             // last processed sequence number
    var joinFileHash = null;
    var joinFileSeq = 0;         // seq# of the base state we downloaded
    var isFirstClient = false;
    var lastKnownHash = null;    // hash of the file version we know about (loaded or last saved)
    var forceNextSave = false;   // set by ForceSave message after conflict

    // ── E2E Encryption ─────────────────────────────────────────────
    var encryptionEnabled = false;
    var currentKeyVer = 0;
    var _keyCache = {};          // keyVersion → CryptoKey
    var _pendingKeyReqs = {};    // keyVersion → [resolve callbacks]
    var ENCRYPTED_TYPES = { 0x00: true }; // frame types to encrypt (0x00 = user input)

    function fetchKey(keyVersion) {
        if (_keyCache[keyVersion]) return Promise.resolve(_keyCache[keyVersion]);
        if (_pendingKeyReqs[keyVersion]) {
            return new Promise(function(resolve, reject) {
                _pendingKeyReqs[keyVersion].push(resolve);
            });
        }
        _pendingKeyReqs[keyVersion] = [];
        return new Promise(function(resolve, reject) {
            _pendingKeyReqs[keyVersion].push(resolve);
            try {
                parent.postMessage(JSON.stringify({
                    MessageId: 'KeyRequest',
                    Values: { fileId: wopiSrc, keyVersion: keyVersion }
                }), '*');
            } catch(e) { console.error('[relay] KeyRequest postMessage failed:', e); }
            // Timeout: if no parent responds in 5s (e.g., cool.html loaded
            // standalone without the viewer parent, or the parent has no
            // KeyResponse handler), reject so callers can fall through to
            // unencrypted mode instead of hanging activation forever.
            setTimeout(function() {
                if (_pendingKeyReqs[keyVersion]) {
                    delete _pendingKeyReqs[keyVersion];
                    reject(new Error('KeyRequest timeout (no parent KeyResponse in 5s)'));
                }
            }, 5000);
        });
    }

    function _onKeyResponse(kv, keyB64) {
        var raw = Uint8Array.from(atob(keyB64), function(c) { return c.charCodeAt(0); });
        crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
            .then(function(ck) {
                _keyCache[kv] = ck;
                var cbs = _pendingKeyReqs[kv] || [];
                delete _pendingKeyReqs[kv];
                cbs.forEach(function(cb) { cb(ck); });
            });
    }

    // Encrypt payload → Uint8Array: [keyVer:4][nonce:12][ciphertext+tag]
    function encryptPayload(payload) {
        return fetchKey(currentKeyVer).then(function(key) {
            var nonce = crypto.getRandomValues(new Uint8Array(12));
            return crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, payload)
                .then(function(ct) {
                    var out = new Uint8Array(4 + 12 + ct.byteLength);
                    out[0] = (currentKeyVer >>> 24) & 0xFF;
                    out[1] = (currentKeyVer >>> 16) & 0xFF;
                    out[2] = (currentKeyVer >>> 8) & 0xFF;
                    out[3] = currentKeyVer & 0xFF;
                    out.set(nonce, 4);
                    out.set(new Uint8Array(ct), 16);
                    return out;
                });
        });
    }

    // Decrypt [keyVer:4][nonce:12][ciphertext+tag] → Uint8Array
    function decryptPayload(data) {
        var kv = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
        var nonce = data.subarray(4, 16);
        var ct = data.subarray(16);
        return fetchKey(kv).then(function(key) {
            return crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
        }).then(function(pt) { return new Uint8Array(pt); });
    }

    // Encrypt file bytes for storage (same format: [keyVer:4][nonce:12][ct])
    function encryptFileBytes(bytes) {
        if (!encryptionEnabled) return Promise.resolve(bytes);
        return encryptPayload(bytes);
    }

    // Decrypt file bytes from storage
    function decryptFileBytes(encBytes) {
        if (!encryptionEnabled) return Promise.resolve(encBytes);
        return decryptPayload(new Uint8Array(encBytes));
    }
    // ── End E2E Encryption ──────────────────────────────────────────

    var remoteClients = {};
    var replayMode = false;  // true while replaying buffered messages from relay

    // My display name — read from URL param (set by viewer), fallback to random
    var myName = params.get('UserName') || (function() {
        var c = 'bcdfghjklmnprstvwz', v = 'aeiou';
        var len = 5 + Math.floor(Math.random() * 2), n = '';
        for (var i = 0; i < len; i++) {
            var pool = (i % 2 === 0) ? c : v;
            n += pool.charAt(Math.floor(Math.random() * pool.length));
        }
        return n.charAt(0).toUpperCase() + n.slice(1);
    })();
    console.log('[relay] My name: ' + myName + ', viewId: ' + myViewId);

    // --- Room switching (for hot-switch document changes) ---
    // When the viewer switches documents via hash change, it sends a
    // RelaySwitchRoom message. We disconnect from the old room and
    // connect to the new one, preserving the WASM runtime.
    window.addEventListener('message', function(event) {
        try {
            var msg = typeof event.data === 'string' ? JSON.parse(event.data) : null;
            if (!msg) return;
            // Parent says stop — iframe is being destroyed. Disconnect
            // to prevent stale checkpoint saves from overwriting the
            // file that's being uploaded for the next session.
            if (msg.MessageId === 'RelayDisconnect') {
                console.log('[relay] Disconnect requested — closing WebSocket');
                connected = false;
                if (ws) { ws.onmessage = null; ws.close(); ws = null; }
                return;
            }
            if (msg.MessageId === 'ForceSave') {
                console.log('[relay] Force save requested (overriding conflict)');
                forceNextSave = true;
                saveAndUploadCheckpoint();
                return;
            }
            if (msg.MessageId === 'KeyResponse' && msg.Values) {
                _onKeyResponse(msg.Values.keyVersion, msg.Values.key);
                return;
            }
            if (msg.MessageId !== 'RelaySwitchRoom') return;
            var newRoom = msg.Values.room;
            var newDoc = msg.Values.docName;
            console.log('[relay] Room switch: ' + relayUrl + ' → ' + newRoom);

            // Close old connection — null ALL handlers to prevent stale
            // messages from being processed against the new room's state
            if (ws) {
                ws.onmessage = null;
                ws.onopen = null;
                ws.onclose = null;
                ws.onerror = null;
                if (ws.readyState <= 1) ws.close();
            }

            // Reset state for new room
            connected = false;
            activated = false;
            isFirstClient = false;
            joinFileHash = null;
            joinFileSeq = 0;
            lastSeq = 0;
            lastKnownHash = null;
            forceNextSave = false;
            sendQueue = [];
            recvQueue = [];
            kitQueue = []; // drop any pending messages from old room
            _preActivateQueue = []; // drop pre-activate input from old room
            lateJoinFileReady = false;
            // Re-arm the switchdoc-complete gate for the new room; a stale
            // "loaded" flag from the previous room must not let the next join
            // skip waiting for its own switchdocument.
            _pendingSwitchDoc = null;
            window.__wasmSwitchDocLoaded = false;

            // Reset encryption state — every doc has its own per-file
            // AES-GCM key. Without this, A continues to use the OLD
            // doc's key to (en|de)crypt messages in the new room, and
            // every cross-peer message fails to decrypt silently.
            // wopiSrc must also track the new doc so fetchKey() asks
            // the parent for the correct file's key.
            encryptionEnabled = false;
            currentKeyVer = 0;
            _keyCache = {};
            _pendingKeyReqs = {};
            if (newDoc) {
                wopiSrc = newDoc;
            } else {
                // Fall back to extracting from the new room URL
                //   wss://.../room/<wopisrc>  → <wopisrc>
                var m = /\/room\/([^?#]+)/.exec(newRoom || '');
                if (m) wopiSrc = decodeURIComponent(m[1]);
            }
            currentRoomDoc = wopiSrc; // latest hot-switch target (stale-switchdoc gate)
            console.log('[relay] Encryption state cleared; wopiSrc=' + wopiSrc);
            // Keep remoteClients — they'll be cleaned up when new room announces joins
            for (var vid in remoteClients) {
                if (remoteClients[vid].clientId > 0) {
                    try { Module._close_remote_client(remoteClients[vid].clientId); } catch(e) {}
                }
            }
            remoteClients = {};

            // Connect to new room
            relayUrl = newRoom;
            // We started in single-user mode (no relay= URL param on the
            // initial cool.html load — viewer prewarm path). Now that a
            // RelaySwitchRoom hands us a real room URL, we're in co-edit
            // mode. Without this, the save/0x07 path silently treats the
            // user's Ctrl+S as a single-user save and never rotates the
            // broker checkpoint, so late joiners see stale content.
            singleUserMode = false;
            ws = new WebSocket(newRoom);
            ws.binaryType = 'arraybuffer';
            ws.onopen = onWsOpen;
            ws.onmessage = onWsMessage;
            ws.onerror = function(err) { console.error('[relay] WebSocket error', err); };
            ws.onclose = function() { connected = false; console.log('[relay] Disconnected'); };

            console.log('[relay] Connecting to new room: ' + newRoom);

            // Restart the activation polling — it self-cleared when we
            // activated in the previous room. For hot-switch late join,
            // coolwsdReady is already true (prewarm), so activation needs
            // to happen as soon as we know we can join.
            startActivationPoll();
        } catch(e) {}
    });

    // --- Relay framing ---
    function sendToRelay(type, viewId, payload) {
        var encoded = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload || []);
        var frame = new Uint8Array(1 + 4 + encoded.length);
        frame[0] = type;
        frame[1] = (viewId >>> 24) & 0xFF;
        frame[2] = (viewId >>> 16) & 0xFF;
        frame[3] = (viewId >>> 8) & 0xFF;
        frame[4] = viewId & 0xFF;
        frame.set(encoded, 5);
        // Encrypt payload for sensitive frame types
        if (encryptionEnabled && ENCRYPTED_TYPES[type]) {
            var header = frame.subarray(0, 5);
            encryptPayload(frame.subarray(5)).then(function(enc) {
                var ef = new Uint8Array(5 + enc.length);
                ef.set(header);
                ef.set(enc, 5);
                if (connected && ws) ws.send(ef);
                else sendQueue.push(ef);
            });
            return;
        }
        if (connected && ws) ws.send(frame);
        else sendQueue.push(frame);
    }

    function parseFrame(data) {
        var f = new Uint8Array(data);
        if (f.length < 5) return null;
        return {
            type: f[0],
            viewId: ((f[1] << 24) | (f[2] << 16) | (f[3] << 8) | f[4]) >>> 0,
            payload: f.slice(5)
        };
    }

    console.log('[relay] My viewId=' + myViewId);

    // --- Intercept document fetch for late-join file redirect ---
    var lateJoinFileReady = false;
    // Filename this late-join queued a switchdocument for (null if none). The
    // activation poll waits for wasm-loader to signal this doc has actually
    // loaded before starting replay, so replayed edits land on the real
    // checkpoint doc and not the prewarm blank (which switchdocument replaces).
    var _pendingSwitchDoc = null;
    // Generous cap: wait this long after base-ready for switchdoc-complete
    // before activating anyway. Must exceed the base-ready → switchdoc-complete
    // gap, which on a loaded box can be 40s+ (the switch runs near the end of a
    // cold load). A truly BROKEN switch is handled separately by wasm-loader's
    // HotSwitchFailed watchdog (25s no-canvas-change) + 60s hard timeout, which
    // cold-reloads — so this cap only needs to not fire during a slow-but-fine
    // switch. 30s was too tight and re-exposed the replay-before-switch race.
    var SWITCH_WAIT_CAP = 120000;
    var origFetch = window.fetch;

    // --- Send message to Kit via local session ---
    // Send directly to Kit C++ via Module._handle_cool_message.
    // This bypasses FakeWebSocket.send (which is intercepted by us) and
    // postMobileMessage (which might be overridden). Direct C++ call.
    var originalSend = null; // set in installSendInterceptor
    // Send a message to the Kit. Called for:
    //  - Non-user-input from COOL JS (tileprocessed, clientzoom, etc.)
    //    → must be synchronous, COOL JS expects immediate processing
    //  - Relay echo of own messages (from processUIMessage)
    //    → also synchronous to maintain Kit's event ordering
    var kitQueue = [];
    function sendToKit(data) {
        // Queue and process ONE message per event loop tick. The Kit worker
        // responds via MAIN_THREAD_EM_ASM which needs the main thread idle.
        // Processing multiple messages in a tight loop starves the Kit's
        // response delivery.
        kitQueue.push(data);
        if (kitQueue.length === 1) {
            setTimeout(processOneKitMessage, 0);
        }
    }
    function processOneKitMessage() {
        if (kitQueue.length === 0) return;
        var msg = kitQueue.shift();
        if (globalThis.postMobileMessage) {
            if (typeof msg === 'string' && msg.startsWith('key ')) {
                console.log('[relay] Kit←relay: ' + msg.substring(0, 50));
            }
            // Set guard flag so the postMobileMessage wrapper doesn't
            // re-intercept relay echoes delivered to Kit (which would
            // cause an insertfile → relay → self → Kit → relay loop).
            globalThis._deliveringToKit = true;
            try { globalThis.postMobileMessage(msg); }
            finally { globalThis._deliveringToKit = false; }
        } else {
            console.error('[relay] NO postMobileMessage!');
        }
        if (kitQueue.length > 0) {
            setTimeout(processOneKitMessage, 1);
        }
    }

    // --- Join protocol: request to join as soon as relay connects ---
    function initiateJoin() {
        var wopiSrc = params.get('WOPISrc') || '';
        console.log('[relay] Sending join-request (WOPISrc=' + wopiSrc + ')');
        sendToRelay(0x04, myViewId, wopiSrc);
    }

    // --- COOLWSD readiness: poll for document loaded ---
    function waitForCoolwsd() {
        if (coolwsdReady) return;

        var fws = globalThis.TheFakeWebSocket;
        if (!fws) { setTimeout(waitForCoolwsd, 100); return; }

        // Authoritative readiness: the editor sets app.map._docLoaded=true
        // ONLY when the 'docloaded' event fires with status:true — i.e. the
        // kit has actually loaded the document (it is also the gate the
        // editor uses to emit App_LoadingStatus=Document_Loaded). Earlier
        // this polled UI heuristics (#StateWordCount text, statusbar length,
        // #map+canvas presence) which give FALSE POSITIVES during a
        // cold-reload late-join: the shell status bar / canvas appear ~1s
        // before the kit finishes loading. A premature coolwsdReady flushes
        // A's buffered relay edits into a not-yet-loaded kit → the kit
        // rejects them (cmd=uno kind=nodocloaded) so they are lost (B never
        // converges to A's unsaved edits) and the in-flight load can derail
        // into faileddocloading. Gating on the real flag fixes both.
        if (!(window.app && window.app.map && window.app.map._docLoaded === true)) {
            setTimeout(waitForCoolwsd, 200);
            return;
        }

        coolwsdReady = true;
        console.log('[relay] COOLWSD ready (document loaded)');
        installSendInterceptor();

        // Flush queued relay messages
        var pending = recvQueue.splice(0);
        console.log('[relay] Flushing ' + pending.length + ' queued relay messages');
        for (var i = 0; i < pending.length; i++) {
            processRelayMessage(pending[i]);
        }

        // If first client or already got join-response, activate now
        if (isFirstClient && !activated) {
            activateClient();
        }
    }
    setTimeout(waitForCoolwsd, 500);

    // --- Activate: send join-ready and start accepting/sending messages ---
    function activateClient() {
        if (activated) return;
        activated = true;
        // Flush any input that arrived before we finished activating
        // (e.g. typing on the new room immediately after a hot-switch).
        // Re-feed each item through the FakeWebSocket so it goes through
        // the normal interceptedSend path now that `activated` is true.
        if (_preActivateQueue.length > 0) {
            var preQ = _preActivateQueue.splice(0);
            console.log('[relay] Flushing ' + preQ.length + ' pre-activate input messages');
            try {
                var fws = globalThis.TheFakeWebSocket;
                if (fws && fws.send) {
                    for (var pi = 0; pi < preQ.length; pi++) {
                        fws.send(preQ[pi]);
                    }
                }
            } catch (e) {
                console.warn('[relay] pre-activate flush error:', e.message);
            }
        }
        // Set the initial known hash from the file we loaded/joined with.
        // This is used for conflict detection when saving.
        lastKnownHash = joinFileHash;

        // First client registers the room checkpoint via its 0x06
        // payload: { hash, locator }. `hash` is sha256(plaintext) of
        // /wasm/<wopiSrc>; `locator` is the URL late joiners will
        // fetch those bytes from. Late joiners just echo back the
        // `hash` they computed.
        //
        // Content-viewer co-edit: there is no /wasm/ endpoint. The bytes to
        // hash are the ones the SW serves at /local-file/<id> (identical to
        // what preRun wrote into the FS), and the locator late joiners can
        // actually reach is the content-viewer-server's shared-file store.
        var wasmUrl = isContentViewer
            ? window.location.origin + '/local-file/' + encodeURIComponent(cvLocalFileId)
            : window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
        var checkpointLocator = isContentViewer
            ? window.location.origin + '/shared-file/' + cvRoomKey()
            : wasmUrl;
        function sendReady(hash) {
            lastKnownHash = hash || lastKnownHash;
            var payloadObj = {};
            if (hash) payloadObj.hash = hash;
            if (isFirstClient && hash) payloadObj.locator = checkpointLocator;
            var readyPayload = Object.keys(payloadObj).length ? JSON.stringify(payloadObj) : '';
            console.log('[relay] Activating — sending join-ready hash=' +
                        (hash ? hash.substring(0, 16) + '…' : 'none') +
                        (isFirstClient && hash ? ' locator=' + checkpointLocator : ''));
            sendToRelay(0x06, myViewId, readyPayload);
        }
        // Enter replay mode BEFORE sending 0x06 — the relay replays
        // _joinBuffer frames back to us the instant it receives 0x06,
        // and the first echoed 0x00 can land before sendToRelay's
        // promise has resolved. If replayMode is still false, A's
        // edits get routed to a remote client and never reach the
        // local Kit — B stays stuck on the pre-join baseline.
        if (!isFirstClient) {
            replayMode = true;
            console.log('[relay] Replay mode ON — buffered messages → local Kit');
        }

        // Fetch the E2E encryption key BEFORE sending 0x06. Replay
        // frames arrive the instant the relay sees 0x06. If the key
        // isn't ready by then, looksEncrypted === false (because
        // encryptionEnabled is still false), the encrypted payload
        // is treated as plaintext, the UTF-8 garbage fails the
        // isUserInput prefix check and gets silently dropped — B
        // ends up with 0 of A's edits applied.
        function enableEncryptionThenReady() {
            function proceed() {
                if (!joinFileHash && isFirstClient) {
                    origFetch(wasmUrl).then(function(r) { return r.arrayBuffer(); })
                        .then(function(buf) { return crypto.subtle.digest('SHA-256', buf); })
                        .then(function(hashBuf) {
                            joinFileHash = Array.from(new Uint8Array(hashBuf)).map(function(b) {
                                return b.toString(16).padStart(2, '0');
                            }).join('');
                            sendReady(joinFileHash);
                        }).catch(function(e) {
                            console.warn('[relay] First-client hash self-compute failed:', e);
                            sendReady(null);
                        });
                } else {
                    sendReady(joinFileHash);
                }
            }
            if (singleUserMode) { proceed(); return; }
            // Content-viewer co-edit: no viewer-server key API behind this
            // origin (the SPA fallback would answer /api/keys/* with HTML).
            // Frames run unencrypted, same as the pre-E2E relay default.
            if (isContentViewer) { proceed(); return; }
            var keyBaseUrl = getFileStorageUrl(wopiSrc);
            if (!keyBaseUrl) { proceed(); return; }
            var kvUrl = keyBaseUrl.replace(/\/api\/files\/.*/, '/api/keys/current-version');
            origFetch(kvUrl, { mode: 'cors' }).then(function(r) { return r.json(); })
                .then(function(data) {
                    currentKeyVer = data.keyVersion;
                    return fetchKey(currentKeyVer);
                }).then(function() {
                    encryptionEnabled = true;
                    console.log('[relay] E2E encryption enabled, keyVersion=' + currentKeyVer);
                    proceed();
                }).catch(function(e) {
                    console.warn('[relay] Encryption key fetch failed, running unencrypted:', e.message);
                    proceed();
                });
        }
        enableEncryptionThenReady();

        try { parent.postMessage(JSON.stringify({
            MessageId: 'RelayLateJoinPhase',
            Values: { phase: 'replaying' }
        }), '*'); } catch(e) {}

        // Tell the parent viewer that input is now accepted. Until this
        // fires the viewer keeps its loading shield up — otherwise the
        // user would see the document but typing would silently disappear
        // ("Dropping input not activated yet").
        try {
            parent.postMessage(JSON.stringify({
                MessageId: 'RelayActivated',
                Values: { viewId: myViewId, isFirstClient: isFirstClient }
            }), '*');
        } catch(e) {}

        // Announce presence
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId + ' name=' + myName);

        // Initial checkpoint: only for the first client (its doc IS the
        // authoritative state). Late joiners must NOT save immediately —
        // their Kit still has the checkpoint doc and the replay messages
        // haven't been applied yet. Saving now would overwrite the stored
        // file with stale content and prune the relay's message log.
        //
        // Skip initial checkpoint for the first client too — the viewer
        // already uploaded the correct file. A checkpoint now would save
        // a potentially blank/stale doc (e.g., a prewarm blank that hasn't
        // been switched yet) and overwrite the original on the viewer.
        // The relay hash is set on the first user-initiated save.
        // Automatic initial checkpoints are DISABLED to prevent
        // blank-doc / stale-doc overwrites. The viewer already has the
        // correct file. Checkpoints only run on user-initiated saves
        // (Ctrl+S / .uno:Save) or explicit modification events.
        console.log('[relay] Skipping initial checkpoint (first=' + isFirstClient + ') — file already on viewer');
        // if (isFirstClient) {
        //     saveAndUploadCheckpoint();
        // } else {
        //     setTimeout(function() { saveAndUploadCheckpoint(); }, 10000);
        // }
    }

    // --- FakeWebSocket.send interceptor ---
    function installSendInterceptor() {
        var fws = globalThis.TheFakeWebSocket;
        if (!fws) {
            console.log('[relay] TheFakeWebSocket not found — retrying installSendInterceptor');
            setTimeout(installSendInterceptor, 200);
            return;
        }

        // Save original send BEFORE replacing — sendToKit uses this to
        // bypass the relay and talk directly to the Kit's FakeSocket.
        originalSend = fws.send.bind(fws);

        function interceptedSend(data) {
            // Binary paste (Blob): COOL's _pasteTypedBlob sends
            //   `paste mimetype=image/png\n<binary>` as a Blob via
            //   app.socket.sendMessage.
            //
            // The WASM Kit does NOT process the `paste mimetype=…`
            // protocol message (ChildSession::paste is not wired up).
            // So we convert into the paths that DO work:
            //   - image/* → `insertfile name=clipboard.png type=graphic data=<base64>`
            //     (via postMobileMessage, same as the toolbar Insert Image path)
            //   - text/html → extract plain text, feed through `textinput`
            //   - text/plain → feed through `textinput`
            //
            // The converted message also goes through the relay so peers
            // see the paste.
            if (data instanceof Blob) {
                data.arrayBuffer().then(function(ab) {
                    var bytes = new Uint8Array(ab);
                    // Parse the header: "paste mimetype=<type>\n"
                    var nlIdx = -1;
                    for (var i = 0; i < Math.min(200, bytes.length); i++) {
                        if (bytes[i] === 0x0A) { nlIdx = i; break; }
                    }
                    if (nlIdx < 0) {
                        // Not a recognized paste blob — drop it. Everything
                        // must go through the relay, and we can't relay raw
                        // binary without a protocol for it.
                        console.log('[relay] Blob without newline header — dropping (' + bytes.length + 'B)');
                        return;
                    }
                    var header = new TextDecoder().decode(bytes.slice(0, nlIdx));
                    var mimeMatch = header.match(/^paste mimetype=(.+)/);
                    if (!mimeMatch) {
                        console.log('[relay] Blob with unrecognized header "' + header.substring(0, 40) + '" — dropping');
                        return;
                    }
                    var mime = mimeMatch[1].trim();
                    var payload = bytes.slice(nlIdx + 1);
                    console.log('[relay] Paste blob: mimetype=' + mime + ' payload=' + payload.length + 'B');

                    // Helper: in single-user mode there is no relay echo,
                    // so the local Kit must be driven directly. In co-edit
                    // mode go through the relay; the echo (processUIMessage
                    // → sendToKit) is what makes our own kit see the paste.
                    // Mixing the two paths would double-apply on the
                    // sender, so it's strictly one-or-the-other.
                    var dispatchPaste = function(payloadStr) {
                        if (singleUserMode) {
                            sendToKit(payloadStr);
                        } else if (activated) {
                            sendToRelay(0x00, myViewId, payloadStr);
                        }
                    };

                    if (mime.startsWith('image/')) {
                        // Convert to insertfile (the path that works in WASM).
                        var b64 = '';
                        var CHUNK = 32768;
                        for (var ci = 0; ci < payload.length; ci += CHUNK) {
                            b64 += String.fromCharCode.apply(null, payload.slice(ci, Math.min(ci + CHUNK, payload.length)));
                        }
                        b64 = btoa(b64);
                        var ext = mime.split('/')[1] || 'png';
                        var msg = 'insertfile name=clipboard-paste.' + ext + ' type=graphic data=' + b64;
                        console.log('[relay] Converting image paste → insertfile (' + msg.length + ' chars, mode=' +
                                    (singleUserMode ? 'local' : 'relay') + ')');
                        dispatchPaste(msg);
                    } else if (mime.startsWith('text/html') || mime.startsWith('text/plain')) {
                        // Send the FULL paste command as a string. Kit's
                        // paste handler (ChildSession::paste) processes
                        // `paste mimetype=text/html\n<html>` and preserves
                        // formatting (bold, italic, underline, etc.).
                        // Stripping to textinput would lose all formatting.
                        var textPayload = new TextDecoder().decode(payload);
                        var pasteCmd = 'paste mimetype=' + mime + '\n' + textPayload;
                        console.log('[relay] Rich paste (' + mime + ', ' + textPayload.length + ' chars, mode=' +
                                    (singleUserMode ? 'local' : 'relay') + ')');
                        dispatchPaste(pasteCmd);
                    } else {
                        // Unknown mimetype — try text extraction. If it has
                        // readable text, dispatch as textinput.
                        console.log('[relay] Unknown paste mimetype "' + mime + '" — attempting text extraction');
                        try {
                            var unknownText = new TextDecoder().decode(payload).trim();
                            if (unknownText) {
                                dispatchPaste('textinput id=0 text=' + unknownText);
                            }
                        } catch(e) {
                            console.log('[relay] Could not extract text from unknown paste — dropping');
                        }
                    }
                });
                return;
            }

            var text = typeof data === 'string' ? data : '';
            // User-input prefixes that MUST go through the relay so all
            // peers see the same edit. Adding any new doc-mutating prefix
            // here is a NORMAL co-edit fix; missing one means the action
            // works locally for the actor but is invisible to peers (the
            // class of bugs that produced the Delete-key bug).
            //
            // Categories covered:
            //   key / mouse / textinput / windowkey / uno
            //     The classic input messages from Map.Keyboard / mouse /
            //     toolbar / shortcut paths.
            //   removetextcontext / removetextcontent
            //     Delete and Backspace go through TextInput.js's
            //     beforeinput handler, which sends `removetextcontext`
            //     (note the typo — TextInput.js's TODO promises it'll be
            //     renamed to `removetextcontent`; cover both).
            //   contentcontrolevent
            //     Form-field interactions: date picker, dropdown, picture
            //     content controls. Each event mutates the doc.
            //   moveselectedclientparts
            //     Reorder slides (Impress) or sheets (Calc). Pure doc
            //     mutation — peers MUST apply the same reorder.
            //   completefunction
            //     Calc autocomplete inserts a function name into the
            //     active formula cell.
            //   selecttext / resetselection
            //     Selection state. Each peer renders the others' cursors
            //     and selections via a remote-client Kit; for that mirror
            //     to show the right highlighted range, A's selection
            //     events MUST reach B's remote-Kit-for-A. Sources:
            //     CanvasTileLayer._postSelectTextEvent (selection-handle
            //     drag → TextSelectionHandleSection / TableSelectMarker /
            //     CellSelectionHandle); Parts.js / SearchService /
            //     PartsPreview send `resetselection`.
            //
            //   insertfile
            //     Image / media insertion. In WASM mode the base64 data=
            //     payload is embedded in the message itself (not on a
            //     server that peers could HTTP-fetch), so relaying the
            //     full message gives every peer the image bytes.
            //     NOTE: insertfile in WASM mode goes through
            //     postMobileMessage (not fws.send), so it's intercepted
            //     by the postMobileMessage wrapper below, not here.
            //     It IS in the list so the receive-side filter passes it
            //     through to remote-client Kits.
            //
            // NOT relayed (intentionally — per-user view / server-side):
            //   setclientpart / selectclientpart / setpage  → each user
            //     can view a different slide or sheet
            //   windowmouse / windowgesture / windowcommand → clicks
            //     inside per-user dialogs; doc-side effect comes via uno
            //   clientzoom, tileprocessed, commandvalues,
            //   gettextselection, paintwindow → local view state / queries
            //   attemptlock, closedocument, versionrestore, downloadas,
            //   exportas, renamefile → server-side WOPI ops
            // Mouse moves: NEVER relay — just buffer the last position.
            // The buffer is flushed to the relay right before any
            // buttondown or buttonup so remote Kits know the cursor
            // position at the moment of the click. This gives remotes
            // the start and end points of a drag-selection without
            // flooding the relay with every intermediate pixel.
            if (text.startsWith('mouse type=move ')) {
                globalThis._lastMouseMove = data;
                originalSend(data);
                return;
            }
            // Before buttondown/buttonup, send the buffered move so
            // remote Kits see the cursor position at click time.
            if (text.startsWith('mouse type=button') && globalThis._lastMouseMove) {
                sendToRelay(0x00, myViewId, globalThis._lastMouseMove);
                globalThis._lastMouseMove = null;
            }
            var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
                text.startsWith('textinput ') || text.startsWith('windowkey ') ||
                text.startsWith('uno ') ||
                text.startsWith('removetextcontext ') ||
                text.startsWith('removetextcontent ') ||
                text.startsWith('contentcontrolevent ') ||
                text.startsWith('moveselectedclientparts ') ||
                text.startsWith('completefunction ') ||
                text.startsWith('selecttext ') ||
                text.startsWith('insertfile ') ||
                text.startsWith('paste mimetype=') ||
                text === 'resetselection';
            if (isUserInput) {
                if (!activated) {
                    if (_preActivateQueue.length >= _preActivateQueueCap) {
                        console.log('[relay] Dropping input (queue full, not activated yet): ' + text.substring(0, 40));
                        return;
                    }
                    _preActivateQueue.push(data);
                    return;
                }
                // Suppress Map.Keyboard's uno:Paste when our paste handler
                // already sent external content as a paste blob. The flag
                // is set by the paste handler in wasm-loader.js.
                if (globalThis._suppressNextPaste) {
                    if (text === 'uno .uno:Paste' || text === 'uno .uno:PasteSpecial') {
                        console.log('[relay] Suppressing Map.Keyboard paste (external paste handled)');
                        globalThis._suppressNextPaste = false;
                        return;
                    }
                }
                // Same for Ctrl+X: Map.Keyboard's eager keydown uno:Cut
                // would delete the selection before wasm-loader's oncut
                // captures its content for the system clipboard. oncut
                // sends the (only) .uno:Cut itself after the capture.
                if (globalThis._suppressNextCut) {
                    if (text === 'uno .uno:Cut') {
                        console.log('[relay] Suppressing Map.Keyboard cut (oncut owns the sequence)');
                        globalThis._suppressNextCut = false;
                        return;
                    }
                }
                // `uno .uno:Save` and `.uno:SaveAs` must NOT be forwarded
                // to the kit. The kit's wsd/DocumentBroker.cpp:5284 has
                // an assertion specifically to catch this — the save flow
                // is handled out-of-band by saveAndUploadCheckpoint(),
                // which produces a checkpoint and uploads to storage.
                // Forwarding the uno would let it reach forwardToChild,
                // hit the assertion, and abort the WASM process (the user
                // sees "save failed / discard only" because the kit dies).
                //
                // Check this BEFORE the kit/relay forward so the save
                // never reaches DocumentBroker. Other forms of save —
                // `save dontTerminateEdit=…` from the toolbar, and
                // .uno:SaveGraphic — stay in their original paths
                // (toolbar save is handled in the else-branch below at
                // line ~796; SaveGraphic is exempted from the kit's
                // own assertion).
                if (isUserSaveCommand(text)) {
                    console.log('[relay] User save detected (' + text.substring(0, 40) +
                                ') — scheduling checkpoint + upload (kit forward skipped)');
                    saveAndUploadCheckpoint();
                    return;
                }

                if (singleUserMode) {
                    // No relay — send directly to local Kit
                    originalSend(data);
                } else {
                    sendToRelay(0x00, myViewId, data);
                }
            } else {
                // Non-user-input (tileprocessed, clientzoom, etc.) goes
                // directly to Kit SYNCHRONOUSLY via postMobileMessage.
                // These are not relayed and must not be deferred.
                if (globalThis.postMobileMessage) {
                    globalThis.postMobileMessage(data);
                }
                // The toolbar Save button sends `save dontTerminateEdit=…`
                // (lowercase, no uno: prefix) — this goes to Kit directly
                // (not relayed, which is correct: the save is a local Kit
                // operation). BUT we still need to create a checkpoint and
                // upload the result to storage so other peers and the file
                // listing stay in sync. Schedule saveAndUploadCheckpoint
                // the same way we do for `uno .uno:Save` (Ctrl+S).
                if (text.startsWith('save ') && text.includes('dontTerminateEdit')) {
                    console.log('[relay] Toolbar save detected — scheduling checkpoint + upload');
                    saveAndUploadCheckpoint();
                }
            }
        }

        var FWS = fws.constructor;
        if (FWS && FWS.prototype) FWS.prototype.send = interceptedSend;
        fws.send = interceptedSend;
        console.log('[relay] Send interceptor installed');

        // ── postMobileMessage wrapper ──────────────────────────────
        // COOL's FileInserter in WASM mode calls postMobileMessage
        // directly (not fws.send), sending:
        //   insertfile name=<n> type=graphic data=<base64>
        // This bypasses interceptedSend entirely. We wrap
        // postMobileMessage so `insertfile` messages are routed
        // through the relay (they carry the full base64 payload, so
        // every peer receives the image bytes). All other messages
        // pass through to the Kit unchanged.
        // ── postMobileMessage wrapper ──────────────────────────────
        // COOL's FileInserter in WASM mode calls postMobileMessage
        // directly (not fws.send), sending:
        //   insertfile name=<n> type=graphic data=<base64>
        // This bypasses interceptedSend entirely. We wrap
        // postMobileMessage so `insertfile` messages are routed
        // through the relay (they carry the full base64 payload, so
        // every peer receives the image bytes). All other messages
        // pass through to the Kit unchanged.
        //
        // Guard: when OUR OWN processUIMessage delivers a relay echo
        // back to the local Kit (via sendToKit → postMobileMessage),
        // we must NOT re-intercept it — that would create an infinite
        // relay→self→relay loop. The `_deliveringToKit` flag is set
        // in processOneKitMessage to suppress re-interception.
        if (typeof globalThis.postMobileMessage === 'function') {
            var origPostMobile = globalThis.postMobileMessage;
            globalThis.postMobileMessage = function(msg) {
                // Skip re-interception when delivering a relay echo to Kit.
                if (globalThis._deliveringToKit) {
                    return origPostMobile(msg);
                }
                if (typeof msg === 'string' && msg.startsWith('insertfile ')) {
                    if (!activated) {
                        console.log('[relay] Dropping insertfile (not activated yet)');
                        return;
                    }
                    // Same dispatch rule as paste blobs: in single-user
                    // mode go directly to the local Kit (there is no relay
                    // echo to bring it back); in co-edit go through the
                    // relay so all peers receive the same image bytes,
                    // and the echo carries it to our own Kit.
                    if (singleUserMode) {
                        console.log('[relay] insertfile → local Kit (single-user, ' +
                                    msg.length + ' chars)');
                        return origPostMobile(msg);
                    }
                    console.log('[relay] Intercepted insertfile via postMobileMessage (' +
                                msg.length + ' chars) — routing through relay');
                    sendToRelay(0x00, myViewId, msg);
                    return;
                }
                return origPostMobile(msg);
            };
            console.log('[relay] postMobileMessage wrapper installed (catches insertfile)');
        }
    }

    // --- Remote client management ---
    // Messages FROM remote client Kit sessions back to JS. These include
    // tile invalidations, status changes, cursor positions, etc. triggered
    // by remote users' actions. We forward the relevant ones to the primary
    // view's Kit session so the local canvas re-renders.
    globalThis.onRemoteClientMessage = function(clientId, data) {
        var text = typeof data === 'string' ? data : '';
        if (!text) return;

        // Log all messages from remote client for debugging
        if (text.startsWith('invalidate') || text.startsWith('statechanged') ||
            text.startsWith('status:') || text.startsWith('error:')) {
            console.log('[relay] Remote client ' + clientId + ' → ' + text.substring(0, 120));
        }

        // Only forward messages that reflect DOCUMENT changes (not remote
        // view UI state). The remote client sends hundreds of statechanged
        // messages during init (toolbar enabled/disabled etc.) — forwarding
        // those would corrupt the primary view's UI state.
        var shouldForward = text.startsWith('invalidatetiles:');
        // Word count and modified status are document-level and must be
        // forwarded: COOL's Kit emits .uno:StateWordCount through the
        // remote-client channel even for the LOCAL view, so if we don't
        // forward it the #StateWordCount widget never updates. (This was
        // briefly removed in an attempt to avoid a cross-doc clobber
        // during hot-switch, but that broke the wc widget for everyone —
        // see test-regression-room-switch which reads wc for validation.)
        if (text.indexOf('.uno:StateWordCount=') >= 0) shouldForward = true;
        if (text.indexOf('.uno:ModifiedStatus=') >= 0) shouldForward = true;

        if (shouldForward) {
            // Defer to next tick — onRemoteClientMessage is called from
            // EM_ASM on the main thread; calling onmessage synchronously
            // can cause reentrancy issues with the COOL message handler.
            var msg = text;
            setTimeout(function() {
                var ws = globalThis.TheFakeWebSocket;
                if (ws && ws.onmessage) {
                    ws.onmessage({ data: msg });
                }
            }, 0);
        }

        // Other messages from remote Kit (commandresult, tile data, etc.)
        // are specific to the remote view and can be ignored.
    };

    function sendToRemoteClient(clientId, text) {
        if (!Module || !Module.calledRun || !Module._handle_remote_message) return;
        if (text.startsWith('textinput ')) {
            var match = text.match(/text=(.+)/);
            if (match) {
                var chars = decodeURIComponent(match[1]);
                for (var ci = 0; ci < chars.length; ci++) {
                    var charCode = chars.charCodeAt(ci);
                    Module._handle_remote_message(clientId,
                        Module.stringToNewUTF8('key type=input char=' + charCode + ' key=0'));
                    Module._handle_remote_message(clientId,
                        Module.stringToNewUTF8('key type=up char=0 key=0'));
                }
            }
        } else {
            Module._handle_remote_message(clientId, Module.stringToNewUTF8(text));
        }
    }

    var _pendingRemoteClients = []; // viewIds waiting for runtime init
    function createRemoteClient(viewId) {
        if (remoteClients[viewId]) return;
        // Guard: need C++ server socket ready (coolwsd_server_socket_fd != -1).
        // coolwsdReady (DOM check) fires before the C++ socket is created.
        // is_preinit_done() checks the actual C++ fd.
        var serverReady = coolwsdReady && Module && Module.calledRun && Module._is_preinit_done && Module._is_preinit_done();
        if (!serverReady || !Module._create_remote_client) {
            if (_pendingRemoteClients.indexOf(viewId) < 0) {
                _pendingRemoteClients.push(viewId);
                console.log('[relay] Queuing remote client for viewId=' + viewId + ' (WASM not ready)');
            }
            return;
        }
        console.log('[relay] Creating remote client for viewId=' + viewId);
        var clientId = Module._create_remote_client();
        if (clientId < 0) {
            // Server socket not ready yet — queue for retry
            if (_pendingRemoteClients.indexOf(viewId) < 0) _pendingRemoteClients.push(viewId);
            console.log('[relay] Server not ready, will retry viewId=' + viewId);
            return;
        }
        remoteClients[viewId] = { clientId: clientId, ready: false, queue: [] };
        console.log('[relay] Remote client created: viewId=' + viewId + ' clientId=' + clientId);
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId + ' name=' + myName);
    }

    // --- Poll for C++ ready signals ---
    function globalPollReady() {
        var serverUp = coolwsdReady && Module && Module.calledRun && Module._is_preinit_done && Module._is_preinit_done();
        if (!serverUp || !Module._poll_remote_client_ready) {
            setTimeout(globalPollReady, 500);
            return;
        }
        // Flush any remote clients that were queued before COOLWSD was ready
        if (_pendingRemoteClients.length > 0) {
            var pending = _pendingRemoteClients.splice(0);
            console.log('[relay] Flushing ' + pending.length + ' queued remote clients (COOLWSD ready)');
            for (var i = 0; i < pending.length; i++) createRemoteClient(pending[i]);
        }
        // Flush messages that arrived before COOLWSD was ready
        if (_kitMessageQueue.length > 0) {
            var queued = _kitMessageQueue.splice(0);
            console.log('[relay] Flushing ' + queued.length + ' queued messages (COOLWSD ready)');
            for (var j = 0; j < queued.length; j++) processUIMessage(queued[j].msg, queued[j].seq);
        }
        var readyId = Module._poll_remote_client_ready();
        if (readyId > 0) {
            for (var vid in remoteClients) {
                if (remoteClients[vid].clientId === readyId && !remoteClients[vid].ready) {
                    console.log('[relay] Client ' + readyId + ' (viewId=' + vid + ') ready');
                    remoteClients[vid].ready = true;
                    var q = remoteClients[vid].queue;
                    remoteClients[vid].queue = [];
                    if (q.length > 0) {
                        console.log('[relay] Flushing ' + q.length + ' queued msgs');
                        for (var i = 0; i < q.length; i++) {
                            try { sendToRemoteClient(readyId, q[i]); } catch(e) {}
                        }
                    }
                    break;
                }
            }
        }
        setTimeout(globalPollReady, 500);
    }
    setTimeout(globalPollReady, 1000);

    // True when the COOL JS layer dispatches a user-initiated save.
    // Ctrl+S, the toolbar Save button, and File→Save all funnel through
    // the same .uno:Save command. The Sidebar/Auto-save also produce
    // .uno:Save — that's still legit "user wants to persist this" intent.
    // Ask the parent viewer to encrypt+store v2 bytes on the editor's
    // behalf. The editor doesn't hold the content key; only the parent
    // does (it derived it from the URL fragment's secret on page load).
    // Returns a Promise<{hash, locator}> resolving with the server-
    // confirmed hash and the v2 URL future late joiners will fetch
    // from.
    function saveViaParent(fileId, bytes, localHashHex) {
        return new Promise(function(resolve) {
            var reqId = 'save-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            var timeoutId = setTimeout(function() {
                window.removeEventListener('message', onMsg);
                resolve({ error: 'parent-save-timeout' });
            }, 30000);
            function onMsg(ev) {
                if (typeof ev.data !== 'string') return;
                try {
                    var m = JSON.parse(ev.data);
                    if (!m || m.MessageId !== 'WasmFileSaveResult') return;
                    if (!m.Values || m.Values.reqId !== reqId) return;
                    clearTimeout(timeoutId);
                    window.removeEventListener('message', onMsg);
                    if (m.Values.ok) {
                        resolve({
                            hash: m.Values.hash || localHashHex,
                            locator: m.Values.locator,
                        });
                    } else {
                        resolve({ error: m.Values.error || 'unknown' });
                    }
                } catch(e) {}
            }
            window.addEventListener('message', onMsg);
            try {
                parent.postMessage(JSON.stringify({
                    MessageId: 'WasmFileSave',
                    Values: { fileId: fileId, bytes: Array.from(bytes), reqId: reqId },
                }), '*');
            } catch(e) {
                clearTimeout(timeoutId);
                window.removeEventListener('message', onMsg);
                resolve({ error: 'postmessage-' + (e.message || 'unknown') });
            }
        });
    }

    function isUserSaveCommand(text) {
        if (!text || !text.startsWith('uno ')) return false;
        var cmd = text.substring(4).split('?')[0].split(/\s/)[0];
        // Accept the bare Save plus the explicit-as variants. We do NOT
        // include FileSave (legacy alias) — COOL maps that internally.
        return cmd === '.uno:Save' || cmd === '.uno:SaveAs';
    }

    // Content-viewer CO-EDIT save-rotation. The doc lives in the Emscripten
    // FS (file_path param) and the shared seed bytes live at the same-origin
    // /shared-file/<roomKey> store — so a save rotates the room checkpoint
    // by (1) reading the saved bytes from the FS, (2) overwriting
    // /shared-file/<roomKey> (future joiners' pages stage the SAVED doc, so
    // their hash always matches the rotated checkpoint), and (3) sending the
    // standard 0x07 rotation frame so the relay prunes its message log.
    // Keeps the legacy no-rotate-on-no-op-save invariant: byte-identical
    // saves must NOT rotate, or unpersisted live edits vanish from the
    // replay log and late-joiners diverge.
    //
    // Known narrow race (documented, unhandled): a joiner whose page fetched
    // /shared-file just before a rotation lands hash-mismatches its 0x05 and
    // fails terminally (RelayLateJoinFailed) — re-opening the join link
    // recovers. The window is the seconds between the page staging bytes and
    // the adapter's join.
    function cvSaveAndRotate() {
        if (!connected) return;
        sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        setTimeout(function() {
            var saveAtSeq = lastSeq;
            var filePath = params.get('file_path') || '';
            var mod = globalThis.Module;
            if (!filePath || !mod || !mod.FS) {
                console.error('[relay] CV rotation: no file_path/Module.FS');
                return;
            }
            var bytes;
            try {
                bytes = mod.FS.readFile(filePath);
            } catch (e) {
                console.error('[relay] CV rotation: FS read failed: ' + e.message);
                return;
            }
            crypto.subtle.digest('SHA-256', bytes).then(function(hashBuf) {
                var hashHex = Array.from(new Uint8Array(hashBuf)).map(function(b) {
                    return b.toString(16).padStart(2, '0');
                }).join('');
                if (lastKnownHash && hashHex === lastKnownHash) {
                    console.log('[relay] CV save produced unchanged bytes — skipping rotation '
                        + '(unpersisted live edits stay in the replay log)');
                    try { parent.postMessage(JSON.stringify({
                        MessageId: 'SaveComplete',
                        Values: { hash: hashHex.substring(0, 16), bytes: bytes.length, rotated: false },
                    }), '*'); } catch (e) {}
                    return;
                }
                var locator = window.location.origin + '/shared-file/' + cvRoomKey();
                var fsName = filePath.split('/').pop() || 'document';
                origFetch(locator, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-File-Name': encodeURIComponent(fsName),
                    },
                    body: new Blob([bytes]),
                }).then(function(r) {
                    if (!r.ok) throw new Error('shared-file POST ' + r.status);
                    lastKnownHash = hashHex;
                    var payload = { hash: hashHex, locator: locator, seq: saveAtSeq };
                    if (ws && connected) {
                        var bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
                        var frame = new Uint8Array(5 + bodyBytes.length);
                        frame[0] = 0x07;
                        frame[1] = (myViewId >>> 24) & 0xFF;
                        frame[2] = (myViewId >>> 16) & 0xFF;
                        frame[3] = (myViewId >>> 8) & 0xFF;
                        frame[4] = myViewId & 0xFF;
                        frame.set(bodyBytes, 5);
                        ws.send(frame);
                        console.log('[relay] CV save-rotation 0x07 sent: hash=' + hashHex.substring(0, 16)
                            + '… atSeq=' + saveAtSeq + ' (' + bytes.length + 'B → ' + locator + ')');
                    }
                    try { parent.postMessage(JSON.stringify({
                        MessageId: 'SaveComplete',
                        Values: { hash: hashHex.substring(0, 16), bytes: bytes.length, rotated: true },
                    }), '*'); } catch (e) {}
                }).catch(function(e) {
                    console.error('[relay] CV rotation failed: ' + e.message);
                });
            });
        }, 1500);
    }

    function saveAndUploadCheckpoint() {
        // Content-viewer SINGLE-USER owns save via app.map.save +
        // Module.FS.readFile in the host (no relay, nothing to rotate).
        // Content-viewer CO-EDIT rotates through the shared-file store.
        if (isContentViewer) {
            if (!singleUserMode) cvSaveAndRotate();
            return;
        }
        // In relay mode we need the WebSocket open so we can report the
        // new checkpoint hash back to the server (0x07 frame). In
        // single-user mode there is no relay — save still has to go
        // through so the file lands on viewer storage.
        if (!singleUserMode && !connected) return;
        // The prewarm blank is read-only by design. Saves attempted
        // against __prewarm_blank.docx silently no-op here so we don't
        // make a pointless fetch/upload round-trip (the viewer-server
        // will reject the POST with 403 anyway). If the user wants to
        // persist, they need to Save As under a new filename — that
        // flow re-instantiates with a fresh WOPISrc.
        //
        // Use the MODULE-SCOPE `wopiSrc` (updated by RelaySwitchRoom on
        // hot-switch from prewarm to user doc), NOT params.get(). The
        // URL param is the cool.html-load-time WOPISrc, which is
        // __prewarm_blank.docx for the prewarm path; if we read that
        // here, every save in the user-doc room takes the early return
        // and 0x07 is never sent — late joiners see the pre-save
        // checkpoint forever.
        if (wopiSrc === '__prewarm_blank.docx') {
            console.log('[relay] Save suppressed on prewarm blank — use Save As');
            return;
        }
        sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        // Short delay for Kit to process the save — 1.5s is enough for
        // small docs. Previous 5s delay caused late joiners to miss
        // checkpoints when they connected during the delay window.
        setTimeout(function() {
            var saveAtSeq = lastSeq;
            // Module-scope wopiSrc — see prewarm-blank guard above for
            // why we DON'T re-read params.get('WOPISrc') here.
            // 1. Download saved file from editor's temp storage
            var editorFileUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
            origFetch(editorFileUrl).then(function(r) {
                return r.arrayBuffer();
            }).then(function(buf) {
                var bytes = new Uint8Array(buf);

                // Guard: if the saved file is a tiny blank doc (<15KB) but
                // we're editing a real document, the checkpoint captured the
                // prewarm blank — don't overwrite the original on the viewer.
                if (bytes.length < 15000 && window.__lastUploadedFileSize && window.__lastUploadedFileSize > 50000) {
                    console.log('[relay] Checkpoint skip: saved ' + bytes.length + 'B but original was ' +
                                window.__lastUploadedFileSize + 'B — refusing to overwrite with blank');
                    return Promise.resolve();
                }

                // 2. Compute the full SHA-256 hex of the document.
                return crypto.subtle.digest('SHA-256', bytes).then(function(hashBuf) {
                    var hashArr = new Uint8Array(hashBuf);
                    var hashHex = Array.from(hashArr).map(function(b) {
                        return b.toString(16).padStart(2, '0');
                    }).join('');
                    // Branch on v2 vs legacy. V2 files (opaque 64-hex
                    // fileId) have their encryption key living ONLY in
                    // the parent viewer's memory — the editor must NOT
                    // know about it. Send plaintext to the parent via
                    // postMessage; the viewer encrypts with the
                    // content key and PUTs to /api/v2/file/<fileId>,
                    // replying with the new hash + locator. Legacy
                    // files keep their /api/files/ POST path.
                    var v2Match = /^[0-9a-f]{64}$/i.test(wopiSrc);
                    var viewerFileUrl = getFileStorageUrl(wopiSrc);

                    var savePromise;
                    if (v2Match) {
                        savePromise = saveViaParent(wopiSrc, bytes, hashHex);
                    } else {
                        // Legacy plaintext POST (used by tests that
                        // bypass the viewer or files uploaded before v2).
                        var uploadHeaders = {};
                        if (lastKnownHash) uploadHeaders['X-Expected-Hash'] = lastKnownHash;
                        if (forceNextSave) {
                            uploadHeaders['X-Force-Overwrite'] = 'true';
                            forceNextSave = false;
                        }
                        savePromise = encryptFileBytes(bytes).then(function(uploadBytes) {
                            return origFetch(viewerFileUrl, {
                                method: 'POST',
                                body: new Blob([uploadBytes]),
                                mode: 'cors',
                                headers: uploadHeaders,
                            });
                        }).then(function(uploadResp) {
                            if (uploadResp.status === 409) {
                                return uploadResp.json().then(function(conflict) {
                                    console.log('[relay] Save conflict! expected=' +
                                        (conflict.expectedHash || '').substring(0, 16) + '…');
                                    try {
                                        parent.postMessage(JSON.stringify({
                                            MessageId: 'SaveConflict',
                                            Values: conflict,
                                        }), '*');
                                    } catch(e) {}
                                    return { conflict: true };
                                });
                            }
                            return uploadResp.json().then(function(r) {
                                return { hash: r.hash || hashHex, locator: viewerFileUrl };
                            });
                        });
                    }

                    return savePromise.then(function(saveResult) {
                        if (!saveResult || saveResult.conflict) return;
                        if (saveResult.error) {
                            console.error('[relay] Save failed: ' + saveResult.error);
                            return;
                        }
                        var prevHash = lastKnownHash;
                        lastKnownHash = saveResult.hash;
                        // Checkpoint invariant: only rotate when the saved bytes
                        // actually ADVANCED past the current checkpoint. If the
                        // save produced byte-identical output (same hash), the
                        // on-disk file did NOT capture whatever is live in the
                        // model — e.g. a spell-correction or a language change
                        // applied via the context menu, which LO does not always
                        // re-serialize on .uno:Save once the word is deselected
                        // (the doc reads back "unmodified", so saveToServer POSTs
                        // the unchanged original). Rotating here would prune the
                        // messageLog to saveAtSeq and DROP those edits for future
                        // late-joiners, who would then permanently diverge from
                        // the live peers (reproduced: corrector 447 vs joiner 446).
                        // Skip the rotation so those edits stay replayable from
                        // the log until a save genuinely persists them.
                        if (prevHash && saveResult.hash === prevHash) {
                            console.log('[relay] Save produced unchanged bytes (hash=' +
                                (saveResult.hash || '').substring(0, 16) +
                                '…) — skipping checkpoint rotation so unpersisted live edits ' +
                                'stay in the replay log (late-joiners would otherwise diverge)');
                            try {
                                parent.postMessage(JSON.stringify({
                                    MessageId: 'SaveComplete',
                                    Values: { hash: (saveResult.hash || '').substring(0, 16), bytes: bytes.length, rotated: false },
                                }), '*');
                            } catch(e) {}
                            return;
                        }
                        // Rotate the relay checkpoint. Relay prunes
                        // messageLog to seq > saveAtSeq so future late
                        // joiners land on the new baseline.
                        var payload = {
                            hash: saveResult.hash,
                            locator: saveResult.locator,
                            seq: saveAtSeq,
                        };
                        if (ws && connected) {
                            var bodyBytes = new TextEncoder().encode(JSON.stringify(payload));
                            var frame = new Uint8Array(5 + bodyBytes.length);
                            frame[0] = 0x07;
                            frame[1] = (myViewId >>> 24) & 0xFF;
                            frame[2] = (myViewId >>> 16) & 0xFF;
                            frame[3] = (myViewId >>> 8) & 0xFF;
                            frame[4] = myViewId & 0xFF;
                            frame.set(bodyBytes, 5);
                            ws.send(frame);
                            console.log('[relay] Save-rotation 0x07 sent: hash=' + saveResult.hash.substring(0, 16) +
                                '… locator=' + saveResult.locator + ' atSeq=' + saveAtSeq);
                        }
                        try {
                            parent.postMessage(JSON.stringify({
                                MessageId: 'SaveComplete',
                                Values: { hash: saveResult.hash.substring(0, 16), bytes: bytes.length },
                            }), '*');
                        } catch(e) {}
                    });
                });
            }).catch(function(e) {
                console.error('[relay] Checkpoint failed: ' + e.message);
            });
        }, 1500);
    }

    // Build editor-origin URLs for the /api/files/, /api/blobs/, and
    // /api/v2/file/ paths. These are intercepted by sw-bridge.js
    // (scope /) on the editor origin and routed via postMessage to the
    // parent (viewer) — the viewer responds with bytes from its own
    // same-origin storage. We never cross origins on the network.
    //
    // Pre-SW-bridge this used a resolveFileStorageBase() helper that
    // probed `?fileStorageUrl`, `window.parent.location.origin`, and
    // `document.referrer` to find the viewer's origin. That dance is
    // gone — `window.location.origin` (the editor) is enough; the SW
    // handles the rest.
    function getFileStorageUrl(wopiSrc) {
        return window.location.origin + '/api/files/' + encodeURIComponent(wopiSrc);
    }

    function getBlobUrl(hash) {
        if (!hash) return null;
        return window.location.origin + '/api/blobs/' + encodeURIComponent(hash);
    }

    // --- Process a sequenced UI message ---
    var _kitMessageQueue = []; // messages waiting for WASM runtime
    function processUIMessage(msg, seq) {
        lastSeq = seq;

        var text = new TextDecoder().decode(msg.payload.slice(4)); // Skip seq bytes
        var vid = msg.viewId;

        if (text === 'HULLO' || text === 'BYE' || text.startsWith('tileprocessed ')) return;

        // Queue until C++ server socket is ready (is_preinit_done returns 1)
        var serverUp = coolwsdReady && Module && Module.calledRun && Module._is_preinit_done && Module._is_preinit_done();
        if (!serverUp) {
            _kitMessageQueue.push({ msg: msg, seq: seq });
            return;
        }

        // Presence: trigger remote client creation
        if (text.startsWith('presence ')) {
            if (vid !== myViewId) {
                // Parse name from "presence viewId=X name=Foo"
                var nameMatch = text.match(/name=(\S+)/);
                var remoteName = nameMatch ? nameMatch[1] : 'User-' + vid;
                if (!remoteClients[vid]) {
                    createRemoteClient(vid);
                }
                remoteClients[vid].name = remoteName;
                // Inject into COOL's view info so cursor label shows the name
                try {
                    if (window.app && window.app.map && window.app.map._viewInfo) {
                        if (!window.app.map._viewInfo[vid]) {
                            window.app.map._viewInfo[vid] = {};
                        }
                        window.app.map._viewInfo[vid].username = remoteName;
                    }
                } catch(e) {}
            }
            return;
        }

        // pasteb64 is no longer sent (paste blobs are now converted to
        // insertfile or textinput before relaying). Keep the handler as a
        // no-op for backward compat with any in-flight messages.
        if (text.startsWith('pasteb64 ')) return;

        // Keep the receive-side filter in sync with interceptedSend above
        // — see the long comment there for which prefixes mutate the doc
        // and which are intentionally per-user.
        var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
            text.startsWith('textinput ') || text.startsWith('windowkey ') ||
            text.startsWith('uno ') ||
            text.startsWith('removetextcontext ') ||
            text.startsWith('removetextcontent ') ||
            text.startsWith('contentcontrolevent ') ||
            text.startsWith('moveselectedclientparts ') ||
            text.startsWith('completefunction ') ||
            text.startsWith('selecttext ') ||
            text.startsWith('insertfile ') ||
            text.startsWith('paste mimetype=') ||
            text === 'resetselection';
        if (!isUserInput) return;

        if (text.startsWith('uno ')) {
            console.log('[relay] UNO via relay: vid=' + vid + ' myVid=' + myViewId +
                        ' isSelf=' + (vid === myViewId) + ' cmd=' + text.substring(0, 60));
        }

        // Log relay-routed messages for debugging
        if (text.startsWith('key ') && text.includes('char=')) {
            console.log('[relay] processUI: vid=' + vid + ' myVid=' + myViewId + ' isSelf=' + (vid===myViewId) + ' ' + text.substring(0, 50));
        }

        // Own viewId → local Kit session (own cursor).
        // During late-join REPLAY (messages from the buffer that predate
        // our activation), ALL messages go to local Kit regardless of
        // viewId. The replay messages include edits from peers who may
        // have disconnected — routing them to a remote-client Kit would
        // leave the local doc stale. After replay is done (seq catches
        // up to current), normal routing kicks in: own vid → local,
        // other vid → remote client.
        if (vid === myViewId || replayMode) {
            if (replayMode && vid !== myViewId) {
                console.log('[relay] Replay vid=' + vid + ' seq=' + seq + ' → local Kit: ' + text.substring(0, 50));
            }
            if (text.startsWith('textinput ')) {
                var match = text.match(/text=(.+)/);
                if (match) {
                    var chars = decodeURIComponent(match[1]);
                    for (var ci = 0; ci < chars.length; ci++) {
                        var charCode = chars.charCodeAt(ci);
                        sendToKit('key type=input char=' + charCode + ' key=0');
                        sendToKit('key type=up char=0 key=0');
                    }
                }
            } else {
                sendToKit(text);
            }
            return;
        }

        // Other viewId → remote client session (their cursor)
        if (!remoteClients[vid]) {
            createRemoteClient(vid);
        }
        var rc = remoteClients[vid];
        if (!rc.ready) {
            rc.queue.push(text);
            return;
        }
        try {
            sendToRemoteClient(rc.clientId, text);
        } catch(e) {
            console.error('[relay] Remote send failed: ' + e.message);
        }
    }

    // --- Process relay message ---
    function processRelayMessage(msg) {
        // 0x0A: Checkpoint mismatch — relay rejected our hash, must re-download
        if (msg.type === 0x0A) {
            try {
                var mismatch = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('[relay] CHECKPOINT MISMATCH: expected=' + mismatch.expected + ' — will re-download');
                // The relay will send a new 0x05 with the correct checkpoint
                // Reset state so we re-process it
                activated = false;
                lateJoinFileReady = false;
            } catch(e) {}
            return;
        }

        // 0x05: Join-response
        if (msg.type === 0x05) {
            if (msg.payload.length > 0) {
                try {
                    var info = JSON.parse(new TextDecoder().decode(msg.payload));
                    if (info.first) {
                        // First client — no file to download. Mark
                        // lateJoinFileReady anyway so that if coolwsd
                        // isn't ready yet, the activation-poll can
                        // still fire activateClient() once it is.
                        // Without this the first-client path stalled
                        // after a room switch: the old activation poll
                        // self-cleared, the new one started waiting on
                        // a lateJoinFileReady signal that never comes
                        // (there's no file to late-join-download), and
                        // the user ended up in a ghost room where own
                        // edits worked but peer messages never arrived.
                        isFirstClient = true;
                        joinFileSeq = 0;
                        lateJoinFileReady = true;
                        console.log('[relay] First client in room');
                        if (coolwsdReady) activateClient();
                        return;
                    }

                    // Late joiner — download the checkpoint by HASH from
                    // the content-addressable blob endpoint. The relay
                    // promised this hash; the blob endpoint returns
                    // exactly those bytes; the SHA-256 we compute will
                    // match — no chance of drift, no 0x0A re-download
                    // dance, no stale-hash deadlock.
                    //
                    // Falls back to /api/files/<name> + /wasm/<name> if
                    // the blob endpoint is unavailable (older deploys).
                    joinFileSeq = info.seq;
                    var wopiSrc = params.get('WOPISrc') || '';
                    var editorWopiUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
                    console.log('[relay] Join-response: hash=' + (info.hash||'').substring(0, 16) +
                                '… locator=' + (info.locator || '(none)') + ' seq=' + info.seq +
                                ' cursors=' + (info.cursorCount || 0) + ' msgs=' + (info.msgCount || 0));
                    try { parent.postMessage(JSON.stringify({
                        MessageId: 'RelayLateJoinPhase',
                        Values: { phase: 'downloading', msgCount: info.msgCount || 0, seq: info.seq }
                    }), '*'); } catch(e) {}

                    // Content-viewer co-edit late-join: the joiner's page
                    // already fetched the shared bytes (/shared-file/<room>)
                    // into its SW BEFORE opening this iframe, and preRun
                    // wrote them into the FS — the doc is loading from the
                    // exact bytes the room was seeded with. No download, no
                    // POST to /wasm/ (there is none), and NO switchdocument
                    // (_pendingSwitchDoc stays null so the activation poll
                    // proceeds on coolwsdReady). Just verify our bytes match
                    // the room checkpoint and mark the join file ready; the
                    // 0x06/replay flow then brings us current. The CV save
                    // path never rotates the relay checkpoint (see
                    // saveAndUploadCheckpoint's isContentViewer guard), so
                    // the checkpoint hash is immutably the seed bytes' hash
                    // — a mismatch means the page staged DIFFERENT bytes
                    // (join link misuse), which is terminal, not retryable.
                    if (isContentViewer) {
                        origFetch('/local-file/' + encodeURIComponent(cvLocalFileId))
                            .then(function(r) {
                                if (!r.ok) throw new Error('local-file HTTP ' + r.status);
                                return r.arrayBuffer();
                            })
                            .then(function(buf) { return crypto.subtle.digest('SHA-256', buf); })
                            .then(function(hashBuf) {
                                joinFileHash = Array.from(new Uint8Array(hashBuf)).map(function(b) {
                                    return b.toString(16).padStart(2, '0');
                                }).join('');
                                if (info.hash && info.hash !== joinFileHash) {
                                    throw new Error('cv-checkpoint-mismatch: ours=' +
                                        joinFileHash.substring(0, 16) + '… room=' +
                                        info.hash.substring(0, 16) + '…');
                                }
                                lateJoinFileReady = true;
                                console.log('[relay] CV late-join: local bytes match room checkpoint (' +
                                            joinFileHash.substring(0, 16) + '…) — replay only');
                            })
                            .catch(function(e) {
                                console.error('[relay] CV late-join verify FAILED: ' + e.message);
                                try { parent.postMessage(JSON.stringify({
                                    MessageId: 'RelayLateJoinFailed',
                                    Values: { error: e.message }
                                }), '*'); } catch(_e) {}
                            });
                        return;
                    }

                    // Primary: the checkpoint's `locator`. For v2 files
                    // the locator is /api/v2/file/<fileId> which serves
                    // ciphertext — the adapter can't decrypt it (content
                    // key lives in the parent viewer only), so ship that
                    // fetch through the parent via postMessage and let
                    // the viewer return plaintext bytes. For non-v2
                    // locators, fetch directly. Fallback in either case:
                    // the editor's own /wasm/<wopiSrc> where the viewer
                    // POSTed plaintext before spawning us.
                    var v2Re = /\/api\/v2\/file\/([0-9a-f]{64})/i;
                    var v2Match = info.locator && info.locator.match(v2Re);
                    var sources = [];
                    if (info.locator) {
                        sources.push({
                            kind: v2Match ? 'v2-via-parent' : 'locator',
                            url: info.locator,
                            v2FileId: v2Match ? v2Match[1] : null,
                        });
                    }
                    if (!info.locator || info.locator !== editorWopiUrl) {
                        sources.push({ kind: 'editor-wasm', url: editorWopiUrl });
                    }

                    function fetchViaParent(fileId) {
                        return new Promise(function(resolve, reject) {
                            var reqId = 'fetch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                            var timeoutId = setTimeout(function() {
                                window.removeEventListener('message', onMsg);
                                reject(new Error('parent-fetch-timeout'));
                            }, 30000);
                            function onMsg(ev) {
                                var m; try { m = JSON.parse(ev.data); } catch(e) { return; }
                                if (!m || m.MessageId !== 'WasmFileLoadResult') return;
                                if (!m.Values || m.Values.reqId !== reqId) return;
                                clearTimeout(timeoutId);
                                window.removeEventListener('message', onMsg);
                                if (!m.Values.ok) return reject(new Error(m.Values.error || 'parent-fetch-failed'));
                                try {
                                    var b64 = m.Values.bytes;
                                    var bin = atob(b64);
                                    var arr = new Uint8Array(bin.length);
                                    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                                    resolve(arr.buffer);
                                } catch(e) { reject(e); }
                            }
                            window.addEventListener('message', onMsg);
                            parent.postMessage(JSON.stringify({
                                MessageId: 'WasmFileLoad',
                                Values: { fileId: fileId, reqId: reqId }
                            }), '*');
                        });
                    }

                    function tryNext(idx) {
                        if (idx >= sources.length) {
                            return Promise.reject(new Error('all sources exhausted'));
                        }
                        var s = sources[idx];
                        var p;
                        if (s.kind === 'v2-via-parent') {
                            p = fetchViaParent(s.v2FileId);
                        } else {
                            var opts = s.kind === 'editor-wasm' ? {} : { mode: 'cors' };
                            // Bound the fetch. A stalled network request (seen on
                            // Azure cold-loads) would otherwise never resolve OR
                            // reject, hanging the whole late-join chain forever —
                            // surfacing to the user as "Activation pending: waiting
                            // for checkpoint download" growing without bound. Abort
                            // at 30s (matches fetchViaParent) so the stall becomes a
                            // rejection that the retry wrapper below can recover from.
                            var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
                            if (ctl) opts = Object.assign({}, opts, { signal: ctl.signal });
                            var toId = ctl ? setTimeout(function(){ ctl.abort(); }, 30000) : null;
                            p = origFetch(s.url, opts).then(function(r) {
                                if (toId) clearTimeout(toId);
                                if (!r.ok) throw new Error(s.kind + ' ' + r.status);
                                return r.arrayBuffer();
                            }, function(err) {
                                if (toId) clearTimeout(toId);
                                throw err;
                            });
                        }
                        return p.catch(function(e) {
                            if (e.message === 'all sources exhausted') throw e;
                            console.log('[relay] Source "' + s.kind + '" failed (' + e.message + '), trying next');
                            return tryNext(idx + 1);
                        });
                    }
                    // The relay ADVERTISED this checkpoint (hash + locator), so
                    // the bytes exist — a failed/aborted fetch is almost always a
                    // transient network stall, not a permanent miss. Retry the
                    // whole source list a few times with exponential backoff before
                    // giving up, instead of leaving the joiner stuck forever on
                    // "waiting for checkpoint download". lateJoinFileReady guards
                    // against retrying after a success already landed.
                    var _DL_MAX = 4;
                    function fetchCheckpointWithRetry(attempt) {
                        return tryNext(0).catch(function(e) {
                            if (lateJoinFileReady || attempt >= _DL_MAX) throw e;
                            var backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
                            console.log('[relay] Checkpoint fetch failed (attempt ' + attempt +
                                        '/' + _DL_MAX + '): ' + e.message + ' — retrying in ' + backoff + 'ms');
                            return new Promise(function(res) { setTimeout(res, backoff); })
                                .then(function() { return fetchCheckpointWithRetry(attempt + 1); });
                        });
                    }
                    fetchCheckpointWithRetry(1).then(function(buf) {
                        // Decrypt if encrypted (legacy E2E relay encryption)
                        return decryptFileBytes(new Uint8Array(buf)).then(function(dec) {
                            return dec.buffer || dec;
                        });
                    }).then(function(buf) {
                        var bytes = new Uint8Array(buf);
                        return crypto.subtle.digest('SHA-256', bytes).then(function(hashBuf) {
                            joinFileHash = Array.from(new Uint8Array(hashBuf)).map(function(b) {
                                return b.toString(16).padStart(2, '0');
                            }).join('');
                            // STRICT verify: if the relay advertised a
                            // hash, the downloaded bytes MUST match. A
                            // mismatch means the locator points at a
                            // different version than what the relay
                            // expects — don't activate on drifted bytes.
                            // Send 0x06 with our hash so the relay's
                            // 0x0A redirect logic kicks in; DON'T write
                            // these bytes to /wasm/<wopiSrc>.
                            if (info.hash && info.hash !== joinFileHash) {
                                // The bytes at the advertised locator hash to a different
                                // value than what the relay's room-checkpoint expects.
                                // This commonly happens with v2 shared links: a previous
                                // editor registered checkpointHash X; the file was then
                                // updated to Y; new joiners fetch Y from authoritative
                                // storage and the relay still has X.
                                //
                                // Previously the code threw 'hash-mismatch' here and the
                                // doc never opened (reproduced via
                                // /#file=tkPa0z9L83UyllHVpHIZhw — relay said cbd00c30…
                                // but storage served 2a71db53…).
                                //
                                // The relay's 0x0A redirect (message-relay.js:841) only
                                // helps when there's a *different* locator with the
                                // expected bytes — not the case for v2 where there is
                                // exactly one authoritative copy per fileId.
                                //
                                // Best-effort recovery: trust authoritative storage,
                                // proceed with the bytes we got. Send 0x06 with our
                                // hash so the relay can update its checkpoint (or, if
                                // a different locator exists, redirect us — the 0x0A
                                // handler below resets state and we'll re-download).
                                console.warn('[relay] HASH MISMATCH: ours=' + joinFileHash.substring(0, 16) +
                                    '… relay-expected=' + info.hash.substring(0, 16) +
                                    '… — proceeding with authoritative bytes; sending 0x06 to update relay');
                                try {
                                    sendToRelay(0x06, myViewId, JSON.stringify({ hash: joinFileHash }));
                                } catch (e) {
                                    console.error('[relay] sendToRelay(0x06) for redirect failed:', e.message);
                                }
                                // Fall through and POST the bytes to /wasm/<wopiSrc> so
                                // Kit can load the doc. If the relay sends 0x0A its
                                // handler will reset state and re-download.
                            }
                            console.log('[relay] Downloaded ' + buf.byteLength + 'B; hash=' +
                                joinFileHash.substring(0, 16) + '… ✓ matches relay');
                            lateJoinFileReady = true;
                            return origFetch(editorWopiUrl, { method: 'POST', body: new Blob([buf]) });
                        });
                    }).then(function() {
                        try { parent.postMessage(JSON.stringify({
                            MessageId: 'RelayLateJoinPhase',
                            Values: { phase: 'loading' }
                        }), '*'); } catch(e) {}
                        // Step A (2026-06-14, fix-second-init-race): route the
                        // late-join's real doc onto the EXISTING (prewarm) kit via
                        // switchdocument, instead of letting COOLWSD do a fresh
                        // `load url=<fileId>` of a NEW docKey — which spawns a 2nd
                        // DocumentBroker → 2nd lokit_main → two LO main loops in one
                        // process → "memory access out of bounds" on every late-join.
                        // switchdocument reuses the single kit/loKit
                        // (wasm_reload_doc_in_place), exactly like a cold same-type
                        // open. Setting the hash drives the proven checkHashSwitch →
                        // trySendSwitch path in wasm-loader.js (gated there on
                        // __wasmInitialDocLoaded + postMobileMessage). We require an
                        // QUEUE the switch unconditionally: set #switchdoc so
                        // wasm-loader's checkHashSwitch records pendingSwitchFilename,
                        // and its trySendSwitch retry-poll (every 300ms) FIRES it the
                        // moment the initial/prewarm doc finishes loading
                        // (__wasmInitialDocLoaded). The 0x05 join-response commonly
                        // arrives BEFORE the editor's initial doc is ready (~46s vs
                        // ~40-50s prewarm), so a one-shot check raced and fell through
                        // to the legacy COOLWSD load (the 2nd-broker crash path). The
                        // queue+retry is gated kit-side so the switch is never sent as
                        // the first socket message (which would be a new docKey).
                        try {
                            // Stale-switchdoc gate (fix-hotswitch-switchdoc-storm,
                            // 2026-06-15): only queue if THIS 0x05's target is still the
                            // current room. On a rapid hot-switch (A→B→A) several 0x05
                            // chains race and a late one would otherwise queue a stale
                            // switchdoc (e.g. B) that overrides the intended A — the kit
                            // then loads the wrong doc. `wopiSrc` here is this 0x05's local
                            // target (line ~1400); `currentRoomDoc` is the latest
                            // RelaySwitchRoom target. For a genuine cold-reload late-join
                            // (no RelaySwitchRoom) they're equal, so #230's late-join path
                            // is unchanged.
                            if (wopiSrc && wopiSrc === currentRoomDoc) {
                                // Remember we queued a switch so the activation
                                // poll holds replay until this doc is loaded.
                                // Reset the kit-set flag so it reflects THIS
                                // switch's completion, not any prior switch.
                                _pendingSwitchDoc = wopiSrc;
                                window.__wasmSwitchDocLoaded = false;
                                window.location.hash = '#switchdoc=' + encodeURIComponent(wopiSrc);
                                console.log('[relay] late-join → queued switchdocument on existing kit (single LO main loop): ' + wopiSrc);
                            } else {
                                console.log('[relay] skip stale switchdoc (join=' + wopiSrc + ' currentRoom=' + currentRoomDoc + ')');
                            }
                        } catch (e) {
                            console.error('[relay] switchdoc trigger failed: ' + e.message);
                        }
                    }).catch(function(e) {
                        console.error('[relay] Late-join file sync FAILED after ' + _DL_MAX +
                                      ' attempts: ' + e.message);
                        // Surface a terminal failure to the parent viewer so it can
                        // show a real error / offer a reload instead of leaving the
                        // user staring at an ever-growing "Joining session…" that
                        // never resolves (the reported checkpoint-download hang).
                        try { parent.postMessage(JSON.stringify({
                            MessageId: 'RelayLateJoinFailed',
                            Values: { error: e.message }
                        }), '*'); } catch(_e) {}
                    });
                } catch(e) {
                    console.log('[relay] Join-response parse error: ' + e.message);
                }
            }
            return;
        }

        // 0x02: Client joined — also marks end of replay
        if (msg.type === 0x02) {
            try {
                var joinInfo = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('[relay] Client joined: viewId=' + joinInfo.viewId + ' seq=' + joinInfo.seq);
                // If this is OUR join announcement, replay is done — BUT
                // only after any queued-for-kit replay frames have been
                // drained. _kitMessageQueue holds 0x00 frames that arrived
                // before Kit was ready; if we flip replayMode here while
                // those are still pending, their later processUIMessage
                // run sees replayMode=false and ships them to a remote
                // client, leaving the local doc stuck on the pre-join
                // baseline. Defer the flip until the queue is empty.
                if (joinInfo.viewId === myViewId && replayMode) {
                    var flipStart = Date.now();
                    (function flipWhenDrained() {
                        if (_kitMessageQueue.length === 0 || Date.now() - flipStart > 30000) {
                            replayMode = false;
                            console.log('[relay] Replay mode OFF — ' + lastSeq +
                                ' messages applied to local Kit (queue=' + _kitMessageQueue.length + ')');
                        } else {
                            setTimeout(flipWhenDrained, 100);
                        }
                    })();
                }
                if (joinInfo.viewId !== myViewId && !remoteClients[joinInfo.viewId]) {
                    createRemoteClient(joinInfo.viewId);
                }
            } catch(e) {}
            return;
        }

        // 0x03: Client left
        if (msg.type === 0x03) {
            try {
                var leaveInfo = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('[relay] Client left: viewId=' + leaveInfo.viewId);
            } catch(e) {}
            return;
        }

        // 0x00: UI message (with seq#)
        // Relay format: [0x00][viewId:4][seq:4][payload...]
        // With encryption: [0x00][viewId:4][seq:4][keyVer:4][nonce:12][ct...]
        if (msg.type === 0x00 && msg.payload.length >= 4) {
            var seq = ((msg.payload[0] << 24) | (msg.payload[1] << 16) |
                       (msg.payload[2] << 8) | msg.payload[3]) >>> 0;
            // Check if the payload after seq looks encrypted:
            // [seq:4][keyVer:4][nonce:12][ct...] — keyVer is a recent hourly
            // counter (>1000), so the first byte after seq will be 0x00 0x00.
            // Plaintext messages start with ASCII (byte > 0x20).
            var afterSeq = msg.payload.length > 8 ? msg.payload[4] : 0xFF;
            var looksEncrypted = encryptionEnabled && msg.payload.length > 4 + 16 + 16 && afterSeq === 0;
            if (looksEncrypted) {
                // Decrypt the portion after the seq bytes
                var encPart = msg.payload.subarray(4);
                decryptPayload(encPart).then(function(pt) {
                    // Rebuild payload: [seq:4][decrypted text]
                    var rebuilt = new Uint8Array(4 + pt.length);
                    rebuilt.set(msg.payload.subarray(0, 4)); // seq
                    rebuilt.set(pt, 4);
                    msg.payload = rebuilt;
                    processUIMessage(msg, seq);
                }).catch(function() {
                    // Decryption failed — message was likely sent before
                    // encryption was enabled (e.g., presence announcement).
                    // Process as plaintext.
                    processUIMessage(msg, seq);
                });
                return;
            }
            processUIMessage(msg, seq);
            return;
        }
    }

    // --- WebSocket handlers (named for reuse during room switch) ---
    function onWsMessage(event) {
        var msg = parseFrame(event.data);
        if (!msg) return;

        if (msg.type === 0x05 || msg.type === 0x0A) {
            processRelayMessage(msg);
            return;
        }

        if (!coolwsdReady) {
            recvQueue.push(msg);
            return;
        }

        processRelayMessage(msg);
    }

    function onWsOpen() {
        connected = true;
        console.log('[relay] Connected');
        for (var i = 0; i < sendQueue.length; i++) ws.send(sendQueue[i]);
        sendQueue = [];
        initiateJoin();
    }

    if (ws) {
        ws.onmessage = onWsMessage;
        ws.onopen = onWsOpen;
        ws.onerror = function(err) { console.error('[relay] WebSocket error', err); };
        ws.onclose = function() { connected = false; console.log('[relay] Disconnected'); };
    }

    // --- Activation when COOLWSD is ready (for late joiners) ---
    // Late joiners: wait for both COOLWSD ready AND file downloaded.
    // This needs to be restartable for room switches: after switching to
    // a new room, the previous activation poll has already cleared itself.
    var activationPollInterval = null;
    function startActivationPoll() {
        if (activationPollInterval) clearInterval(activationPollInterval);
        var pollStart = Date.now();
        var switchWaitStart = 0;
        var lastReportedReason = '';
        activationPollInterval = setInterval(function() {
            if (activated) { clearInterval(activationPollInterval); activationPollInterval = null; return; }
            var baseReady = coolwsdReady && lateJoinFileReady;
            if (baseReady && !switchWaitStart) switchWaitStart = Date.now();
            // If this join queued a switchdocument, hold replay until the REAL
            // checkpoint doc has loaded — otherwise the replayed messages apply
            // to the prewarm blank and switchdocument then discards them, so the
            // joiner silently loses every unsaved edit (reproduced: joiner ends
            // on the bare base doc). The kit sets __wasmSwitchDocLoaded=true at
            // the exact switchdocument-complete point (ChildSession.cpp); we
            // reset it to false when we queue this join's switch, so the flag
            // reflects THIS switch, not a stale prior one.
            var switchDone = !_pendingSwitchDoc || window.__wasmSwitchDocLoaded === true;
            // Bounded fallback: never hang activation if the switch is broken
            // (hot-switch watchdog territory) — after SWITCH_WAIT_CAP proceed
            // anyway, degrading to the previous (lossy but non-hanging) path.
            var switchCapped = switchWaitStart && (Date.now() - switchWaitStart > SWITCH_WAIT_CAP);
            if (baseReady && (switchDone || switchCapped) && !activated) {
                if (!switchDone && switchCapped)
                    console.warn('[relay] switchdoc-complete wait timed out after ' + (SWITCH_WAIT_CAP / 1000) +
                                 's — activating anyway (replayed edits may be lost)');
                activateClient();
                clearInterval(activationPollInterval);
                activationPollInterval = null;
                return;
            }
            // Report what we're still waiting on so a stuck activation is
            // diagnosable from the console (and so the parent viewer can
            // surface "Joining session…" instead of looking frozen).
            var waiting = !coolwsdReady ? 'editor' : (!lateJoinFileReady ? 'checkpoint download' : 'switchdoc');
            var elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
            if (waiting !== lastReportedReason || (elapsed % 5 === 0 && elapsed > 0)) {
                lastReportedReason = waiting;
                console.log('[relay] Activation pending: waiting for ' + waiting + ' (' + elapsed + 's)');
                try {
                    parent.postMessage(JSON.stringify({
                        MessageId: 'RelayActivating',
                        Values: { waitingFor: waiting, elapsedSec: parseInt(elapsed, 10) }
                    }), '*');
                } catch(e) {}
            }
        }, 500);
    }
    // In single-user mode, skip the relay handshake. Fetch the initial
    // file hash from viewer storage so conflict detection works, and mark
    // the late-join file as ready (there is no late-join).
    if (singleUserMode) {
        lateJoinFileReady = true;
        isFirstClient = true;
        var fileStorageUrl = getFileStorageUrl(wopiSrc);
        if (fileStorageUrl) {
            origFetch(fileStorageUrl, { method: 'HEAD', mode: 'cors' })
                .then(function(resp) {
                    var h = resp.headers.get('X-Content-Hash');
                    if (h) {
                        joinFileHash = h;
                        lastKnownHash = h;
                        console.log('[relay] Single-user initial hash: ' + h.substring(0, 16) + '…');
                    }
                }).catch(function() {});
        }
    }

    startActivationPoll();
})();
