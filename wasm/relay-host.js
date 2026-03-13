// Relay host bridge: runs in Browser A (WASM host) to connect remote clients
// via the relay server to the local COOLWSD running in WASM.

(function() {
    'use strict';

    // ---- DEBUG TRACING ----
    // Set to true to log all cursor-related message flow
    var TRACE_CURSORS = true;

    function traceLog(tag, msg) {
        if (TRACE_CURSORS) {
            console.log('[CURSOR-TRACE] ' + tag + ': ' + msg);
        }
    }

    var RelayHost = {
        relaySocket: null,
        clientMap: new Map(),
        _deferReady: false,

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
                self._enqueueIncoming(event.data);
            };

            this.relaySocket.onclose = function(event) {
                console.log('RelayHost: disconnected from relay server (code=' + event.code + ')');
                if (event.code === 4001) {
                    try { window.parent.postMessage({ type: 'relay-host-rejected' }, '*'); } catch(e) {}
                    return;
                }
                for (var [relayId, info] of self.clientMap) {
                    if (info.ready) Module._close_remote_client(info.wasmClientId);
                }
                self.clientMap.clear();
            };

            this.relaySocket.onerror = function(err) {
                console.error('RelayHost: relay socket error', err);
            };
        },

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
                this._inboxQueue.push({ seq: seq, ready: true, type: type, relayClientId: relayClientId });
                this._scheduleDrain();
                return;
            }

            if (type === 0) {
                var entry = { seq: seq, ready: false, type: 0, relayClientId: relayClientId, msg: null };
                this._inboxQueue.push(entry);

                var payload = buf.slice(5);
                globalThis.RelayCrypto.decrypt(payload.buffer).then(function(decrypted) {
                    entry.msg = typeof decrypted === 'string' ? decrypted
                        : new TextDecoder().decode(new Uint8Array(decrypted));
                    entry.ready = true;
                    self._scheduleDrain();
                }).catch(function(err) {
                    console.error('RelayHost: decrypt error:', err);
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
            if (this._inboxQueue.length > 0 && this._inboxQueue[0].ready) {
                var entry = this._inboxQueue.shift();
                this._processEntry(entry);
                if (this._inboxQueue.length > 0) this._scheduleDrain();
            }
        },

        _processEntry: function(entry) {
            if (entry.type === 1) {
                console.log('RelayHost: remote client ' + entry.relayClientId + ' connecting...');
                var wasmClientId = Module._create_remote_client();
                this.clientMap.set(entry.relayClientId, { wasmClientId: wasmClientId, ready: false, queue: [] });
                console.log('RelayHost: mapped relay client ' + entry.relayClientId + ' -> WASM client ' + wasmClientId);
                return;
            }

            if (entry.type === 2) {
                console.log('RelayHost: remote client ' + entry.relayClientId + ' disconnected');
                var info = this.clientMap.get(entry.relayClientId);
                if (info && info.ready) Module._close_remote_client(info.wasmClientId);
                this.clientMap.delete(entry.relayClientId);
                return;
            }

            if (entry.type === 0) {
                if (entry.msg === null) return;

                var info = this.clientMap.get(entry.relayClientId);
                if (!info) return;

                // Log non-noisy messages
                if (!entry.msg.startsWith('tileprocessed') &&
                    !entry.msg.startsWith('mouse ') &&
                    !entry.msg.startsWith('tilecombine')) {
                    console.log('RelayHost RECV client ' + entry.relayClientId + ': ' + entry.msg.substring(0, 80));
                }

                if (!info.ready) {
                    info.queue.push(entry.msg);
                    return;
                }

                // Trace remote typing
                if (entry.msg.startsWith('textinput ') || entry.msg.startsWith('key type=input ')) {
                    traceLog('REMOTE-TYPE', 'client ' + entry.relayClientId +
                        ' (wasm' + info.wasmClientId + '): ' + entry.msg.substring(0, 60));
                }

                var ptr = Module.stringToNewUTF8(entry.msg);
                Module._handle_remote_message(info.wasmClientId, ptr);
                Module._free(ptr);
            }
        },

        _onClientReady: function(wasmClientId) {
            for (var [relayId, info] of this.clientMap) {
                if (info.wasmClientId === wasmClientId && !info.ready) {
                    info.ready = true;
                    console.log('RelayHost: WASM client ' + wasmClientId + ' ready, flushing ' + info.queue.length + ' queued');
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

        sendToRelay: function(wasmClientId, data) {
            var self = this;
            this._sendChain = this._sendChain.then(function() {
                return self._doSendToRelay(wasmClientId, data);
            }).catch(function(err) {
                console.error('RelayHost: send chain error:', err);
            });
        },

        _doSendToRelay: async function(wasmClientId, data) {
            if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) return;

            var relayClientId = null;
            for (var [rId, info] of this.clientMap) {
                if (info.wasmClientId === wasmClientId) { relayClientId = rId; break; }
            }
            if (relayClientId === null) return;

            var encrypted = await globalThis.RelayCrypto.encrypt(data);
            var payload;
            if (encrypted instanceof ArrayBuffer) payload = new Uint8Array(encrypted);
            else if (typeof encrypted === 'string') payload = new TextEncoder().encode(encrypted);
            else payload = new Uint8Array(encrypted);

            var frame = new Uint8Array(5 + payload.length);
            frame[0] = 0;
            frame[1] = (relayClientId >> 24) & 0xff;
            frame[2] = (relayClientId >> 16) & 0xff;
            frame[3] = (relayClientId >> 8) & 0xff;
            frame[4] = relayClientId & 0xff;
            frame.set(payload, 5);
            this.relaySocket.send(frame.buffer);
        }
    };

    // ---- Message routing fix ----
    // Host is always view 0 in the WASM build.
    var HOST_VIEW_ID = '0';

    // Callback from C++ send2RemoteJS
    globalThis.onRemoteClientMessage = function(wasmClientId, data) {
        var str = typeof data === 'string' ? data : '';
        if (!str && data instanceof Uint8Array) {
            str = new TextDecoder().decode(data);
        }

        // Trace cursor messages from the remote fakeSocket
        if (str.startsWith('invalidatecursor:') || str.startsWith('invalidateviewcursor:')) {
            traceLog('FROM-REMOTE-SOCKET',
                'wasm' + wasmClientId + ' → ' + str.substring(0, 150));
        }

        // LOKit cross-contamination fix for WASM single-process build:
        // LOKit fires INVALIDATE_VISIBLE_CURSOR on the wrong view's descriptor,
        // producing invalidatecursor messages with STALE positions and swapped viewIds.
        //
        // On the remote socket:
        //   viewId=0 → cross-contaminated, has STALE position data → DROP
        //   viewId≠0 → correctly routed (e.g. from clicks) → forward as-is
        if (str.startsWith('invalidatecursor:')) {
            try {
                var json = JSON.parse(str.substring('invalidatecursor:'.length));
                if (String(json.viewId) === HOST_VIEW_ID) {
                    traceLog('DROP',
                        'invalidatecursor viewId=0 from wasm' + wasmClientId +
                        ' rect=' + json.rectangle + ' (cross-contaminated, stale)');
                    return;
                }
            } catch(e) {}
        }

        RelayHost.sendToRelay(wasmClientId, data);
    };

    globalThis.onRemoteClientReady = function(wasmClientId) {
        RelayHost._onClientReady(wasmClientId);
    };

    // ---- Trace host-side messages ----
    // Hook TheFakeWebSocket to trace cursor messages to/from host's COOL UI
    function installHostTracing() {
        var check = setInterval(function() {
            if (!window.TheFakeWebSocket) return;
            if (!window.TheFakeWebSocket.onmessage) return;

            // Intercept messages FROM COOLWSD TO host COOL UI (incoming)
            var origOnMessage = window.TheFakeWebSocket.onmessage;
            window.TheFakeWebSocket.onmessage = function(event) {
                var d = event.data;
                if (typeof d === 'string') {
                    if (d.startsWith('invalidatecursor:') || d.startsWith('invalidateviewcursor:')) {
                        traceLog('HOST-RECV', d.substring(0, 150));
                    }

                    // Drop cross-contaminated invalidatecursor with non-host viewId.
                    // These have STALE position data from the remote view and would
                    // confuse the host's cursor. Host already gets correct viewId=0.
                    if (d.startsWith('invalidatecursor:')) {
                        try {
                            var cj = JSON.parse(d.substring('invalidatecursor:'.length));
                            if (String(cj.viewId) !== HOST_VIEW_ID) {
                                traceLog('HOST-DROP',
                                    'invalidatecursor viewId=' + cj.viewId +
                                    ' (cross-contaminated, stale)');
                                return;
                            }
                        } catch(e) {}
                    }
                }
                return origOnMessage(event);
            };

            // Trace messages FROM host COOL UI TO COOLWSD (outgoing)
            if (window.TheFakeWebSocket.send) {
                var origSend = window.TheFakeWebSocket.send.bind(window.TheFakeWebSocket);
                window.TheFakeWebSocket.send = function(data) {
                    if (typeof data === 'string') {
                        if (data.startsWith('textinput ') || data.startsWith('key type=input ')) {
                            traceLog('HOST-TYPE', data.substring(0, 80));
                        }
                    }
                    return origSend(data);
                };
            }

            clearInterval(check);
            console.log('RelayHost: cursor tracing installed on TheFakeWebSocket');
        }, 200);
    }

    setTimeout(installHostTracing, 1000);

    globalThis.RelayHost = RelayHost;
})();
