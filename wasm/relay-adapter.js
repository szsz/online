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
            return new Promise(function(resolve) { _pendingKeyReqs[keyVersion].push(resolve); });
        }
        _pendingKeyReqs[keyVersion] = [];
        return new Promise(function(resolve) {
            _pendingKeyReqs[keyVersion].push(resolve);
            try {
                parent.postMessage(JSON.stringify({
                    MessageId: 'KeyRequest',
                    Values: { fileId: wopiSrc, keyVersion: keyVersion }
                }), '*');
            } catch(e) { console.error('[relay] KeyRequest postMessage failed:', e); }
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
            lateJoinFileReady = false;
            // Keep remoteClients — they'll be cleaned up when new room announces joins
            for (var vid in remoteClients) {
                if (remoteClients[vid].clientId > 0) {
                    try { Module._close_remote_client(remoteClients[vid].clientId); } catch(e) {}
                }
            }
            remoteClients = {};

            // Connect to new room
            relayUrl = newRoom;
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

        // Writer: StateWordCount has "word"
        var statusEl = document.querySelector('#StateWordCount');
        var writerReady = statusEl && statusEl.textContent && statusEl.textContent.includes('word');
        // Calc: StatusDocPos has "Sheet"
        var calcEl = document.querySelector('#StatusDocPos');
        var calcReady = calcEl && calcEl.textContent && calcEl.textContent.includes('Sheet');
        // Impress: any of these signals it's ready
        var impressReady = false;
        // Check for "Slide Show" in menu
        var navEl = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
        if (navEl && navEl.textContent && navEl.textContent.includes('Slide Show')) {
            impressReady = true;
        }
        // Or check for slide status (e.g., "Slide 1 of 3")
        var sbEl = document.querySelector('.jsdialog.ui-statusbar');
        if (sbEl && sbEl.textContent && sbEl.textContent.length > 3) {
            impressReady = true;
        }
        // Or check that canvas + map div exist (Impress rendering started)
        if (document.querySelector('#map') && document.querySelector('canvas')) {
            impressReady = true;
        }

        if (!writerReady && !calcReady && !impressReady) {
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
        // Set the initial known hash from the file we loaded/joined with.
        // This is used for conflict detection when saving.
        lastKnownHash = joinFileHash;
        // Send join-ready with the SHA-256 hex of the document we loaded.
        // Truncate the log preview so a 64-char hash doesn't drown the console.
        var readyPayload = joinFileHash ? JSON.stringify({ hash: joinFileHash }) : '';
        var hashPreview = joinFileHash ? joinFileHash.substring(0, 16) + '…' : 'none';
        console.log('[relay] Activating — sending join-ready hash=' + hashPreview);
        // Enter replay mode: all messages from the buffer will be routed
        // to local Kit (not remote clients) so the doc catches up.
        // Replay mode ends when we receive 0x02 (join acknowledged).
        if (!isFirstClient) {
            replayMode = true;
            console.log('[relay] Replay mode ON — buffered messages → local Kit');
        }
        try { parent.postMessage(JSON.stringify({
            MessageId: 'RelayLateJoinPhase',
            Values: { phase: 'replaying' }
        }), '*'); } catch(e) {}
        sendToRelay(0x06, myViewId, readyPayload);

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

        // Enable E2E encryption — request the current key before sending anything
        if (!singleUserMode) {
            var keyBaseUrl = getFileStorageUrl(wopiSrc);
            if (keyBaseUrl) {
                var kvUrl = keyBaseUrl.replace(/\/api\/files\/.*/, '/api/keys/current-version');
                origFetch(kvUrl, { mode: 'cors' }).then(function(r) { return r.json(); })
                    .then(function(data) {
                        currentKeyVer = data.keyVersion;
                        return fetchKey(currentKeyVer);
                    }).then(function() {
                        encryptionEnabled = true;
                        console.log('[relay] E2E encryption enabled, keyVersion=' + currentKeyVer);
                    }).catch(function(e) {
                        console.warn('[relay] Encryption key fetch failed, running unencrypted:', e.message);
                    });
            }
        }

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
                        console.log('[relay] Converting image paste → insertfile (' + msg.length + ' chars)');
                        // RELAY ONLY — local Kit gets it via the echo
                        // (processUIMessage → sendToKit). No direct delivery.
                        if (activated) sendToRelay(0x00, myViewId, msg);
                    } else if (mime.startsWith('text/html') || mime.startsWith('text/plain')) {
                        // Send the FULL paste command as a string through the
                        // relay. Kit's paste handler (ChildSession::paste)
                        // processes `paste mimetype=text/html\n<html>` and
                        // preserves formatting (bold, italic, underline, etc.).
                        // Stripping to textinput would lose all formatting.
                        var textPayload = new TextDecoder().decode(payload);
                        var pasteCmd = 'paste mimetype=' + mime + '\n' + textPayload;
                        console.log('[relay] Relaying rich paste (' + mime + ', ' + textPayload.length + ' chars)');
                        if (activated) {
                            sendToRelay(0x00, myViewId, pasteCmd);
                        }
                    } else {
                        // Unknown mimetype — try the text extraction path
                        // as a best-effort. If it has readable text, relay
                        // it as textinput. Otherwise drop (we can't relay
                        // raw binary via the text protocol).
                        console.log('[relay] Unknown paste mimetype "' + mime + '" — attempting text extraction');
                        try {
                            var unknownText = new TextDecoder().decode(payload).trim();
                            if (unknownText && activated) {
                                sendToRelay(0x00, myViewId, 'textinput id=0 text=' + unknownText);
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
                    console.log('[relay] Dropping input (not activated yet): ' + text.substring(0, 40));
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
                if (singleUserMode) {
                    // No relay — send directly to local Kit
                    originalSend(data);
                } else {
                    sendToRelay(0x00, myViewId, data);
                }

                // User-initiated save (Ctrl+S → COOL emits `uno .uno:Save`):
                // create a checkpoint and upload the saved file to storage.
                // In relay mode, only the ORIGINATOR runs this — other peers
                // receive the same uno via relay and save locally. In
                // single-user mode, we always run it since there are no peers.
                if (isUserSaveCommand(text)) {
                    console.log('[relay] User save detected (' + text.substring(0, 40) +
                                ') — scheduling checkpoint + upload');
                    saveAndUploadCheckpoint();
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
        // Guard: Module C functions not available until callMain completes
        if (!Module || !Module.calledRun || !Module._create_remote_client) {
            if (_pendingRemoteClients.indexOf(viewId) < 0) {
                _pendingRemoteClients.push(viewId);
                console.log('[relay] Queuing remote client for viewId=' + viewId + ' (WASM not ready)');
            }
            return;
        }
        console.log('[relay] Creating remote client for viewId=' + viewId);
        var clientId = Module._create_remote_client();
        remoteClients[viewId] = { clientId: clientId, ready: false, queue: [] };
        console.log('[relay] Remote client created: viewId=' + viewId + ' clientId=' + clientId);
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId + ' name=' + myName);
    }

    // --- Poll for C++ ready signals ---
    function globalPollReady() {
        if (!Module || !Module.calledRun || !Module._poll_remote_client_ready) {
            setTimeout(globalPollReady, 500);
            return;
        }
        // Flush any remote clients that were queued before runtime init
        if (_pendingRemoteClients.length > 0) {
            var pending = _pendingRemoteClients.splice(0);
            for (var i = 0; i < pending.length; i++) createRemoteClient(pending[i]);
        }
        // Flush messages that arrived before runtime was ready
        if (_kitMessageQueue.length > 0) {
            var queued = _kitMessageQueue.splice(0);
            console.log('[relay] Flushing ' + queued.length + ' queued messages (runtime now ready)');
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

    // --- Save-trigger handler ---
    function handleSaveTrigger() {
        console.log('[relay] Save-trigger received');
        saveAndUploadCheckpoint();
    }

    // True when the COOL JS layer dispatches a user-initiated save.
    // Ctrl+S, the toolbar Save button, and File→Save all funnel through
    // the same .uno:Save command. The Sidebar/Auto-save also produce
    // .uno:Save — that's still legit "user wants to persist this" intent.
    function isUserSaveCommand(text) {
        if (!text || !text.startsWith('uno ')) return false;
        var cmd = text.substring(4).split('?')[0].split(/\s/)[0];
        // Accept the bare Save plus the explicit-as variants. We do NOT
        // include FileSave (legacy alias) — COOL maps that internally.
        return cmd === '.uno:Save' || cmd === '.uno:SaveAs';
    }

    function saveAndUploadCheckpoint() {
        if (!connected) return;
        sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        // Short delay for Kit to process the save — 1.5s is enough for
        // small docs. Previous 5s delay caused late joiners to miss
        // checkpoints when they connected during the delay window.
        setTimeout(function() {
            var saveAtSeq = lastSeq;
            var wopiSrc = params.get('WOPISrc') || '';
            // 1. Download saved file from editor's temp storage
            var editorFileUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
            origFetch(editorFileUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
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
                    // 3. Upload file to FILE STORAGE SERVER (the viewer).
                    //    This is the canonical store; late-joiners read from
                    //    here. The relay only learns the hash + seq for
                    //    coordination — it never stores file bytes.
                    var viewerFileUrl = getFileStorageUrl(wopiSrc);
                    // Send the hash of the version we expect to be on storage.
                    // If someone modified the file externally, the server returns 409.
                    var uploadHeaders = {};
                    if (lastKnownHash) {
                        uploadHeaders['X-Expected-Hash'] = lastKnownHash;
                    }
                    if (forceNextSave) {
                        uploadHeaders['X-Force-Overwrite'] = 'true';
                        forceNextSave = false;
                    }
                    // Encrypt file bytes before upload if encryption is active
                    return encryptFileBytes(bytes).then(function(uploadBytes) {
                    return origFetch(viewerFileUrl, {
                        method: 'POST',
                        body: new Blob([uploadBytes]),
                        mode: 'cors',
                        headers: uploadHeaders,
                    });
                    }).then(function(uploadResp) {
                        if (uploadResp.status === 409) {
                            // Conflict: file was modified externally
                            return uploadResp.json().then(function(conflict) {
                                console.log('[relay] Save conflict! expected=' +
                                    (conflict.expectedHash || '').substring(0, 16) +
                                    '… current=' + (conflict.currentHash || '').substring(0, 16) + '…');
                                try {
                                    parent.postMessage(JSON.stringify({
                                        MessageId: 'SaveConflict',
                                        Values: {
                                            expectedHash: conflict.expectedHash,
                                            currentHash: conflict.currentHash,
                                            updatedAt: conflict.updatedAt,
                                        }
                                    }), '*');
                                } catch(e) {}
                                // DON'T update lastKnownHash, DON'T send 0x07 to relay
                            });
                        }
                        return uploadResp.json().then(function(result) {
                            // Success: update our known hash to the new version
                            lastKnownHash = result.hash || hashHex;
                            // 4. Report to relay. Frame layout:
                            //      [0]   type (0x07)
                            //      [1-4] viewId (uint32 BE)
                            //      [5-8] saveAtSeq (uint32 BE)
                            //      [9..] hash hex string (UTF-8, 64 ASCII chars)
                            var hashBytes = new TextEncoder().encode(hashHex);
                            var frame = new Uint8Array(5 + 4 + hashBytes.length);
                            frame[0] = 0x07;
                            frame[1] = (myViewId >>> 24) & 0xFF;
                            frame[2] = (myViewId >>> 16) & 0xFF;
                            frame[3] = (myViewId >>> 8) & 0xFF;
                            frame[4] = myViewId & 0xFF;
                            frame[5] = (saveAtSeq >>> 24) & 0xFF;
                            frame[6] = (saveAtSeq >>> 16) & 0xFF;
                            frame[7] = (saveAtSeq >>> 8) & 0xFF;
                            frame[8] = saveAtSeq & 0xFF;
                            frame.set(hashBytes, 9);
                            if (ws && connected) ws.send(frame);
                            console.log('[relay] Checkpoint: file=' + bytes.length + 'B → /api/files; ' +
                                        'sent hash=' + hashHex.substring(0, 16) + '… (' + frame.length + 'B frame) seq=' + saveAtSeq);
                            // Notify viewer of successful save
                            try {
                                parent.postMessage(JSON.stringify({
                                    MessageId: 'SaveComplete',
                                    Values: { hash: hashHex.substring(0, 16), bytes: bytes.length }
                                }), '*');
                            } catch(e) {}
                        });
                    });
                });
            }).catch(function(e) {
                console.error('[relay] Checkpoint failed: ' + e.message);
            });
        }, 1500);
    }

    // Resolve the file storage URL for a given WOPISrc.
    //
    // The viewer's /api/files/ endpoint is the source-of-truth file store.
    // We need this URL so saved checkpoints can be uploaded back here (so
    // late-joiners see the latest content). Resolution order:
    //   1. fileStorageUrl query param — set by the viewer when it builds the
    //      iframe URL. The robust path; works regardless of referrer policy
    //      or cross-origin restrictions.
    //   2. parent.location.origin — works only when same-origin.
    //   3. document.referrer — set unless `referrerpolicy="no-referrer"`.
    //   4. Fallback: the editor's own /wasm/ endpoint. This is wrong for
    //      the source-of-truth (the viewer never sees it) but at least
    //      stores the bytes so the editor can re-load them. Late-join
    //      sync into the viewer's storage will be broken in this mode.
    function getFileStorageUrl(wopiSrc) {
        return resolveFileStorageBase() + '/api/files/' + encodeURIComponent(wopiSrc);
    }

    // Build the URL for a content-addressable blob. Returns null if we
    // can't resolve the file-storage origin AND the caller should fall
    // back to /api/files/<name>.
    function getBlobUrl(hash) {
        if (!hash) return null;
        var base = resolveFileStorageBase();
        if (!base) return null;
        return base + '/api/blobs/' + encodeURIComponent(hash);
    }

    // Resolve the base URL of the viewer (which serves both /api/files/
    // and /api/blobs/). Same resolution order as the old getFileStorageUrl.
    function resolveFileStorageBase() {
        var explicit = params.get('fileStorageUrl');
        if (explicit) {
            if (explicit.charAt(explicit.length - 1) === '/') explicit = explicit.slice(0, -1);
            return explicit;
        }
        try {
            if (window.parent !== window) {
                var origin = window.parent.location.origin;
                if (origin && origin !== 'null') return origin;
            }
        } catch(e) {}
        if (document.referrer) {
            try { return new URL(document.referrer).origin; } catch(e) {}
        }
        // Last resort: the editor's own origin. /api/blobs/ doesn't live
        // there, so getBlobUrl will return a 404 and the late-joiner code
        // will fall back to /wasm/ via the source list.
        console.warn('[relay] resolveFileStorageBase: no fileStorageUrl param, no same-origin parent, no referrer');
        return window.location.origin;
    }

    // --- Process a sequenced UI message ---
    var _kitMessageQueue = []; // messages waiting for WASM runtime
    function processUIMessage(msg, seq) {
        lastSeq = seq;

        var text = new TextDecoder().decode(msg.payload.slice(4)); // Skip seq bytes
        var vid = msg.viewId;

        if (text === 'HULLO' || text === 'BYE' || text.startsWith('tileprocessed ')) return;

        // Queue messages until WASM runtime is ready (callMain completed).
        // Without this, replay messages crash or get "PostMessage ignored".
        if (!Module || !Module.calledRun) {
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
        // 0x08: Save-trigger
        if (msg.type === 0x08) {
            handleSaveTrigger();
            return;
        }

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
                        // First client — no file to download
                        isFirstClient = true;
                        joinFileSeq = 0;
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
                    var blobUrl = info.hash ? getBlobUrl(info.hash) : null;
                    var nameUrl = getFileStorageUrl(wopiSrc);
                    console.log('[relay] Join-response: relay-expected hash=' + (info.hash||'').substring(0, 16) + '… seq=' + info.seq +
                        (blobUrl ? ' — fetching by hash from ' + blobUrl.replace(/\/[a-f0-9]{16,}.*$/, '/<hash>') : ' — fetching by name'));
                    try { parent.postMessage(JSON.stringify({
                        MessageId: 'RelayLateJoinPhase',
                        Values: { phase: 'downloading', msgCount: info.msgCount || 0, seq: info.seq }
                    }), '*'); } catch(e) {}

                    // Try sources in order: blob-by-hash → name → editor's own /wasm/.
                    var sources = [];
                    if (blobUrl) sources.push({ kind: 'blob', url: blobUrl });
                    sources.push({ kind: 'name', url: nameUrl });
                    sources.push({ kind: 'editor-wasm', url: editorWopiUrl });

                    function tryNext(idx) {
                        if (idx >= sources.length) {
                            return Promise.reject(new Error('all sources exhausted'));
                        }
                        var s = sources[idx];
                        var opts = s.kind === 'editor-wasm' ? {} : { mode: 'cors' };
                        return origFetch(s.url, opts).then(function(r) {
                            if (!r.ok) throw new Error(s.kind + ' ' + r.status);
                            return r.arrayBuffer();
                        }).catch(function(e) {
                            console.log('[relay] Source "' + s.kind + '" failed (' + e.message + '), trying next');
                            return tryNext(idx + 1);
                        });
                    }
                    tryNext(0).then(function(buf) {
                        // Decrypt if encrypted (file has [keyVer:4][nonce:12][ct...])
                        return decryptFileBytes(new Uint8Array(buf)).then(function(dec) {
                            return dec.buffer || dec;
                        });
                    }).then(function(buf) {
                        // Compute SHA-256 of what we actually loaded — keeps
                        // the integrity check honest even when we go via
                        // /api/blobs (where it's tautological).
                        var bytes = new Uint8Array(buf);
                        return crypto.subtle.digest('SHA-256', bytes).then(function(hashBuf) {
                            var hashArr = new Uint8Array(hashBuf);
                            joinFileHash = Array.from(hashArr).map(function(b) {
                                return b.toString(16).padStart(2, '0');
                            }).join('');
                            var matches = info.hash && info.hash === joinFileHash;
                            console.log('[relay] Downloaded ' + buf.byteLength + 'B; computed hash=' + joinFileHash.substring(0, 16) + '…' +
                                (matches ? ' (matches relay expected)' :
                                 info.hash ? ' (relay expected ' + info.hash.substring(0, 16) + '… — mismatch will be resolved by relay)' : ''));
                            lateJoinFileReady = true;
                            return origFetch(editorWopiUrl, { method: 'POST', body: new Blob([buf]) });
                        });
                    }).then(function() {
                        console.log('[relay] WOPI file updated — waiting for COOLWSD to load it');
                        try { parent.postMessage(JSON.stringify({
                            MessageId: 'RelayLateJoinPhase',
                            Values: { phase: 'loading' }
                        }), '*'); } catch(e) {}
                    }).catch(function(e) {
                        console.error('[relay] Late-join file sync failed: ' + e.message);
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
                // If this is OUR join announcement, replay is done
                if (joinInfo.viewId === myViewId && replayMode) {
                    replayMode = false;
                    console.log('[relay] Replay mode OFF — ' + lastSeq + ' messages applied to local Kit');
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

        if (msg.type === 0x05 || msg.type === 0x08 || msg.type === 0x0A) {
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
        var lastReportedReason = '';
        activationPollInterval = setInterval(function() {
            if (activated) { clearInterval(activationPollInterval); activationPollInterval = null; return; }
            if (coolwsdReady && lateJoinFileReady && !activated) {
                activateClient();
                clearInterval(activationPollInterval);
                activationPollInterval = null;
                return;
            }
            // Report what we're still waiting on so a stuck activation is
            // diagnosable from the console (and so the parent viewer can
            // surface "Joining session…" instead of looking frozen).
            var waiting = !coolwsdReady ? 'editor' : 'checkpoint download';
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
