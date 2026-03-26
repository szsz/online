// Relay adapter for COOL WASM co-editing.
// Each user's input goes to their own remote ClientSession (separate cursors).
// The local session (from HULLO) handles rendering only.
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
        // Install send interceptor now that init is done
        installSendInterceptor();
        console.log('[relay] COOLWSD ready, flushing ' + recvQueue.length + ' queued messages');
        var pending = recvQueue.splice(0);
        for (var i = 0; i < pending.length; i++) {
            processRelayMessage(pending[i]);
        }
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

    // --- FakeWebSocket.send interceptor (installed after init) ---
    function installSendInterceptor() {
        if (!globalThis.TheFakeWebSocket) return;
        var fws = globalThis.TheFakeWebSocket;
        var FWS = fws.constructor;
        if (FWS && FWS.prototype && FWS.prototype.send) {
            FWS.prototype.send = function(data) {
                sendToRelay(0x00, myViewId, data);
            };
        }
        fws.send = function(data) {
            sendToRelay(0x00, myViewId, data);
        };
        console.log('[relay] FakeWebSocket.send interceptor installed');
    }

    // --- Remote client lifecycle (called from C++ via send2RemoteJS) ---
    // Detect when remote session finishes loading (via forwarding thread output)
    globalThis.onRemoteClientMessage = function(clientId, data) {
        if (typeof data === 'string' && data.startsWith('commandresult:') && data.includes('"load"') && data.includes('"success": true')) {
            for (var vid in remoteClients) {
                if (remoteClients[vid].clientId === clientId && !remoteClients[vid].ready) {
                    remoteClients[vid].ready = true;
                    console.log('[relay] Remote client loaded: viewId=' + vid + ' clientId=' + clientId + ', flushing ' + remoteClients[vid].queue.length + ' queued msgs');

                    // Post-load viewport setup
                    Module._handle_remote_message(clientId, Module.stringToNewUTF8(
                        'clientvisiblearea x=0 y=0 width=15000 height=9000 splitx=0 splity=0'));

                    // Flush queued user input
                    var q = remoteClients[vid].queue;
                    remoteClients[vid].queue = [];
                    for (var i = 0; i < q.length; i++) {
                        Module._handle_remote_message(clientId, Module.stringToNewUTF8(q[i]));
                    }
                    return;
                }
            }
        }
    };

    globalThis.onRemoteClientMessage = function(clientId, data) {
        // Remote client WASM output — we ignore it; each browser renders locally
        // But log for debugging
        if (typeof data === 'string') {
            var preview = data.substring(0, 60);
            if (data.startsWith('invalidatetiles:') || data.startsWith('statechanged:')) {
                // These are tile invalidations — the local session also gets them via broadcastMessage
                // No action needed
            }
        }
    };

    // --- Create a remote ClientSession for a viewId ---
    function createRemoteClient(viewId) {
        if (remoteClients[viewId]) return;

        console.log('[relay] Creating remote client for viewId=' + viewId);
        var clientId = Module._create_remote_client();
        remoteClients[viewId] = { clientId: clientId, ready: false, queue: [] };
        console.log('[relay] Remote client created: viewId=' + viewId + ' → clientId=' + clientId);

        // Init sequence sent after pollConnected detects the thread connected

        // Poll for the C++ thread to signal this client is connected.
        // Can't use MAIN_THREAD_EM_ASM callbacks (they deadlock).
        function pollConnected() {
            if (!Module._poll_remote_client_ready) {
                setTimeout(pollConnected, 500);
                return;
            }
            var readyId = Module._poll_remote_client_ready();
            if (readyId === clientId) {
                // C++ thread already sent fileURL + coolclient + load
                console.log('[relay] Remote client ' + clientId + ' init sent by C++ thread');
                // Wait for Kit to load the second view (40s), then mark ready
                setTimeout(function() {
                    if (remoteClients[viewId] && !remoteClients[viewId].ready) {
                        remoteClients[viewId].ready = true;
                        var q = remoteClients[viewId].queue;
                        remoteClients[viewId].queue = [];
                        console.log('[relay] Remote client ' + clientId + ' ready, flushing ' + q.length + ' msgs');
                        for (var i = 0; i < q.length; i++) {
                            try {
                                Module._handle_remote_message(clientId, Module.stringToNewUTF8(q[i]));
                            } catch(e) {
                                console.error('[relay] Flush msg ' + i + ' failed: ' + q[i].substring(0, 40));
                            }
                        }
                    }
                }, 40000);
            } else {
                setTimeout(pollConnected, 200);
            }
        }
        setTimeout(pollConnected, 500);
    }

    // --- Process relay message ---
    function processRelayMessage(msg) {
        if (msg.type !== 0x00) return;
        var text = new TextDecoder().decode(msg.payload);
        var vid = msg.viewId;

        // Skip control messages
        if (text === 'HULLO' || text === 'BYE' || text.startsWith('tileprocessed ')) {
            return;
        }

        // Determine if this is user input or system/rendering message
        var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
            text.startsWith('textinput ') || text.startsWith('windowkey ');

        // System messages (tilecombine, clientvisiblearea, etc.) go to local session
        if (!isUserInput) {
            Module._handle_cool_message(Module.stringToNewUTF8(text));
            return;
        }

        // User input → goes to this viewId's remote ClientSession
        if (!remoteClients[vid]) {
            createRemoteClient(vid);
        }

        var rc = remoteClients[vid];
        if (!rc.ready) {
            console.log('[relay] Queuing for viewId=' + vid + ' (not ready): ' + text.substring(0, 60));
            rc.queue.push(text);
            return;
        }

        try {
            Module._handle_remote_message(rc.clientId, Module.stringToNewUTF8(text));
        } catch(e) {
            console.error('[relay] remote_message failed: ' + text.substring(0, 40));
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
