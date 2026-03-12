// relay-client-boot.js: Replaces emscripten-module.js for the relay thin client.
// Instead of loading the WASM module, connects to a relay server that tunnels
// messages to/from a WASM host running in another browser.

(function() {
    'use strict';

    var params = new URLSearchParams(window.location.search);
    var configRelay = (window.__CONFIG__ && window.__CONFIG__.relayUrl) || '';
    var defaultRelay = configRelay || 'ws://localhost:9090';
    var relayServer = params.get('relayServer') || defaultRelay;
    // Room can be passed directly or derived from URL fragment hash
    var relayRoom = params.get('relayRoom') || 'default';
    var relayUrl = relayServer + '/client?room=' + encodeURIComponent(relayRoom);

    // Derive relay room from URL fragment via HMAC (same derivation as wasm.html)
    var relayUrlReady = Promise.resolve(relayUrl);
    var urlFragment = window.location.hash ? window.location.hash.substring(1) : '';
    if (urlFragment && relayRoom === 'default') {
        var enc = new TextEncoder();
        relayUrlReady = crypto.subtle.importKey(
            'raw', enc.encode(urlFragment), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        ).then(function(hmacKey) {
            return crypto.subtle.sign('HMAC', hmacKey, enc.encode('cool-blob'));
        }).then(function(buf) {
            var hash = Array.from(new Uint8Array(buf), function(b) { return b.toString(16).padStart(2, '0'); }).join('');
            relayRoom = hash;
            return relayServer + '/client?room=' + encodeURIComponent(hash);
        });
    }

    var relayWs = null;
    var relayConnected = false;
    var pendingMessages = [];
    var socketOpened = false;
    var earlyMessages = []; // Messages received before socket is opened
    var failoverInProgress = false; // Set when host-lost triggers failover
    // In server mode, COOLWSD always writes the fetched document to /tempdoc
    // (see wasmapp.cpp), so the fileURL is always file:///tempdoc regardless
    // of the original blob name.
    var hostDocUrl = 'file:///tempdoc';

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

    // Send a message through the relay, encrypting if enabled.
    // Serialized via promise chain to preserve message ordering.
    var sendChain = Promise.resolve();
    var sendSeq = 0;
    function relaySend(msg) {
        var seq = sendSeq++;
        var preview = typeof msg === 'string' ? msg.substring(0, 60) : '[binary ' + msg.byteLength + 'B]';
        console.log('RelayClient SEND #' + seq + ': ' + preview);
        sendChain = sendChain.then(function() {
            return encryptMsg(msg);
        }).then(function(encrypted) {
            console.log('RelayClient SEND #' + seq + ' encrypted, dispatching');
            if (relayConnected && relayWs && relayWs.readyState === WebSocket.OPEN) {
                relayWs.send(encrypted);
            } else {
                pendingMessages.push(encrypted);
            }
        });
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

        relayUrlReady.then(function(finalUrl) {
            relayUrl = finalUrl;
            _doConnect(finalUrl);
        });

        // Background preload WASM files for fast failover to host
        backgroundPreloadWasm();
    }

    function backgroundPreloadWasm() {
        if (!('caches' in window)) return;
        var cdn = (window.__CONFIG__ && window.__CONFIG__.cdnUrl) || '';
        var cdnBase = cdn ? cdn.replace(/\/+$/, '') + '/' : '/';
        var files = ['online.wasm', 'soffice.data', 'online.js'];
        var CACHE_NAME = 'cool-wasm-assets';

        caches.open(CACHE_NAME).then(function(cache) {
            files.forEach(function(file) {
                cache.match(cdnBase + file).then(function(resp) {
                    if (!resp) {
                        console.log('RelayClient: background preloading ' + file);
                        fetch(cdnBase + file).then(function(r) {
                            if (r.ok) {
                                var ct = file.endsWith('.wasm') ? 'application/wasm'
                                       : file.endsWith('.js') ? 'application/javascript'
                                       : 'application/octet-stream';
                                r.arrayBuffer().then(function(buf) {
                                    var cached = new Response(buf, {
                                        headers: { 'Content-Type': ct, 'Content-Length': buf.byteLength.toString() }
                                    });
                                    cache.put(cdnBase + file, cached);
                                    console.log('RelayClient: preloaded ' + file + ' (' + buf.byteLength + ' bytes)');
                                });
                            }
                        }).catch(function() {});
                    } else {
                        console.log('RelayClient: ' + file + ' already cached');
                    }
                });
            });
        }).catch(function() {});
    }

    function _doConnect(url) {
        console.log('RelayClient: connecting to ' + url);
        relayWs = new WebSocket(url);
        relayWs.binaryType = 'arraybuffer';

        relayWs.onopen = function() {
            console.log('RelayClient: connected to relay server');
            relayConnected = true;
            for (var i = 0; i < pendingMessages.length; i++) {
                relayWs.send(pendingMessages[i]);
            }
            pendingMessages = [];
        };

        var recvChain = Promise.resolve();
        var recvSeq = 0;
        relayWs.onmessage = function(event) {
            var eventData = event.data;
            var seq = recvSeq++;
            recvChain = recvChain.then(async function() {
            // Check for server control messages (exactly 5 bytes, type 3 or 4)
            if (eventData instanceof ArrayBuffer && eventData.byteLength === 5) {
                var ctrl = new Uint8Array(eventData);
                if (ctrl[0] === 3) {
                    console.log('RelayClient: host lost, triggering failover');
                    failoverInProgress = true;
                    // Close relay WS — onclose will be suppressed by failover flag
                    try { relayWs.close(); } catch(e) {}
                    // Notify parent to reload and re-run role selection
                    try {
                        window.parent.postMessage({ type: 'relay-host-lost' }, '*');
                    } catch(e) {}
                    return;
                }
                if (ctrl[0] === 4 || ctrl[0] === 5) {
                    failoverInProgress = true; // Suppress COOL reconnect on close
                }
                if (ctrl[0] === 4) {
                    console.log('RelayClient: host restored, notifying parent to reconnect');
                    try {
                        window.parent.postMessage({ type: 'relay-host-restored' }, '*');
                    } catch(e) {}
                    try { relayWs.close(); } catch(e) {}
                    return;
                }
                if (ctrl[0] === 5) {
                    console.log('RelayClient: wait-for-new-host (another client is taking over)');
                    try {
                        window.parent.postMessage({ type: 'relay-wait-for-host' }, '*');
                    } catch(e) {}
                    return;
                }
            }
            // Decrypt incoming data
            var raw = await decryptMsg(eventData);
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
            }); // end recvChain
        };

        relayWs.onclose = function(event) {
            console.log('RelayClient: relay connection closed (failover=' + failoverInProgress + ', code=' + event.code + ')');
            relayConnected = false;
            // Code 4004 = server kicked us for reconnection to new host
            if (event.code === 4004) {
                failoverInProgress = true;
                try {
                    window.parent.postMessage({ type: 'relay-host-restored' }, '*');
                } catch(e) {}
                return;
            }
            if (failoverInProgress) {
                // Don't trigger COOL's reconnect — parent is reloading for failover
                return;
            }
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
