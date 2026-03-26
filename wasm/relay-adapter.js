// Relay adapter for COOL WASM.
// Loaded in the browser AFTER global.js, BEFORE HULLO is sent.
// Intercepts postMobileMessage (JS→WASM) and TheFakeWebSocket.onmessage (WASM→JS)
// and routes all messages through a WebSocket relay server.
//
// Activate by adding ?relay=ws://host:port/room/id to the URL.
// Without the relay parameter, this script does nothing.

(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var relayUrl = params.get('relay');
    if (!relayUrl) return;

    console.log('[relay] Connecting to ' + relayUrl);

    var ws = new WebSocket(relayUrl);
    ws.binaryType = 'arraybuffer';

    var connected = false;
    var queue = []; // Messages queued before WebSocket connects
    var realOnMessage = null; // The real onmessage handler set by Socket.ts

    // --- Intercept JS→WASM (postMobileMessage) ---
    // Replace postMobileMessage so messages go to relay instead of directly to WASM.
    // The original is set in global.js:582 as:
    //   window.postMobileMessage = function(msg) { Module._handle_cool_message(...) }

    function sendToRelay(type, payload) {
        if (typeof payload === 'string') {
            var encoded = new TextEncoder().encode(payload);
            var frame = new Uint8Array(1 + encoded.length);
            frame[0] = type;
            frame.set(encoded, 1);
        } else {
            var binary = new Uint8Array(payload);
            var frame = new Uint8Array(1 + binary.length);
            frame[0] = type;
            frame.set(binary, 1);
        }
        if (connected) {
            ws.send(frame);
        } else {
            queue.push(frame);
        }
    }

    // Override postMobileMessage: send to relay tagged as UI text (0x00)
    window.postMobileMessage = function(msg) {
        sendToRelay(0x00, msg);
    };
    window.postMobileCall = window.postMobileMessage;

    // --- Intercept WASM→JS (TheFakeWebSocket.onmessage) ---
    // send2JS() in wasmapp.cpp calls globalThis.TheFakeWebSocket.onmessage({data})
    // We intercept this by wrapping the onmessage property with a getter/setter.
    // The getter returns our interceptor (which forwards to relay).
    // The setter captures the real handler (set by Socket.ts).

    function waitForFakeWebSocket() {
        if (!globalThis.TheFakeWebSocket) {
            setTimeout(waitForFakeWebSocket, 10);
            return;
        }
        installInterceptor();
    }

    function installInterceptor() {
        var fakeWs = globalThis.TheFakeWebSocket;

        // Intercept the onmessage property
        Object.defineProperty(fakeWs, 'onmessage', {
            configurable: true,
            set: function(fn) {
                // Socket.ts or global.js setting the real handler
                realOnMessage = fn;
                console.log('[relay] Real onmessage handler captured');
            },
            get: function() {
                // send2JS calls TheFakeWebSocket.onmessage({data})
                // Return our interceptor that forwards to the relay
                return function(event) {
                    var data = event.data;
                    if (typeof data === 'string') {
                        sendToRelay(0x01, data); // WASM text
                    } else {
                        sendToRelay(0x03, data); // WASM binary
                    }
                };
            }
        });

        console.log('[relay] Interceptor installed on TheFakeWebSocket');
    }

    // --- Handle messages from relay ---
    ws.onmessage = function(event) {
        var frame = new Uint8Array(event.data);
        var type = frame[0];
        var payload = frame.slice(1);

        if (type === 0x00) {
            // UI text relayed back → feed into WASM
            var text = new TextDecoder().decode(payload);
            Module._handle_cool_message(Module.stringToNewUTF8(text));
        } else if (type === 0x01) {
            // WASM text relayed back → feed into JS UI
            var text = new TextDecoder().decode(payload);
            if (realOnMessage) {
                realOnMessage({ data: text });
            }
        } else if (type === 0x03) {
            // WASM binary relayed back → feed into JS UI
            if (realOnMessage) {
                realOnMessage({ data: payload.buffer });
            }
        }
    };

    ws.onopen = function() {
        connected = true;
        console.log('[relay] Connected');
        // Flush queued messages
        for (var i = 0; i < queue.length; i++) {
            ws.send(queue[i]);
        }
        queue = [];
    };

    ws.onerror = function(err) {
        console.error('[relay] WebSocket error', err);
    };

    ws.onclose = function() {
        connected = false;
        console.log('[relay] Disconnected');
    };

    // Start watching for TheFakeWebSocket
    waitForFakeWebSocket();
})();
