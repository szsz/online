// Relay adapter for COOL WASM co-editing.
// ALL user input goes through the relay for strict ordering.
// Each viewId (including own) gets a separate remote ClientSession with its own cursor.
// The local session (from HULLO) handles rendering only (tile requests/responses).
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

    // --- Send message to Kit via the local session ---
    // Uses postMobileMessage which always calls Module._handle_cool_message.
    function sendToKit(data) {
        if (window.postMobileMessage) {
            window.postMobileMessage(data);
        }
    }

    // --- COOLWSD readiness detection ---
    // Poll for TheFakeWebSocket existence and readyState instead of
    // using Object.defineProperty (which causes race conditions).
    function waitForCoolwsd() {
        if (coolwsdReady) return;

        var fws = globalThis.TheFakeWebSocket;
        if (!fws) {
            setTimeout(waitForCoolwsd, 100);
            return;
        }

        // Check if onopen has already fired (readyState-like check)
        // COOL sets TheFakeWebSocket.onopen during init. Once the socket
        // is "open", COOL has finished its init sequence.
        // We detect this by checking if the COOL app has initialized.
        if (!window._map && !document.querySelector('#map')) {
            setTimeout(waitForCoolwsd, 100);
            return;
        }

        // Wait for the status bar to appear (document loaded)
        var statusEl = document.querySelector('#StateWordCount');
        if (!statusEl || !statusEl.textContent || !statusEl.textContent.includes('word')) {
            setTimeout(waitForCoolwsd, 200);
            return;
        }

        // COOLWSD is fully ready — document is loaded
        coolwsdReady = true;
        console.log('[relay] COOLWSD ready (document loaded)');
        installSendInterceptor();

        // Flush queued relay messages
        var pending = recvQueue.splice(0);
        console.log('[relay] Flushing ' + pending.length + ' queued relay messages');
        for (var i = 0; i < pending.length; i++) {
            processRelayMessage(pending[i]);
        }

        // Announce presence
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);
    }
    setTimeout(waitForCoolwsd, 500);

    // --- FakeWebSocket.send interceptor ---
    // User input → relay. System messages → Kit directly via postMobileMessage.
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
                // System messages go to Kit via postMobileMessage (always current)
                sendToKit(data);
            }
        }

        var FWS = fws.constructor;
        if (FWS && FWS.prototype) {
            FWS.prototype.send = interceptedSend;
        }
        fws.send = interceptedSend;
        console.log('[relay] Send interceptor installed');
    }

    // --- Remote client Kit output ---
    globalThis.onRemoteClientMessage = function(clientId, data) {
        // Ignored — each browser renders via its own local session.
    };

    // --- Send message to remote client, converting textinput to key events ---
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

    // --- Process relay message ---
    // ALL messages go through relay for strict ordering.
    // Own viewId: route to local session (own cursor, own view).
    // Other viewIds: route to remote ClientSessions (separate cursors).
    function processRelayMessage(msg) {
        if (msg.type !== 0x00) return;
        var text = new TextDecoder().decode(msg.payload);
        var vid = msg.viewId;

        if (text === 'HULLO' || text === 'BYE' || text.startsWith('tileprocessed ')) return;

        // Presence messages: trigger remote client creation for other viewIds
        if (text.startsWith('presence ')) {
            if (vid !== myViewId && !remoteClients[vid]) {
                createRemoteClient(vid);
            }
            return;
        }

        // Only user input is relevant
        var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
            text.startsWith('textinput ') || text.startsWith('windowkey ');
        if (!isUserInput) return;

        // Own viewId: send to local session (own cursor position)
        // Convert textinput to key events (postKeyEvent is sync, postWindowExtTextInputEvent is async)
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

        // Other viewId: create remote client if needed
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
    };
    ws.onerror = function(err) { console.error('[relay] WebSocket error', err); };
    ws.onclose = function() { connected = false; console.log('[relay] Disconnected'); };
})();
