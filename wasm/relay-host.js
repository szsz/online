// Relay host bridge: runs in Browser A (WASM host) to connect remote clients
// via the relay server to the local COOLWSD running in WASM.

(function() {
    'use strict';

    var RelayHost = {
        relaySocket: null,
        // Maps relay clientId -> { wasmClientId, ready, queue }
        clientMap: new Map(),
        _deferReady: false, // When true, don't send type=6 on connect

        // Send type=6 (host-ready) to relay — call after document is loaded
        sendReady: function() {
            if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) return;
            console.log('RelayHost: sending ready signal (type=6)');
            var readyMsg = new ArrayBuffer(5);
            var view = new Uint8Array(readyMsg);
            view[0] = 6;
            this.relaySocket.send(readyMsg);
        },

        connect: function(relayUrl) {
            console.log('RelayHost: connecting to ' + relayUrl);
            this.relaySocket = new WebSocket(relayUrl);
            this.relaySocket.binaryType = 'arraybuffer';

            var self = this;
            // Serialized promise chain to preserve message ordering across async decrypt
            this._recvChain = Promise.resolve();
            this.relaySocket.onopen = function() {
                console.log('RelayHost: connected to relay server');
                if (!self._deferReady) {
                    // Immediate mode (no emscripten-module.js orchestration)
                    self.sendReady();
                }
                // If _deferReady, emscripten-module.js will call sendReady()
                // after the document is loaded (status: received).
            };

            this.relaySocket.onmessage = function(event) {
                var data = event.data;
                self._recvChain = self._recvChain.then(function() {
                    return self._handleRelayMessage(data);
                });
            };

            this.relaySocket.onclose = function(event) {
                console.log('RelayHost: disconnected from relay server (code=' + event.code + ')');
                if (event.code === 4001) {
                    // Room already has a host — tell parent to switch to client mode
                    console.log('RelayHost: room already has a host, notifying parent');
                    try {
                        window.parent.postMessage({ type: 'relay-host-rejected' }, '*');
                    } catch(e) {}
                    return;
                }
                for (var [relayId, info] of self.clientMap) {
                    if (info.ready) {
                        Module._close_remote_client(info.wasmClientId);
                    }
                }
                self.clientMap.clear();
            };

            this.relaySocket.onerror = function(err) {
                console.error('RelayHost: relay socket error', err);
            };
        },

        _handleRelayMessage: async function(data) {
            var buf = new Uint8Array(data);
            if (buf.length < 5) return;

            var type = buf[0];
            var relayClientId = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];

            if (type === 1) {
                // New remote client connected
                console.log('RelayHost: remote client ' + relayClientId + ' connecting...');
                var wasmClientId = Module._create_remote_client();
                // Store with ready=false; messages will be queued until onRemoteClientReady fires
                this.clientMap.set(relayClientId, {
                    wasmClientId: wasmClientId,
                    ready: false,
                    queue: []
                });
                console.log('RelayHost: mapped relay client ' + relayClientId + ' -> WASM client ' + wasmClientId + ' (pending)');
                return;
            }

            if (type === 2) {
                // Remote client disconnected
                console.log('RelayHost: remote client ' + relayClientId + ' disconnected');
                var info = this.clientMap.get(relayClientId);
                if (info && info.ready) {
                    Module._close_remote_client(info.wasmClientId);
                }
                this.clientMap.delete(relayClientId);
                return;
            }

            if (type === 0) {
                // Data from remote client — decrypt if encryption enabled
                var info = this.clientMap.get(relayClientId);
                if (!info) {
                    console.warn('RelayHost: unknown relay client ' + relayClientId);
                    return;
                }

                var payload = buf.slice(5);
                var decrypted = await globalThis.RelayCrypto.decrypt(payload.buffer);
                var msg;
                if (typeof decrypted === 'string') {
                    msg = decrypted;
                } else {
                    msg = new TextDecoder().decode(new Uint8Array(decrypted));
                }

                var preview = typeof msg === 'string' ? msg.substring(0, 80) : '[binary]';
                console.log('RelayHost RECV client ' + relayClientId + ': ' + preview);

                if (!info.ready) {
                    // Client not yet connected to COOLWSD, queue the message
                    info.queue.push(msg);
                    return;
                }

                var ptr = Module.stringToNewUTF8(msg);
                Module._handle_remote_message(info.wasmClientId, ptr);
                Module._free(ptr);
            }
        },

        // Called when a remote client's fakeSocketConnect completes
        _onClientReady: function(wasmClientId) {
            for (var [relayId, info] of this.clientMap) {
                if (info.wasmClientId === wasmClientId && !info.ready) {
                    info.ready = true;
                    console.log('RelayHost: WASM client ' + wasmClientId + ' ready, flushing ' + info.queue.length + ' queued messages');
                    // Flush queued messages
                    for (var i = 0; i < info.queue.length; i++) {
                        var ptr = Module.stringToNewUTF8(info.queue[i]);
                        Module._handle_remote_message(wasmClientId, ptr);
                        Module._free(ptr);
                    }
                    info.queue = [];
                    return;
                }
            }
        },

        _sendChain: Promise.resolve(),

        // Send data from COOLWSD back to a remote client via relay
        sendToRelay: function(wasmClientId, data) {
            var self = this;
            this._sendChain = this._sendChain.then(function() {
                return self._doSendToRelay(wasmClientId, data);
            });
        },

        _doSendToRelay: async function(wasmClientId, data) {
            if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) return;

            var relayClientId = null;
            for (var [rId, info] of this.clientMap) {
                if (info.wasmClientId === wasmClientId) {
                    relayClientId = rId;
                    break;
                }
            }
            if (relayClientId === null) return;

            // Encrypt payload if encryption is enabled
            var encrypted = await globalThis.RelayCrypto.encrypt(data);
            var payload;
            if (encrypted instanceof ArrayBuffer) {
                payload = new Uint8Array(encrypted);
            } else if (typeof encrypted === 'string') {
                payload = new TextEncoder().encode(encrypted);
            } else {
                payload = new Uint8Array(encrypted);
            }

            var frame = new Uint8Array(5 + payload.length);
            frame[0] = 0; // data
            frame[1] = (relayClientId >> 24) & 0xff;
            frame[2] = (relayClientId >> 16) & 0xff;
            frame[3] = (relayClientId >> 8) & 0xff;
            frame[4] = relayClientId & 0xff;
            frame.set(payload, 5);
            this.relaySocket.send(frame.buffer);
        }
    };

    // Callback from C++ send2RemoteJS
    globalThis.onRemoteClientMessage = function(wasmClientId, data) {
        RelayHost.sendToRelay(wasmClientId, data);
    };

    // Callback from C++ when fakeSocketConnect completes for a remote client
    globalThis.onRemoteClientReady = function(wasmClientId) {
        RelayHost._onClientReady(wasmClientId);
    };

    globalThis.RelayHost = RelayHost;
})();
