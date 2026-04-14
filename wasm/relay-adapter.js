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
    if (!relayUrl) return;

    console.log('[relay] Connecting to ' + relayUrl);

    var ws = new WebSocket(relayUrl);
    ws.binaryType = 'arraybuffer';

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

    var remoteClients = {};

    // --- Room switching (for hot-switch document changes) ---
    // When the viewer switches documents via hash change, it sends a
    // RelaySwitchRoom message. We disconnect from the old room and
    // connect to the new one, preserving the WASM runtime.
    window.addEventListener('message', function(event) {
        try {
            var msg = typeof event.data === 'string' ? JSON.parse(event.data) : null;
            if (!msg || msg.MessageId !== 'RelaySwitchRoom') return;
            var newRoom = msg.Values.room;
            var newDoc = msg.Values.docName;
            console.log('[relay] Room switch: ' + relayUrl + ' → ' + newRoom);

            // Close old connection
            if (ws && ws.readyState <= 1) {
                ws.onclose = null; // prevent reconnect logic
                ws.close();
            }

            // Reset state for new room
            connected = false;
            activated = false;
            isFirstClient = false;
            joinFileHash = null;
            joinFileSeq = 0;
            lastSeq = 0;
            sendQueue = [];
            recvQueue = [];
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
        if (connected) ws.send(frame);
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
            globalThis.postMobileMessage(msg);
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
        // Impress: Slide Show menu
        var impressReady = false;
        var navEl = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
        if (navEl && navEl.textContent && navEl.textContent.includes('Slide Show')) {
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
        // Send join-ready with checkpoint hash for verification
        var readyPayload = joinFileHash ? JSON.stringify({ hash: joinFileHash }) : '';
        console.log('[relay] Activating — sending join-ready hash=' + (joinFileHash || 'none'));
        sendToRelay(0x06, myViewId, readyPayload);

        // Announce presence
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);

        // Initial save to relay so future late joiners can get the document
        saveAndUploadCheckpoint();
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
            var text = typeof data === 'string' ? data : '';
            var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
                text.startsWith('textinput ') || text.startsWith('windowkey ') ||
                text.startsWith('uno ');
            if (isUserInput) {
                if (!activated) {
                    console.log('[relay] Dropping input (not activated yet): ' + text.substring(0, 40));
                    return;
                }
                sendToRelay(0x00, myViewId, data);
            } else {
                // Non-user-input (tileprocessed, clientzoom, etc.) goes
                // directly to Kit SYNCHRONOUSLY via postMobileMessage.
                // These are not relayed and must not be deferred.
                if (globalThis.postMobileMessage) {
                    globalThis.postMobileMessage(data);
                }
            }
        }

        var FWS = fws.constructor;
        if (FWS && FWS.prototype) FWS.prototype.send = interceptedSend;
        fws.send = interceptedSend;
        console.log('[relay] Send interceptor installed');
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
        // Word count is document-level, safe to forward.
        if (text.indexOf('.uno:StateWordCount=') >= 0) shouldForward = true;
        // Modified status is document-level.
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

    function createRemoteClient(viewId) {
        if (remoteClients[viewId]) return;
        console.log('[relay] Creating remote client for viewId=' + viewId);
        var clientId = Module._create_remote_client();
        remoteClients[viewId] = { clientId: clientId, ready: false, queue: [] };
        console.log('[relay] Remote client created: viewId=' + viewId + ' clientId=' + clientId);
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);
    }

    // --- Poll for C++ ready signals ---
    function globalPollReady() {
        if (!Module || !Module.calledRun || !Module._poll_remote_client_ready) {
            setTimeout(globalPollReady, 500);
            return;
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

    function saveAndUploadCheckpoint() {
        if (!connected) return;
        sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        setTimeout(function() {
            var saveAtSeq = lastSeq;
            var wopiSrc = params.get('WOPISrc') || '';
            // 1. Download saved file from editor's temp storage
            var editorFileUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
            origFetch(editorFileUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                var bytes = new Uint8Array(buf);
                // 2. Compute hash
                return crypto.subtle.digest('SHA-256', bytes).then(function(hashBuf) {
                    var hashArr = new Uint8Array(hashBuf);
                    var hash = Array.from(hashArr.slice(0, 8)).map(function(b) {
                        return b.toString(16).padStart(2, '0');
                    }).join('');
                    // 3. Upload file to FILE STORAGE SERVER (the viewer)
                    var viewerFileUrl = getFileStorageUrl(wopiSrc);
                    return origFetch(viewerFileUrl, {
                        method: 'POST',
                        body: new Blob([bytes]),
                        mode: 'cors',
                    }).then(function() {
                        // 4. Report to relay — send file bytes for backward
                        // compat with old relay servers. Future: send hash only.
                        var frame = new Uint8Array(5 + 4 + bytes.length);
                        frame[0] = 0x07;
                        frame[1] = (myViewId >>> 24) & 0xFF;
                        frame[2] = (myViewId >>> 16) & 0xFF;
                        frame[3] = (myViewId >>> 8) & 0xFF;
                        frame[4] = myViewId & 0xFF;
                        frame[5] = (saveAtSeq >>> 24) & 0xFF;
                        frame[6] = (saveAtSeq >>> 16) & 0xFF;
                        frame[7] = (saveAtSeq >>> 8) & 0xFF;
                        frame[8] = saveAtSeq & 0xFF;
                        frame.set(bytes, 9);
                        ws.send(frame);
                        console.log('[relay] Checkpoint: ' + bytes.length + 'b hash=' + hash + ' seq=' + saveAtSeq + ' → file storage + relay');
                    });
                });
            }).catch(function(e) {
                console.error('[relay] Checkpoint failed: ' + e.message);
            });
        }, 5000);
    }

    // Resolve the file storage URL for a given WOPISrc.
    // The viewer's /api/files/ endpoint is the canonical file store.
    // Since the iframe is cross-origin, we derive the viewer origin from
    // the relay URL (same host family) or document.referrer.
    function getFileStorageUrl(wopiSrc) {
        var encoded = encodeURIComponent(wopiSrc);
        // Try parent origin (works if same-origin or permissions allow)
        try {
            if (window.parent !== window) {
                var origin = window.parent.location.origin;
                if (origin && origin !== 'null') return origin + '/api/files/' + encoded;
            }
        } catch(e) {}
        // Try referrer (set when iframe is created by the viewer)
        if (document.referrer) {
            try {
                return new URL(document.referrer).origin + '/api/files/' + encoded;
            } catch(e) {}
        }
        // Derive from relay URL: relay is on the editor domain,
        // but the file storage server is the viewer. We can't derive
        // it without configuration. Fall back to the editor's /wasm/
        // endpoint which also stores files.
        return window.location.origin + '/wasm/' + encoded;
    }

    // --- Process a sequenced UI message ---
    function processUIMessage(msg, seq) {
        lastSeq = seq;

        var text = new TextDecoder().decode(msg.payload.slice(4)); // Skip seq bytes
        var vid = msg.viewId;

        if (text === 'HULLO' || text === 'BYE' || text.startsWith('tileprocessed ')) return;

        // Presence: trigger remote client creation
        if (text.startsWith('presence ')) {
            if (vid !== myViewId && !remoteClients[vid]) {
                createRemoteClient(vid);
            }
            return;
        }

        var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
            text.startsWith('textinput ') || text.startsWith('windowkey ') ||
            text.startsWith('uno ');
        if (!isUserInput) return;

        if (text.startsWith('uno ')) {
            console.log('[relay] UNO via relay: vid=' + vid + ' myVid=' + myViewId +
                        ' isSelf=' + (vid === myViewId) + ' cmd=' + text.substring(0, 60));
        }

        // Log relay-routed messages for debugging
        if (text.startsWith('key ') && text.includes('char=')) {
            console.log('[relay] processUI: vid=' + vid + ' myVid=' + myViewId + ' isSelf=' + (vid===myViewId) + ' ' + text.substring(0, 50));
        }

        // Own viewId → local Kit session (own cursor)
        if (vid === myViewId) {
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

                    // Late joiner — download checkpoint file.
                    // The checkpoint was saved to both the file storage server
                    // AND the editor's /wasm/ endpoint. We download from the
                    // editor (same origin, no CORS issues) and overwrite the
                    // local WOPI file so the WASM loads the right version.
                    joinFileHash = info.hash;
                    joinFileSeq = info.seq;
                    var wopiSrc = params.get('WOPISrc') || '';
                    var editorWopiUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
                    console.log('[relay] Join-response: hash=' + info.hash + ' seq=' + info.seq + ' — downloading checkpoint');

                    // First try file storage (canonical), fall back to editor's /wasm/
                    var fileStorageUrl = getFileStorageUrl(wopiSrc);
                    origFetch(fileStorageUrl, { mode: 'cors' }).then(function(r) {
                        if (!r.ok) throw new Error('File storage ' + r.status);
                        return r.arrayBuffer();
                    }).catch(function() {
                        // Fallback: download from editor's own /wasm/ endpoint
                        console.log('[relay] File storage unavailable, using editor /wasm/');
                        return origFetch(editorWopiUrl).then(function(r) { return r.arrayBuffer(); });
                    }).then(function(buf) {
                        console.log('[relay] Downloaded ' + buf.byteLength + 'b (hash=' + joinFileHash + ')');
                        lateJoinFileReady = true;
                        return origFetch(editorWopiUrl, { method: 'POST', body: new Blob([buf]) });
                    }).then(function() {
                        console.log('[relay] WOPI file updated — waiting for COOLWSD to load it');
                    }).catch(function(e) {
                        console.error('[relay] Late-join file sync failed: ' + e.message);
                    });
                } catch(e) {
                    console.log('[relay] Join-response parse error: ' + e.message);
                }
            }
            return;
        }

        // 0x02: Client joined
        if (msg.type === 0x02) {
            try {
                var joinInfo = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('[relay] Client joined: viewId=' + joinInfo.viewId + ' seq=' + joinInfo.seq);
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
        if (msg.type === 0x00 && msg.payload.length >= 4) {
            var seq = ((msg.payload[0] << 24) | (msg.payload[1] << 16) |
                       (msg.payload[2] << 8) | msg.payload[3]) >>> 0;
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

    ws.onmessage = onWsMessage;
    ws.onopen = onWsOpen;
    ws.onerror = function(err) { console.error('[relay] WebSocket error', err); };
    ws.onclose = function() { connected = false; console.log('[relay] Disconnected'); };

    // --- Activation when COOLWSD is ready (for late joiners) ---
    // Late joiners: wait for both COOLWSD ready AND file downloaded
    var activationPollInterval = setInterval(function() {
        if (activated) { clearInterval(activationPollInterval); return; }
        if (coolwsdReady && lateJoinFileReady && !activated) {
            activateClient();
            clearInterval(activationPollInterval);
        }
    }, 500);
})();
