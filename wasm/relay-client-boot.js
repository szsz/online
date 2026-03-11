// relay-client-boot.js: Replaces emscripten-module.js for the relay thin client.
// Instead of loading the WASM module, connects to a relay server that tunnels
// messages to/from a WASM host running in another browser.

(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var relayServer = params.get('relayServer') || 'ws://localhost:9090';
    var relayRoom = params.get('relayRoom') || 'default';
    var relayUrl = relayServer + '/client?room=' + relayRoom;

    var relayWs = null;
    var relayConnected = false;
    var pendingMessages = [];

    function connectRelay() {
        console.log('RelayClient: connecting to ' + relayUrl);
        relayWs = new WebSocket(relayUrl);
        relayWs.binaryType = 'arraybuffer';

        relayWs.onopen = function() {
            console.log('RelayClient: connected to relay server');
            relayConnected = true;
            for (var i = 0; i < pendingMessages.length; i++) {
                relayWs.send(pendingMessages[i]);
            }
            pendingMessages = [];
        };

        relayWs.onmessage = function(event) {
            if (window.TheFakeWebSocket && window.TheFakeWebSocket.onmessage) {
                var data = event.data;
                if (data instanceof ArrayBuffer) {
                    var bytes = new Uint8Array(data);
                    // Match send2JS logic: single-line (no newline) = text string,
                    // multi-line (has newline) = binary Uint8Array (tiles, deltas, etc.)
                    var hasNewline = false;
                    for (var i = 0; i < bytes.length; i++) {
                        if (bytes[i] === 0x0A) { hasNewline = true; break; }
                    }
                    data = hasNewline ? bytes : new TextDecoder().decode(bytes);
                }
                window.TheFakeWebSocket.onmessage({ data: data });
            }
        };

        relayWs.onclose = function() {
            console.log('RelayClient: relay connection closed');
            relayConnected = false;
            if (window.TheFakeWebSocket && window.TheFakeWebSocket.onclose) {
                window.TheFakeWebSocket.onclose();
            }
        };

        relayWs.onerror = function(err) {
            console.error('RelayClient: relay error', err);
        };
    }

    // Override postMobileMessage: send through relay instead of WASM Module.
    window.postMobileMessage = function(msg) {
        if (relayConnected && relayWs && relayWs.readyState === WebSocket.OPEN) {
            relayWs.send(msg);
        } else {
            console.log('RelayClient: queuing message (relay not ready):', msg.substring(0, 80));
            pendingMessages.push(msg);
        }
    };
    window.postMobileCall = window.postMobileMessage;

    // Stub createEmscriptenModule so main.js doesn't crash.
    window.createEmscriptenModule = function(docKind, docDesc) {
        return {
            onRuntimeInitialized: null,
            uno_scripts: []
        };
    };

    // createOnlineModule: connect relay, then trigger COOL initialization.
    window.createOnlineModule = function(module) {
        connectRelay();

        // Give the relay time to connect and the Kit time to create the view.
        // The C++ create_remote_client sends fileURL to COOLWSD which starts
        // session creation. We need the Kit to finish before we send commands.
        setTimeout(function() {
            console.log('RelayClient: triggering onRuntimeInitialized');
            if (module.onRuntimeInitialized) {
                module.onRuntimeInitialized();
            }

            var sock = window.TheFakeWebSocket;
            if (sock) {
                sock.readyState = 1; // OPEN
                console.log('RelayClient: triggering socket.onopen');
                if (sock.onopen) sock.onopen();
            }
        }, 2000); // 2 second delay for Kit to finish view creation
    };
})();
