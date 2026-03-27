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

    // Remote client tracking: viewId → { clientId, ready, queue }
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

    // --- COOLWSD readiness: detected via TheFakeWebSocket.onopen ---
    function onCoolwsdReady() {
        coolwsdReady = true;
        installSendInterceptor();
        console.log('[relay] COOLWSD ready, flushing ' + recvQueue.length + ' queued messages');
        var pending = recvQueue.splice(0);
        for (var i = 0; i < pending.length; i++) {
            processRelayMessage(pending[i]);
        }
        // Announce presence so other browsers create our remote client
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);
    }

    function waitForFakeWebSocket() {
        if (!globalThis.TheFakeWebSocket) {
            setTimeout(waitForFakeWebSocket, 50);
            return;
        }
        var fakeWs = globalThis.TheFakeWebSocket;
        var _realOnOpen = fakeWs.onopen || null;
        Object.defineProperty(fakeWs, 'onopen', {
            configurable: true,
            set: function(fn) { _realOnOpen = fn; },
            get: function() {
                return function() {
                    if (_realOnOpen) _realOnOpen.apply(fakeWs, arguments);
                    if (!coolwsdReady) {
                        console.log('[relay] TheFakeWebSocket.onopen fired');
                        onCoolwsdReady();
                    }
                };
            }
        });
        console.log('[relay] Intercepting TheFakeWebSocket.onopen');
    }
    waitForFakeWebSocket();

    // --- FakeWebSocket.send interceptor ---
    // User input → relay (for ordering). System messages → Kit directly.
    function installSendInterceptor() {
        if (!globalThis.TheFakeWebSocket) return;
        var fws = globalThis.TheFakeWebSocket;
        var FWS = fws.constructor;
        var origSend = FWS.prototype.send.bind(fws);

        function interceptedSend(data) {
            var text = typeof data === 'string' ? data : '';
            var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
                text.startsWith('textinput ') || text.startsWith('windowkey ');
            if (isUserInput) {
                sendToRelay(0x00, myViewId, data);
            } else {
                origSend(data);
            }
        }

        if (FWS && FWS.prototype && FWS.prototype.send) {
            FWS.prototype.send = interceptedSend;
        }
        fws.send = interceptedSend;
        console.log('[relay] Send interceptor installed');
    }

    // --- Remote client output from Kit ---
    globalThis.onRemoteClientMessage = function(clientId, data) {
        // Mostly ignored — each browser renders via its local session.
        // Could log for debugging.
    };

    // --- Send a message to a remote client, converting textinput to key events ---
    // textinput uses postWindowExtTextInputEvent (async — cursor doesn't advance).
    // key uses postKeyEvent (sync — cursor advances immediately).
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

    // --- Create a remote ClientSession for a viewId ---
    function createRemoteClient(viewId) {
        if (remoteClients[viewId]) return;

        console.log('[relay] Creating remote client for viewId=' + viewId);
        var clientId = Module._create_remote_client();
        remoteClients[viewId] = { clientId: clientId, ready: false, queue: [] };
        console.log('[relay] Remote client created: viewId=' + viewId + ' → clientId=' + clientId);

        // Re-announce presence so late-joining peers learn about us
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);
    }

    // --- Global poller: C++ signals when remote clients finish init ---
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
    // ALL messages from ALL viewIds (including own) go to remote ClientSessions.
    // The relay guarantees identical ordering on every browser.
    function processRelayMessage(msg) {
        if (msg.type !== 0x00) return;
        var text = new TextDecoder().decode(msg.payload);
        var vid = msg.viewId;

        // Skip control messages
        if (text === 'HULLO' || text === 'BYE' || text.startsWith('tileprocessed ')) {
            return;
        }

        // Create remote client for any new viewId (including own)
        if (!remoteClients[vid]) {
            createRemoteClient(vid);
        }

        // Only user input goes to remote clients
        var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
            text.startsWith('textinput ') || text.startsWith('windowkey ');
        if (!isUserInput) {
            return;
        }

        var rc = remoteClients[vid];
        if (!rc.ready) {
            console.log('[relay] Queuing for viewId=' + vid + ' (not ready): ' + text.substring(0, 60));
            rc.queue.push(text);
            return;
        }

        try {
            sendToRemoteClient(rc.clientId, text);
        } catch(e) {
            console.error('[relay] FAILED: ' + e.message + ' | ' + text.substring(0, 40));
        }
    }

    // --- WebSocket handlers ---
    ws.onmessage = function(event) {
        var msg = parseFrame(event.data);
        if (!coolwsdReady) {
            recvQueue.push(msg);
            return;
        }
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
