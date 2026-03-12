// relay-client-boot.js: Replaces emscripten-module.js for the relay thin client.
// Instead of loading the WASM module, connects to a relay server that tunnels
// messages to/from a WASM host running in another browser.

(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var configRelay = (window.__CONFIG__ && window.__CONFIG__.relayUrl) || '';
    var defaultRelay = configRelay || 'ws://localhost:9090';
    var relayServer = params.get('relayServer') || defaultRelay;
    var relayRoom = params.get('relayRoom') || 'default';
    var relayUrl = relayServer + '/client?room=' + encodeURIComponent(relayRoom);

    var relayWs = null;
    var relayConnected = false;
    var pendingMessages = [];
    var socketOpened = false;
    var earlyMessages = []; // Messages received before socket is opened
    // Document URL derived from relay room name (room = file path)
    var hostDocUrl = 'file:///' + relayRoom;

    // Encrypt a message via RelayCrypto (if loaded and enabled)
    async function encryptMsg(msg) {
        if (globalThis.RelayCrypto) {
            return await globalThis.RelayCrypto.encrypt(msg);
        }
        return msg;
    }

    // Decrypt a message via RelayCrypto (if loaded and enabled)
    async function decryptMsg(data) {
        if (globalThis.RelayCrypto) {
            return await globalThis.RelayCrypto.decrypt(data);
        }
        return data;
    }

    // Send a message through the relay, encrypting if enabled
    async function relaySend(msg) {
        var encrypted = await encryptMsg(msg);
        if (relayConnected && relayWs && relayWs.readyState === WebSocket.OPEN) {
            relayWs.send(encrypted);
        } else {
            pendingMessages.push(encrypted);
        }
    }

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
        // Initialize encryption (no-op if no URL fragment)
        if (globalThis.RelayCrypto) {
            globalThis.RelayCrypto.init();
        }

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

        relayWs.onmessage = async function(event) {
            // Decrypt incoming data
            var raw = await decryptMsg(event.data);
            var data = decodeRelayData(raw);

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
        relaySend(msg);
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

        relaySend(coolclient);
        relaySend(loadMsg);
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
