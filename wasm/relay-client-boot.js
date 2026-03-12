// relay-client-boot.js: Replaces emscripten-module.js for the relay thin client.
// Instead of loading the WASM module, connects to a relay server that tunnels
// messages to/from a WASM host running in another browser.

(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var relayServer = params.get('relayServer') || 'ws://localhost:9090';
    var relayRoom = params.get('relayRoom') || 'default';
    var relayUrl = relayServer + '/client?room=' + encodeURIComponent(relayRoom);

    var relayWs = null;
    var relayConnected = false;
    var pendingMessages = [];
    var socketOpened = false;
    var earlyMessages = []; // Messages received before socket is opened
    // Document URL derived from relay room name (room = file path)
    var hostDocUrl = 'file:///' + relayRoom;

    function decodeRelayData(data) {
        if (data instanceof ArrayBuffer) {
            var bytes = new Uint8Array(data);
            var hasNewline = false;
            for (var i = 0; i < bytes.length; i++) {
                if (bytes[i] === 0x0A) { hasNewline = true; break; }
            }
            return hasNewline ? bytes : new TextDecoder().decode(bytes);
        }
        return data;
    }

    function tryOpenSocket() {
        if (socketOpened) return;
        socketOpened = true;

        var sock = window.TheFakeWebSocket;
        if (sock) {
            sock.readyState = 1; // OPEN
            console.log('RelayClient: triggering socket.onopen (status received)');
            if (sock.onopen) sock.onopen();

            // Deliver any messages that arrived before socket was opened
            for (var i = 0; i < earlyMessages.length; i++) {
                if (sock.onmessage) {
                    sock.onmessage({ data: earlyMessages[i] });
                }
            }
            earlyMessages = [];
        }
    }

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
            var data = decodeRelayData(event.data);

            if (!socketOpened) {
                // Check for 'status:' which means doc is loaded for our session
                if (typeof data === 'string' && data.startsWith('status:')) {
                    console.log('RelayClient: received status, opening socket');
                    tryOpenSocket();
                    if (window.TheFakeWebSocket && window.TheFakeWebSocket.onmessage) {
                        window.TheFakeWebSocket.onmessage({ data: data });
                    }
                    return;
                }
                // Queue messages that arrive before socket is opened,
                // but drop nodocloaded errors (race between load and commands)
                if (typeof data === 'string' && data.indexOf('nodocloaded') !== -1) {
                    return;
                }
                earlyMessages.push(data);
                return;
            }

            // Suppress transient 'nodocloaded' errors — these are a race condition
            // where commands arrive at COOLWSD before the Kit's "loaded" message is
            // fully processed. The commands will succeed on subsequent requests.
            if (typeof data === 'string' && data.indexOf('nodocloaded') !== -1) {
                console.log('RelayClient: suppressing nodocloaded error:', data.substring(0, 60));
                return;
            }

            if (window.TheFakeWebSocket && window.TheFakeWebSocket.onmessage) {
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
    // We track whether coolclient+load were already sent manually (before onopen)
    // to avoid sending duplicates when the COOL JS client fires them again.
    var initSent = false;
    window.postMobileMessage = function(msg) {
        if (initSent) {
            // Drop duplicate coolclient/load that the COOL JS client sends on onopen
            if (typeof msg === 'string' &&
                (msg.startsWith('coolclient ') || msg.startsWith('load url='))) {
                console.log('RelayClient: dropping duplicate init message:', msg.substring(0, 60));
                return;
            }
        }
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

    // Send coolclient + load url via relay. The document URL is derived
    // from the relay room name (room = file path on the WASM host).
    function sendInitMessages() {
        if (initSent) return;
        initSent = true;

        var now = Date.now();
        var perf = performance.now();
        var coolclient = 'coolclient 0.1 ' + now + ' ' + perf;
        var loadMsg = 'load url=' + encodeURIComponent(hostDocUrl)
            + ' lang=en-US deviceFormFactor=desktop'
            + ' accessibilityState=false';

        console.log('RelayClient: sending coolclient + load via relay (url=' + hostDocUrl + ')');

        if (relayConnected) {
            relayWs.send(coolclient);
            relayWs.send(loadMsg);
        } else {
            pendingMessages.push(coolclient);
            pendingMessages.push(loadMsg);
        }
    }

    // createOnlineModule: connect relay, send initial handshake, wait for
    // 'status:' from COOLWSD before opening the socket to the COOL JS client.
    window.createOnlineModule = function(module) {
        connectRelay();

        // Trigger onRuntimeInitialized to set up the map/socket objects.
        setTimeout(function() {
            console.log('RelayClient: triggering onRuntimeInitialized');
            if (module.onRuntimeInitialized) {
                module.onRuntimeInitialized();
            }

            // Send coolclient + load with URL derived from room name
            sendInitMessages();

            // Fallback: if no status message arrives within 30s, open anyway
            setTimeout(function() {
                if (!socketOpened) {
                    console.warn('RelayClient: no status received after 30s, opening socket anyway');
                    tryOpenSocket();
                }
            }, 30000);
        }, 500);
    };
})();
