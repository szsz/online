// Relay adapter for COOL WASM co-editing.
// Loaded in the browser AFTER global.js, BEFORE HULLO is sent.
//
// Intercepts postMobileMessage (JS→WASM) and routes UI messages through
// a WebSocket relay server so multiple browsers can co-edit.
//
// Each browser runs its own WASM instance. All UI messages are broadcast
// to all clients. Each WASM processes all messages independently.
// WASM→JS (tiles, status) stays local — no relay needed for that direction.
//
// Remote clients (other browsers in the room) get their own ClientSession
// in the local WASM via create_remote_client / handle_remote_message.
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
    var wasmReady = false;
    var coolwsdReady = false; // True after local HULLO has been processed
    var sendQueue = [];  // Messages queued before WebSocket connects
    var recvQueue = [];  // Messages queued before WASM + COOLWSD are ready
    // Use small random ID to avoid signed int32 issues in bitwise parsing
    var myViewId = Math.floor(Math.random() * 0x7FFFFF);
    var remoteViewIds = new Set(); // viewIds of other clients in the room

    // Wait for COOLWSD to be fully ready.
    // COOLWSD.cpp calls handle_cool_message("HULLO") then TheFakeWebSocket.onopen()
    // directly from C++ (not through JS postMobileMessage). So we detect readiness
    // by polling for coolwsd_server_socket_fd being set (via Module calledRun + delay)
    // or by intercepting TheFakeWebSocket.onopen.
    function onCoolwsdReady() {
        wasmReady = true;
        coolwsdReady = true;
        console.log('[relay] COOLWSD ready, flushing ' + recvQueue.length + ' queued messages');
        var pending = recvQueue.splice(0);
        for (var i = 0; i < pending.length; i++) {
            processRelayMessage(pending[i]);
        }
    }

    // Intercept TheFakeWebSocket.onopen — COOLWSD calls this after HULLO.
    // Use Object.defineProperty so we catch the call even if onopen is set later.
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

    // --- Send a framed message to the relay ---
    function sendToRelay(type, viewId, payload) {
        var encoded;
        if (typeof payload === 'string') {
            encoded = new TextEncoder().encode(payload);
        } else {
            encoded = new Uint8Array(payload);
        }
        var frame = new Uint8Array(1 + 4 + encoded.length);
        frame[0] = type;
        // Write viewId as big-endian uint32
        frame[1] = (viewId >>> 24) & 0xFF;
        frame[2] = (viewId >>> 16) & 0xFF;
        frame[3] = (viewId >>> 8) & 0xFF;
        frame[4] = viewId & 0xFF;
        frame.set(encoded, 5);

        if (connected) {
            ws.send(frame);
        } else {
            sendQueue.push(frame);
        }
    }

    // --- Parse a framed message from the relay ---
    function parseFrame(data) {
        var frame = new Uint8Array(data);
        var type = frame[0];
        var viewId = ((frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4]) >>> 0;
        var payload = frame.slice(5);
        return { type: type, viewId: viewId, payload: payload };
    }

    console.log('[relay] My viewId=' + myViewId);

    // --- Override FakeWebSocket.send: intercept ALL messages to WASM ---
    // This is more reliable than overriding postMobileMessage because:
    // 1. global.js EMSCRIPTENAppInitializer can overwrite postMobileMessage
    // 2. FakeWebSocket.send() is the ONLY path from JS to WASM
    function installSendInterceptor() {
        if (!globalThis.TheFakeWebSocket) {
            setTimeout(installSendInterceptor, 50);
            return;
        }
        // Override the prototype.send on the constructor
        var FWS = globalThis.TheFakeWebSocket.constructor;
        if (FWS && FWS.prototype && FWS.prototype.send) {
            var origSend = FWS.prototype.send;
            FWS.prototype.send = function(data) {
                sendToRelay(0x00, myViewId, data);
            };
            console.log('[relay] Intercepted FakeWebSocket.prototype.send');
        }
        // Also override the instance's send
        globalThis.TheFakeWebSocket.send = function(data) {
            if (typeof data === 'string' && (data.startsWith('key ') || data.startsWith('textinput '))) {
                console.log('[relay] FakeWebSocket.send intercepted: ' + data.substring(0, 80));
            }
            sendToRelay(0x00, myViewId, data);
        };
    }
    installSendInterceptor();

    // Also override postMobileMessage as fallback (some code calls it directly)
    window.postMobileMessage = function(msg) {
        sendToRelay(0x00, myViewId, msg);
    };
    window.postMobileCall = window.postMobileMessage;

    // --- Handle WASM output for remote clients ---
    // When a remote client's ClientSession in our WASM produces output,
    // send2RemoteJS calls this. We ignore it — each browser renders its own tiles.
    var remoteClientReady = {}; // viewId → true when load completes
    var remoteClientQueue = {}; // viewId → queued messages waiting for load

    globalThis.onRemoteMessage = function(clientId, data) {
        var preview = typeof data === 'string' ? data.substring(0, 80) : '(binary ' + data.byteLength + ' bytes)';
        console.log('[relay] Remote WASM output for clientId=' + clientId + ': ' + preview);
        // Detect when the remote session has finished loading
        if (typeof data === 'string' && data.startsWith('commandresult:') && data.includes('"load"') && data.includes('"success": true')) {
            // Find the viewId for this clientId
            for (var vid of remoteViewIds) {
                if (!remoteClientReady[vid]) {
                    remoteClientReady[vid] = true;
                    console.log('[relay] Remote client viewId=' + vid + ' document loaded, flushing ' + (remoteClientQueue[vid] || []).length + ' queued messages');
                    var q = remoteClientQueue[vid] || [];
                    delete remoteClientQueue[vid];
                    for (var k = 0; k < q.length; k++) {
                        Module._handle_remote_message(vid, Module.stringToNewUTF8(q[k]));
                    }
                    break;
                }
            }
        }
    };

    // --- Process a relay message (only when WASM is ready) ---
    function processRelayMessage(msg) {
        switch (msg.type) {
            case 0x00: // UI text message
                var text = new TextDecoder().decode(msg.payload);
                if (msg.viewId === myViewId) {
                    Module._handle_cool_message(Module.stringToNewUTF8(text));
                } else {
                    // Remote user's message
                    if (!coolwsdReady) {
                        recvQueue.push(msg);
                        return;
                    }
                    // Feed remote user input into LOCAL session (state machine replication)
                    if (text.startsWith('key ') || text.startsWith('mouse ') || text.startsWith('textinput ')) {
                        Module._handle_cool_message(Module.stringToNewUTF8(text));
                    }
                }
                break;

            case 0x03: // Client left
                if (msg.viewId !== myViewId && remoteViewIds.has(msg.viewId)) {
                    console.log('[relay] Remote client left: viewId=' + msg.viewId);
                    Module._close_remote_client(msg.viewId);
                    remoteViewIds.delete(msg.viewId);
                }
                break;
        }
    }

    // --- Handle messages from relay ---
    ws.onmessage = function(event) {
        var msg = parseFrame(event.data);

        // Queue everything until COOLWSD is ready
        if (!coolwsdReady) {
            recvQueue.push(msg);
            return;
        }
        processRelayMessage(msg);
    };

    ws.onopen = function() {
        connected = true;
        console.log('[relay] Connected');
        for (var i = 0; i < sendQueue.length; i++) {
            ws.send(sendQueue[i]);
        }
        sendQueue = [];
    };

    ws.onerror = function(err) {
        console.error('[relay] WebSocket error', err);
    };

    ws.onclose = function() {
        connected = false;
        console.log('[relay] Disconnected');
    };
})();
