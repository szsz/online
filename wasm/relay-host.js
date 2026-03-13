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
            // Reset state on (re)connect
            this._sendChain = Promise.resolve();
            this._inboxQueue = [];
            this._drainScheduled = false;

            this.relaySocket.onopen = function() {
                console.log('RelayHost: connected to relay server');
                if (!self._deferReady) {
                    self.sendReady();
                }
            };

            this.relaySocket.onmessage = function(event) {
                var data = event.data;
                self._enqueueIncoming(data);
            };

            this.relaySocket.onclose = function(event) {
                console.log('RelayHost: disconnected from relay server (code=' + event.code + ')');
                if (event.code === 4001) {
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

        // Incoming message pipeline:
        // 1. _enqueueIncoming: decrypt asynchronously, push {seq, type, ...} to _inboxQueue
        // 2. _scheduleDrain: schedule a macrotask (setTimeout) to process the queue
        // 3. _drainInbox: process all ready messages synchronously from the front
        //
        // This ensures Module._handle_remote_message (C++ call) happens in a clean
        // macrotask context rather than inside a promise microtask, avoiding
        // Emscripten threading issues with mutex contention on the main thread.

        _inboxSeq: 0,
        _inboxQueue: [],
        _drainScheduled: false,

        _enqueueIncoming: function(data) {
            var self = this;
            var seq = this._inboxSeq++;
            var buf = new Uint8Array(data);
            if (buf.length < 5) return;

            var type = buf[0];
            var relayClientId = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];

            if (type === 1 || type === 2) {
                // Control messages: no decryption needed, process immediately
                this._inboxQueue.push({ seq: seq, ready: true, type: type, relayClientId: relayClientId });
                this._scheduleDrain();
                return;
            }

            if (type === 0) {
                // Data message: decrypt asynchronously, mark ready when done
                var entry = { seq: seq, ready: false, type: 0, relayClientId: relayClientId, msg: null };
                this._inboxQueue.push(entry);

                var payload = buf.slice(5);
                globalThis.RelayCrypto.decrypt(payload.buffer).then(function(decrypted) {
                    var msg;
                    if (typeof decrypted === 'string') {
                        msg = decrypted;
                    } else {
                        msg = new TextDecoder().decode(new Uint8Array(decrypted));
                    }
                    entry.msg = msg;
                    entry.ready = true;
                    self._scheduleDrain();
                }).catch(function(err) {
                    console.error('RelayHost: decrypt error, dropping message:', err);
                    // Mark ready with null msg so drain skips it and continues
                    entry.msg = null;
                    entry.ready = true;
                    self._scheduleDrain();
                });
            }
        },

        _scheduleDrain: function() {
            if (this._drainScheduled) return;
            this._drainScheduled = true;
            var self = this;
            setTimeout(function() {
                self._drainScheduled = false;
                self._drainInbox();
            }, 0);
        },

        _drainInbox: function() {
            // Process ONE message per event-loop iteration, then yield.
            if (this._inboxQueue.length > 0 && this._inboxQueue[0].ready) {
                var entry = this._inboxQueue.shift();
                this._processEntry(entry);
                // Re-schedule if more messages are waiting
                if (this._inboxQueue.length > 0) {
                    this._scheduleDrain();
                }
            }
        },

        _processEntry: function(entry) {
            if (entry.type === 1) {
                // New remote client connected
                console.log('RelayHost: remote client ' + entry.relayClientId + ' connecting...');
                var wasmClientId = Module._create_remote_client();
                this.clientMap.set(entry.relayClientId, {
                    wasmClientId: wasmClientId,
                    ready: false,
                    queue: []
                });
                console.log('RelayHost: mapped relay client ' + entry.relayClientId + ' -> WASM client ' + wasmClientId + ' (pending)');
                return;
            }

            if (entry.type === 2) {
                // Remote client disconnected
                console.log('RelayHost: remote client ' + entry.relayClientId + ' disconnected');
                var info = this.clientMap.get(entry.relayClientId);
                if (info && info.ready) {
                    Module._close_remote_client(info.wasmClientId);
                }
                this.clientMap.delete(entry.relayClientId);
                return;
            }

            if (entry.type === 0) {
                if (entry.msg === null) return; // decrypt failed, skip

                var info = this.clientMap.get(entry.relayClientId);
                if (!info) {
                    console.warn('RelayHost: unknown relay client ' + entry.relayClientId);
                    return;
                }

                var preview = entry.msg.substring(0, 80);
                // Skip noisy messages
                if (!entry.msg.startsWith('tileprocessed') &&
                    !entry.msg.startsWith('mouse ') &&
                    !entry.msg.startsWith('tilecombine')) {
                    console.log('RelayHost RECV client ' + entry.relayClientId + ': ' + preview);
                }

                if (!info.ready) {
                    info.queue.push(entry.msg);
                    return;
                }

                // Track typing for cursor correction
                if (entry.msg.startsWith('textinput id=') ||
                    (entry.msg.startsWith('key type=input ') && entry.msg.indexOf('char=') !== -1)) {
                    globalThis._markClientTyped(info.wasmClientId);
                }

                // Convert textinput to key events to bypass postWindowExtTextInputEvent
                // which has a window ID bug in multi-view WASM builds.
                if (entry.msg.startsWith('textinput id=')) {
                    var match = entry.msg.match(/^textinput id=\d+ text=(.+)$/);
                    if (match) {
                        var text = decodeURIComponent(match[1]);
                        for (var i = 0; i < text.length; i++) {
                            var keyMsg = 'key type=input char=' + text.charCodeAt(i) + ' key=0';
                            var ptr = Module.stringToNewUTF8(keyMsg);
                            Module._handle_remote_message(info.wasmClientId, ptr);
                            Module._free(ptr);
                            var keyUp = 'key type=up char=0 key=0';
                            ptr = Module.stringToNewUTF8(keyUp);
                            Module._handle_remote_message(info.wasmClientId, ptr);
                            Module._free(ptr);
                        }
                        return;
                    }
                }

                var ptr = Module.stringToNewUTF8(entry.msg);
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
            }).catch(function(err) {
                console.error('RelayHost: send chain error, recovering:', err);
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

    // Per-wasmClient cursor tracking for backwards-cursor fix
    // { wasmClientId: { x, y, justTyped } }
    var _clientCursorState = {};

    function fixCursorIfBackwards(state, json) {
        if (!state || !state.justTyped) return false;
        state.justTyped = false;
        var rect = json.rectangle;
        if (!rect) return false;
        var parts = rect.split(',').map(function(s) { return parseInt(s.trim(), 10); });
        if (parts.length < 2) return false;
        var newX = parts[0], newY = parts[1];
        // Only fix if same line (y unchanged) and x went backwards
        if (newY === state.y && newX < state.x) {
            var delta = state.x - newX;
            var correctedX = state.x + delta;
            parts[0] = correctedX;
            json.rectangle = parts.join(', ');
            console.log('CURSOR FIX: x ' + newX + ' → ' + correctedX + ' (was backwards by ' + delta + ')');
            state.x = correctedX;
            state.y = newY;
            return true;
        }
        state.x = newX;
        state.y = newY;
        return false;
    }

    // Callback from C++ send2RemoteJS
    globalThis.onRemoteClientMessage = function(wasmClientId, data) {
        var str = typeof data === 'string' ? data : '';
        if (!str && data instanceof Uint8Array) {
            str = new TextDecoder().decode(data);
        }

        // Fix backwards cursor positions for remote clients and handle misrouting
        if (str && str.startsWith('invalidatecursor:')) {
            try {
                var json = JSON.parse(str.substring('invalidatecursor:'.length));
                var msgViewId = String(json.viewId);

                // Re-route misrouted invalidatecursor with host's viewId to host
                if (globalThis._hostViewId !== null && msgViewId === String(globalThis._hostViewId)) {
                    console.log('RelayHost: REROUTING invalidatecursor viewId=' + msgViewId + ' from wasm' + wasmClientId + ' to HOST');
                    // Apply cursor fix for host before delivering
                    var hostState = globalThis._hostCursorState;
                    if (hostState) {
                        fixCursorIfBackwards(hostState, json);
                    }
                    var fixedStr = 'invalidatecursor: ' + JSON.stringify(json);
                    if (window.TheFakeWebSocket && window.TheFakeWebSocket.onmessage) {
                        window.TheFakeWebSocket.onmessage({ data: fixedStr });
                    }
                    return;
                }

                // Apply cursor fix for this client
                var state = _clientCursorState[wasmClientId];
                if (state) {
                    if (fixCursorIfBackwards(state, json)) {
                        str = 'invalidatecursor: ' + JSON.stringify(json);
                        data = str;
                    } else {
                        // Update state from cursor position
                        var rect = json.rectangle;
                        if (rect) {
                            var parts = rect.split(',').map(function(s) { return parseInt(s.trim(), 10); });
                            if (parts.length >= 2) {
                                state.x = parts[0];
                                state.y = parts[1];
                            }
                        }
                    }
                }
            } catch(e) {}
            console.log('RelayHost SEND→wasm' + wasmClientId + ': ' + str.substring(0, 120));
        }

        // Also fix invalidateviewcursor going to other clients (so all views see correct pos)
        if (str && str.startsWith('invalidateviewcursor:')) {
            try {
                var json = JSON.parse(str.substring('invalidateviewcursor:'.length));
                // Find the cursor state for the view that typed
                var srcViewId = String(json.viewId);
                // Check all client states to find who owns this viewId
                for (var cid in _clientCursorState) {
                    var s = _clientCursorState[cid];
                    if (s && s.viewId === srcViewId && s.lastFixedX !== undefined) {
                        var rect = json.rectangle;
                        if (rect) {
                            var parts = rect.split(',').map(function(p) { return parseInt(p.trim(), 10); });
                            if (parts.length >= 2 && parts[0] !== s.lastFixedX) {
                                // Update viewcursor to match the fixed position
                                parts[0] = s.lastFixedX;
                                json.rectangle = parts.join(', ');
                                str = 'invalidateviewcursor: ' + JSON.stringify(json);
                                data = str;
                            }
                        }
                        break;
                    }
                }
            } catch(e) {}
        }

        RelayHost.sendToRelay(wasmClientId, data);
    };

    // Mark typing state when relay-host processes a typing event
    globalThis._markClientTyped = function(wasmClientId, viewId) {
        if (!_clientCursorState[wasmClientId]) {
            _clientCursorState[wasmClientId] = { x: 0, y: 0, justTyped: false, viewId: null };
        }
        _clientCursorState[wasmClientId].justTyped = true;
        if (viewId !== undefined) {
            _clientCursorState[wasmClientId].viewId = viewId;
        }
    };

    // Callback from C++ when fakeSocketConnect completes for a remote client
    globalThis.onRemoteClientReady = function(wasmClientId) {
        RelayHost._onClientReady(wasmClientId);
    };

    globalThis.RelayHost = RelayHost;
})();
