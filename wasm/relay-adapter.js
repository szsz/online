// Relay adapter for COOL WASM co-editing.
// ALL user input goes through the relay for strict ordering.
// Each viewId gets a separate cursor (own = local session, other = remote ClientSession).
// Supports late join: new browser requests save from existing participant,
// downloads current state, then replays buffered messages.
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
    var sendQueue = [];
    var recvQueue = [];
    var myViewId = Math.floor(Math.random() * 0x7FFFFF);
    var isLateJoiner = false;
    var lateJoinSaveComplete = false;
    var lateJoinFileUrl = null;
    var lateJoinFileHash = null;

    var remoteClients = {};

    // --- Relay framing ---
    function sendToRelay(type, viewId, payload) {
        var encoded = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload);
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
        return {
            type: f[0],
            viewId: ((f[1] << 24) | (f[2] << 16) | (f[3] << 8) | f[4]) >>> 0,
            payload: f.slice(5)
        };
    }

    console.log('[relay] My viewId=' + myViewId);

    // --- Send message to Kit via local session ---
    function sendToKit(data) {
        if (window.postMobileMessage) {
            window.postMobileMessage(data);
        }
    }

    // --- Late join: send save-request as soon as relay connects ---
    // The save handshake (~3-5s) completes well before WASM compile (~40s),
    // so the file is updated before the WASM module fetches it.
    function initiateLateJoin() {
        var wopiSrc = params.get('WOPISrc') || '';
        console.log('[relay] Sending save-request for late join (WOPISrc=' + wopiSrc + ')');
        sendToRelay(0x04, myViewId, wopiSrc);

        // Timeout: if no save-complete in 10s, proceed as first client
        setTimeout(function() {
            if (!lateJoinSaveComplete) {
                console.log('[relay] No save-complete response — proceeding as first client');
                isLateJoiner = false;
            }
        }, 10000);
    }

    // --- COOLWSD readiness: poll for document loaded ---
    function waitForCoolwsd() {
        if (coolwsdReady) return;

        var fws = globalThis.TheFakeWebSocket;
        if (!fws) { setTimeout(waitForCoolwsd, 100); return; }

        var statusEl = document.querySelector('#StateWordCount');
        if (!statusEl || !statusEl.textContent || !statusEl.textContent.includes('word')) {
            setTimeout(waitForCoolwsd, 200);
            return;
        }

        coolwsdReady = true;
        console.log('[relay] COOLWSD ready (document loaded)');
        installSendInterceptor();

        // Flush queued relay messages FIRST (may set isLateJoiner via 0x05)
        var pending = recvQueue.splice(0);
        console.log('[relay] Flushing ' + pending.length + ' queued relay messages');
        for (var i = 0; i < pending.length; i++) {
            processRelayMessage(pending[i]);
        }

        // Now check if we became a late joiner from queued messages
        if (isLateJoiner) {
            console.log('[relay] Late joiner sending ready signal');
            sendToRelay(0x06, myViewId, '');
        }

        // Announce presence
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);

        // If first client (not a late joiner), upload initial file to relay
        // so future late joiners can get it without needing an existing client to save.
        if (!isLateJoiner) {
            setTimeout(function() {
                // Trigger a save so the file on the WOPI server is current
                sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
                setTimeout(function() {
                    // Upload to relay
                    var wopiSrc = params.get('WOPISrc') || '';
                    var fetchUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
                    fetch(fetchUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                        var bytes = new Uint8Array(buf);
                        console.log('[relay] Initial file upload: ' + bytes.length + ' bytes');
                        var frame = new Uint8Array(5 + bytes.length);
                        frame[0] = 0x07;
                        frame[1] = (myViewId >>> 24) & 0xFF;
                        frame[2] = (myViewId >>> 16) & 0xFF;
                        frame[3] = (myViewId >>> 8) & 0xFF;
                        frame[4] = myViewId & 0xFF;
                        frame.set(bytes, 5);
                        ws.send(frame);
                    }).catch(function(e) {
                        console.log('[relay] Initial file upload failed: ' + e.message);
                    });
                }, 5000); // wait for save to complete
            }, 3000); // wait a bit after becoming ready
        }
    }
    setTimeout(waitForCoolwsd, 500);

    // --- FakeWebSocket.send interceptor ---
    function installSendInterceptor() {
        var fws = globalThis.TheFakeWebSocket;
        if (!fws) return;

        function interceptedSend(data) {
            var text = typeof data === 'string' ? data : '';
            var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
                text.startsWith('textinput ') || text.startsWith('windowkey ');
            if (isUserInput) {
                sendToRelay(0x00, myViewId, data);
            } else {
                sendToKit(data);
            }
        }

        var FWS = fws.constructor;
        if (FWS && FWS.prototype) FWS.prototype.send = interceptedSend;
        fws.send = interceptedSend;
        console.log('[relay] Send interceptor installed');
    }

    // --- Remote client output ---
    globalThis.onRemoteClientMessage = function(clientId, data) {};

    // --- Send to remote client with textinput→key conversion ---
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

    // --- Create remote client ---
    function createRemoteClient(viewId) {
        if (remoteClients[viewId]) return;
        console.log('[relay] Creating remote client for viewId=' + viewId);
        var clientId = Module._create_remote_client();
        remoteClients[viewId] = { clientId: clientId, ready: false, queue: [] };
        console.log('[relay] Remote client created: viewId=' + viewId + ' → clientId=' + clientId);
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

    // --- Handle save-request from a late joiner (existing participant) ---
    // --- Handle save-trigger (0x08) from relay ---
    // Relay asks us to save the document and upload the file back.
    function handleSaveTrigger() {
        console.log('[relay] Save-trigger received — saving and uploading document');
        // Send save command to Kit
        sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');

        // After Kit saves to disk, read the file and upload to relay via 0x07
        // Kit calls saveToServer() which POSTs to the WOPI URL.
        // We also need to upload to the relay. Wait for the save to finish,
        // then fetch the file from the WOPI server and send it to relay.
        setTimeout(function() {
            // Fetch the saved file from the WOPI server
            var wopiSrc = new URLSearchParams(window.location.search).get('WOPISrc') || '';
            var fetchUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
            console.log('[relay] Fetching saved file from ' + fetchUrl);
            fetch(fetchUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                var bytes = new Uint8Array(buf);
                console.log('[relay] Uploading ' + bytes.length + ' bytes to relay');
                // Send as type 0x07 (file-upload)
                var frame = new Uint8Array(5 + bytes.length);
                frame[0] = 0x07;
                frame[1] = (myViewId >>> 24) & 0xFF;
                frame[2] = (myViewId >>> 16) & 0xFF;
                frame[3] = (myViewId >>> 8) & 0xFF;
                frame[4] = myViewId & 0xFF;
                frame.set(bytes, 5);
                ws.send(frame);
                console.log('[relay] File uploaded to relay');
            }).catch(function(e) {
                console.error('[relay] File upload failed: ' + e.message);
            });
        }, 10000); // Wait 10s for Kit to save + saveToServer to POST
    }

    // --- Process relay message ---
    function processRelayMessage(msg) {
        // Handle late-join protocol messages
        if (msg.type === 0x08) {
            // Save-trigger from relay: save document and upload file
            handleSaveTrigger();
            return;
        }

        if (msg.type === 0x05) {
            // Save-complete from relay (with hash+url, or empty = no peers)
            lateJoinSaveComplete = true;
            if (msg.payload.length > 0) {
                isLateJoiner = true;
                try {
                    var info = JSON.parse(new TextDecoder().decode(msg.payload));
                    lateJoinFileUrl = info.url;
                    lateJoinFileHash = info.hash;
                    console.log('[relay] Save-complete: hash=' + info.hash + ' url=' + info.url);

                    // Download from relay and overwrite the WOPI file
                    // so the WASM module (which fetches via WOPISrc) gets the current state.
                    var relayHost = new URL(relayUrl.replace('wss://', 'https://').replace('ws://', 'http://'));
                    var fileUrl = relayHost.origin + info.url;
                    var wopiSrc = params.get('WOPISrc') || '';
                    var wopiUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
                    console.log('[relay] Downloading from relay: ' + fileUrl);
                    fetch(fileUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                        console.log('[relay] Downloaded ' + buf.byteLength + ' bytes, uploading to WOPI: ' + wopiUrl);
                        return fetch(wopiUrl, { method: 'POST', body: new Blob([buf]) });
                    }).then(function() {
                        console.log('[relay] WOPI file updated for late joiner');
                    }).catch(function(e) {
                        console.error('[relay] Late join file sync failed: ' + e.message);
                    });
                } catch(e) {
                    console.log('[relay] Save-complete parse error: ' + e.message);
                }
            } else {
                isLateJoiner = false;
                console.log('[relay] No peers — first client');
            }
            return;
        }

        if (msg.type !== 0x00) return;
        var text = new TextDecoder().decode(msg.payload);
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
            text.startsWith('textinput ') || text.startsWith('windowkey ');
        if (!isUserInput) return;

        // Own viewId → local session (with textinput→key conversion)
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

        // Other viewId → remote ClientSession
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
            console.error('[relay] FAILED: ' + e.message);
        }
    }

    // --- WebSocket handlers ---
    ws.onmessage = function(event) {
        var msg = parseFrame(event.data);
        if (!coolwsdReady) { recvQueue.push(msg); return; }
        processRelayMessage(msg);
    };
    ws.onopen = function() {
        connected = true;
        console.log('[relay] Connected');
        for (var i = 0; i < sendQueue.length; i++) ws.send(sendQueue[i]);
        sendQueue = [];
        // Initiate late-join protocol immediately
        initiateLateJoin();
    };
    ws.onerror = function(err) { console.error('[relay] WebSocket error', err); };
    ws.onclose = function() { connected = false; console.log('[relay] Disconnected'); };
})();
