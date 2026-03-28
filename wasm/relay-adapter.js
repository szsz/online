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

    // --- Intercept document fetch for late-join file redirect ---
    // The WASM module uses emscripten_fetch to GET the document.
    // For late joiners, we overwrite the file on the WOPI server
    // before the WASM module fetches it. We also intercept fetch/XHR as backup.
    var lateJoinFileReady = false;

    // Intercept both XHR and fetch API
    var xhrOrigOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (lateJoinFileReady && method === 'GET') {
            var wopiSrc = params.get('WOPISrc') || '';
            if (wopiSrc && url.indexOf(wopiSrc) !== -1) {
                console.log('[relay] XHR redirect: ' + url.substring(0, 80));
            }
        }
        return xhrOrigOpen.apply(this, arguments);
    };

    var origFetch = window.fetch;
    window.fetch = function(url, opts) {
        if (lateJoinFileReady && typeof url === 'string') {
            var wopiSrc = params.get('WOPISrc') || '';
            if (wopiSrc && url.indexOf(wopiSrc) !== -1 && (!opts || opts.method === 'GET' || !opts.method)) {
                console.log('[relay] fetch redirect: ' + url.substring(0, 80));
            }
        }
        return origFetch.apply(this, arguments);
    };

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

        // Short timeout: relay responds immediately if no peers (first client)
        // or within ~15s if an existing client needs to save.
        setTimeout(function() {
            if (!lateJoinSaveComplete) {
                console.log('[relay] No save-complete response — proceeding as first client');
                isLateJoiner = false;
            }
        }, 5000);
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

        if (!writerReady && !calcReady) {
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

        // Initial save to relay so late joiners can get the document.
        // Subsequent saves are coordinated by the relay server (every 10 min or on join).
        saveAndUploadToRelay();
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
        console.log('[relay] Save-trigger received — saving and uploading');
        saveAndUploadToRelay();
    }

    // Reusable save+upload function (called on init, save-trigger, etc.)
    function saveAndUploadToRelay() {
        if (!connected) return;
        sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        setTimeout(function() {
            var wopiSrc = params.get('WOPISrc') || '';
            var fetchUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
            origFetch(fetchUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                var bytes = new Uint8Array(buf);
                var frame = new Uint8Array(5 + bytes.length);
                frame[0] = 0x07;
                frame[1] = (myViewId >>> 24) & 0xFF;
                frame[2] = (myViewId >>> 16) & 0xFF;
                frame[3] = (myViewId >>> 8) & 0xFF;
                frame[4] = myViewId & 0xFF;
                frame.set(bytes, 5);
                ws.send(frame);
                console.log('[relay] Uploaded to relay: ' + bytes.length + ' bytes');
            }).catch(function(e) {
                console.error('[relay] Upload failed: ' + e.message);
            });
        }, 5000); // Wait 5s for Kit save + saveToServer POST
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
                    var relayHost = new URL(relayUrl.replace('wss://', 'https://').replace('ws://', 'http://'));
                    var relayFileUrl = relayHost.origin + info.url;
                    console.log('[relay] Save-complete: hash=' + info.hash + ', downloading from relay...');

                    // Download from relay and overwrite the WOPI file IMMEDIATELY.
                    // This must complete before the WASM module fetches the document (~25s from now).
                    var wopiSrc = params.get('WOPISrc') || '';
                    var wopiUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
                    origFetch(relayFileUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                        console.log('[relay] Downloaded ' + buf.byteLength + ' bytes from relay, uploading to WOPI...');
                        lateJoinFileReady = true;
                        return origFetch(wopiUrl, { method: 'POST', body: new Blob([buf]) });
                    }).then(function() {
                        console.log('[relay] WOPI file updated for late join');
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
        if (msg.type !== 0x00) {
            console.log('[relay] Received type=0x' + msg.type.toString(16) + ' payload=' + msg.payload.length + 'b');
        }
        // Process control messages (0x05 save-complete, 0x08 save-trigger) IMMEDIATELY
        // because 0x05 must update the WOPI file BEFORE the WASM module fetches it.
        if (msg.type === 0x05 || msg.type === 0x08) {
            processRelayMessage(msg);
            return;
        }
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
