// Strict-ordering relay adapter for COOL WASM co-editing.
// Guarantees zero divergence: all browsers apply events in the same order.
//
// Protocol:
//   - All user input (key, mouse, textinput) goes through the relay
//   - Relay assigns monotonic sequence numbers to every broadcast
//   - This client processes messages strictly in seq order
//   - Late join: download state file from relay, replay buffered messages, then activate
//   - Client cannot send until fully synced (join-ready sent and acknowledged)
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
    var coolwsdReady = false;
    var activated = false;       // true after join-ready acknowledged
    var sendQueue = [];
    var recvQueue = [];          // messages received before COOLWSD ready
    var myViewId = Math.floor(Math.random() * 0x7FFFFF);
    var lastSeq = 0;             // last processed sequence number
    var joinFileHash = null;
    var joinFileSeq = 0;         // seq# of the base state we downloaded
    var isFirstClient = false;

    var remoteClients = {};

    // --- Room switching (for hot-switch document changes) ---
    // When the viewer switches documents via hash change, it sends a
    // RelaySwitchRoom message. We disconnect from the old room and
    // connect to the new one, preserving the WASM runtime.
    window.addEventListener('message', function(event) {
        try {
            var msg = typeof event.data === 'string' ? JSON.parse(event.data) : null;
            if (!msg || msg.MessageId !== 'RelaySwitchRoom') return;
            var newRoom = msg.Values.room;
            var newDoc = msg.Values.docName;
            console.log('[relay] Room switch: ' + relayUrl + ' → ' + newRoom);

            // Close old connection — null ALL handlers to prevent stale
            // messages from being processed against the new room's state
            if (ws) {
                ws.onmessage = null;
                ws.onopen = null;
                ws.onclose = null;
                ws.onerror = null;
                if (ws.readyState <= 1) ws.close();
            }

            // Reset state for new room
            connected = false;
            activated = false;
            isFirstClient = false;
            joinFileHash = null;
            joinFileSeq = 0;
            lastSeq = 0;
            sendQueue = [];
            recvQueue = [];
            kitQueue = []; // drop any pending messages from old room
            lateJoinFileReady = false;
            // Keep remoteClients — they'll be cleaned up when new room announces joins
            for (var vid in remoteClients) {
                if (remoteClients[vid].clientId > 0) {
                    try { Module._close_remote_client(remoteClients[vid].clientId); } catch(e) {}
                }
            }
            remoteClients = {};

            // Connect to new room
            relayUrl = newRoom;
            ws = new WebSocket(newRoom);
            ws.binaryType = 'arraybuffer';
            ws.onopen = onWsOpen;
            ws.onmessage = onWsMessage;
            ws.onerror = function(err) { console.error('[relay] WebSocket error', err); };
            ws.onclose = function() { connected = false; console.log('[relay] Disconnected'); };

            console.log('[relay] Connecting to new room: ' + newRoom);

            // Restart the activation polling — it self-cleared when we
            // activated in the previous room. For hot-switch late join,
            // coolwsdReady is already true (prewarm), so activation needs
            // to happen as soon as we know we can join.
            startActivationPoll();
        } catch(e) {}
    });

    // --- Relay framing ---
    function sendToRelay(type, viewId, payload) {
        var encoded = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload || []);
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
        if (f.length < 5) return null;
        return {
            type: f[0],
            viewId: ((f[1] << 24) | (f[2] << 16) | (f[3] << 8) | f[4]) >>> 0,
            payload: f.slice(5)
        };
    }

    console.log('[relay] My viewId=' + myViewId);

    // --- Intercept document fetch for late-join file redirect ---
    var lateJoinFileReady = false;
    var origFetch = window.fetch;

    // --- Send message to Kit via local session ---
    // Send directly to Kit C++ via Module._handle_cool_message.
    // This bypasses FakeWebSocket.send (which is intercepted by us) and
    // postMobileMessage (which might be overridden). Direct C++ call.
    var originalSend = null; // set in installSendInterceptor
    // Send a message to the Kit. Called for:
    //  - Non-user-input from COOL JS (tileprocessed, clientzoom, etc.)
    //    → must be synchronous, COOL JS expects immediate processing
    //  - Relay echo of own messages (from processUIMessage)
    //    → also synchronous to maintain Kit's event ordering
    var kitQueue = [];
    function sendToKit(data) {
        // Queue and process ONE message per event loop tick. The Kit worker
        // responds via MAIN_THREAD_EM_ASM which needs the main thread idle.
        // Processing multiple messages in a tight loop starves the Kit's
        // response delivery.
        kitQueue.push(data);
        if (kitQueue.length === 1) {
            setTimeout(processOneKitMessage, 0);
        }
    }
    function processOneKitMessage() {
        if (kitQueue.length === 0) return;
        var msg = kitQueue.shift();
        if (globalThis.postMobileMessage) {
            if (typeof msg === 'string' && msg.startsWith('key ')) {
                console.log('[relay] Kit←relay: ' + msg.substring(0, 50));
            }
            // Set guard flag so the postMobileMessage wrapper doesn't
            // re-intercept relay echoes delivered to Kit (which would
            // cause an insertfile → relay → self → Kit → relay loop).
            globalThis._deliveringToKit = true;
            try { globalThis.postMobileMessage(msg); }
            finally { globalThis._deliveringToKit = false; }
        } else {
            console.error('[relay] NO postMobileMessage!');
        }
        if (kitQueue.length > 0) {
            setTimeout(processOneKitMessage, 1);
        }
    }

    // --- Join protocol: request to join as soon as relay connects ---
    function initiateJoin() {
        var wopiSrc = params.get('WOPISrc') || '';
        console.log('[relay] Sending join-request (WOPISrc=' + wopiSrc + ')');
        sendToRelay(0x04, myViewId, wopiSrc);
    }

    // --- COOLWSD readiness: poll for document loaded ---
    function waitForCoolwsd() {
        if (coolwsdReady) return;

        var fws = globalThis.TheFakeWebSocket;
        if (!fws) { setTimeout(waitForCoolwsd, 100); return; }

        // Writer: StateWordCount has "word"
        var statusEl = document.querySelector('#StateWordCount');
        var writerReady = statusEl && statusEl.textContent && statusEl.textContent.includes('word');
        // Calc: StatusDocPos has "Sheet"
        var calcEl = document.querySelector('#StatusDocPos');
        var calcReady = calcEl && calcEl.textContent && calcEl.textContent.includes('Sheet');
        // Impress: Slide Show menu
        var impressReady = false;
        var navEl = document.querySelector('nav.main-nav') || document.querySelector('#content-keeper');
        if (navEl && navEl.textContent && navEl.textContent.includes('Slide Show')) {
            impressReady = true;
        }

        if (!writerReady && !calcReady && !impressReady) {
            setTimeout(waitForCoolwsd, 200);
            return;
        }

        coolwsdReady = true;
        console.log('[relay] COOLWSD ready (document loaded)');
        installSendInterceptor();

        // Flush queued relay messages
        var pending = recvQueue.splice(0);
        console.log('[relay] Flushing ' + pending.length + ' queued relay messages');
        for (var i = 0; i < pending.length; i++) {
            processRelayMessage(pending[i]);
        }

        // If first client or already got join-response, activate now
        if (isFirstClient && !activated) {
            activateClient();
        }
    }
    setTimeout(waitForCoolwsd, 500);

    // --- Activate: send join-ready and start accepting/sending messages ---
    function activateClient() {
        if (activated) return;
        activated = true;
        // Send join-ready with the SHA-256 hex of the document we loaded.
        // Truncate the log preview so a 64-char hash doesn't drown the console.
        var readyPayload = joinFileHash ? JSON.stringify({ hash: joinFileHash }) : '';
        var hashPreview = joinFileHash ? joinFileHash.substring(0, 16) + '…' : 'none';
        console.log('[relay] Activating — sending join-ready hash=' + hashPreview);
        sendToRelay(0x06, myViewId, readyPayload);

        // Tell the parent viewer that input is now accepted. Until this
        // fires the viewer keeps its loading shield up — otherwise the
        // user would see the document but typing would silently disappear
        // ("Dropping input not activated yet").
        try {
            parent.postMessage(JSON.stringify({
                MessageId: 'RelayActivated',
                Values: { viewId: myViewId, isFirstClient: isFirstClient }
            }), '*');
        } catch(e) {}

        // Announce presence
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);

        // Initial save to relay so future late joiners can get the document
        saveAndUploadCheckpoint();
    }

    // --- FakeWebSocket.send interceptor ---
    function installSendInterceptor() {
        var fws = globalThis.TheFakeWebSocket;
        if (!fws) {
            console.log('[relay] TheFakeWebSocket not found — retrying installSendInterceptor');
            setTimeout(installSendInterceptor, 200);
            return;
        }

        // Save original send BEFORE replacing — sendToKit uses this to
        // bypass the relay and talk directly to the Kit's FakeSocket.
        originalSend = fws.send.bind(fws);

        function interceptedSend(data) {
            // Binary paste (Blob): COOL's _pasteTypedBlob sends
            //   `paste mimetype=image/png\n<binary>` as a Blob via
            //   app.socket.sendMessage.
            //
            // The WASM Kit does NOT process the `paste mimetype=…`
            // protocol message (ChildSession::paste is not wired up).
            // So we convert into the paths that DO work:
            //   - image/* → `insertfile name=clipboard.png type=graphic data=<base64>`
            //     (via postMobileMessage, same as the toolbar Insert Image path)
            //   - text/html → extract plain text, feed through `textinput`
            //   - text/plain → feed through `textinput`
            //
            // The converted message also goes through the relay so peers
            // see the paste.
            if (data instanceof Blob) {
                data.arrayBuffer().then(function(ab) {
                    var bytes = new Uint8Array(ab);
                    // Parse the header: "paste mimetype=<type>\n"
                    var nlIdx = -1;
                    for (var i = 0; i < Math.min(200, bytes.length); i++) {
                        if (bytes[i] === 0x0A) { nlIdx = i; break; }
                    }
                    if (nlIdx < 0) {
                        // Not a recognized paste blob — drop it. Everything
                        // must go through the relay, and we can't relay raw
                        // binary without a protocol for it.
                        console.log('[relay] Blob without newline header — dropping (' + bytes.length + 'B)');
                        return;
                    }
                    var header = new TextDecoder().decode(bytes.slice(0, nlIdx));
                    var mimeMatch = header.match(/^paste mimetype=(.+)/);
                    if (!mimeMatch) {
                        console.log('[relay] Blob with unrecognized header "' + header.substring(0, 40) + '" — dropping');
                        return;
                    }
                    var mime = mimeMatch[1].trim();
                    var payload = bytes.slice(nlIdx + 1);
                    console.log('[relay] Paste blob: mimetype=' + mime + ' payload=' + payload.length + 'B');

                    if (mime.startsWith('image/')) {
                        // Convert to insertfile (the path that works in WASM).
                        var b64 = '';
                        var CHUNK = 32768;
                        for (var ci = 0; ci < payload.length; ci += CHUNK) {
                            b64 += String.fromCharCode.apply(null, payload.slice(ci, Math.min(ci + CHUNK, payload.length)));
                        }
                        b64 = btoa(b64);
                        var ext = mime.split('/')[1] || 'png';
                        var msg = 'insertfile name=clipboard-paste.' + ext + ' type=graphic data=' + b64;
                        console.log('[relay] Converting image paste → insertfile (' + msg.length + ' chars)');
                        // RELAY ONLY — local Kit gets it via the echo
                        // (processUIMessage → sendToKit). No direct delivery.
                        if (activated) sendToRelay(0x00, myViewId, msg);
                    } else if (mime.startsWith('text/html')) {
                        // Extract visible text from HTML and paste as textinput.
                        var html = new TextDecoder().decode(payload);
                        var tmp = document.createElement('div');
                        tmp.innerHTML = html;
                        var plainText = (tmp.textContent || tmp.innerText || '').trim();
                        console.log('[relay] Converting HTML paste → textinput (' + plainText.length + ' chars)');
                        if (plainText && activated) {
                            // Send through relay ONLY. The relay echo comes back
                            // to processUIMessage which delivers to local Kit
                            // via sendToKit (char-by-char key events). We must
                            // NOT also deliver locally here — that would double
                            // the text (local + echo).
                            sendToRelay(0x00, myViewId, 'textinput id=0 text=' + plainText);
                        }
                    } else if (mime.startsWith('text/plain')) {
                        var plainTxt = new TextDecoder().decode(payload).trim();
                        console.log('[relay] Converting plain-text paste → textinput (' + plainTxt.length + ' chars)');
                        if (plainTxt && activated) {
                            sendToRelay(0x00, myViewId, 'textinput id=0 text=' + plainTxt);
                        }
                    } else {
                        // Unknown mimetype — try the text extraction path
                        // as a best-effort. If it has readable text, relay
                        // it as textinput. Otherwise drop (we can't relay
                        // raw binary via the text protocol).
                        console.log('[relay] Unknown paste mimetype "' + mime + '" — attempting text extraction');
                        try {
                            var unknownText = new TextDecoder().decode(payload).trim();
                            if (unknownText && activated) {
                                sendToRelay(0x00, myViewId, 'textinput id=0 text=' + unknownText);
                            }
                        } catch(e) {
                            console.log('[relay] Could not extract text from unknown paste — dropping');
                        }
                    }
                });
                return;
            }

            var text = typeof data === 'string' ? data : '';
            // User-input prefixes that MUST go through the relay so all
            // peers see the same edit. Adding any new doc-mutating prefix
            // here is a NORMAL co-edit fix; missing one means the action
            // works locally for the actor but is invisible to peers (the
            // class of bugs that produced the Delete-key bug).
            //
            // Categories covered:
            //   key / mouse / textinput / windowkey / uno
            //     The classic input messages from Map.Keyboard / mouse /
            //     toolbar / shortcut paths.
            //   removetextcontext / removetextcontent
            //     Delete and Backspace go through TextInput.js's
            //     beforeinput handler, which sends `removetextcontext`
            //     (note the typo — TextInput.js's TODO promises it'll be
            //     renamed to `removetextcontent`; cover both).
            //   contentcontrolevent
            //     Form-field interactions: date picker, dropdown, picture
            //     content controls. Each event mutates the doc.
            //   moveselectedclientparts
            //     Reorder slides (Impress) or sheets (Calc). Pure doc
            //     mutation — peers MUST apply the same reorder.
            //   completefunction
            //     Calc autocomplete inserts a function name into the
            //     active formula cell.
            //   selecttext / resetselection
            //     Selection state. Each peer renders the others' cursors
            //     and selections via a remote-client Kit; for that mirror
            //     to show the right highlighted range, A's selection
            //     events MUST reach B's remote-Kit-for-A. Sources:
            //     CanvasTileLayer._postSelectTextEvent (selection-handle
            //     drag → TextSelectionHandleSection / TableSelectMarker /
            //     CellSelectionHandle); Parts.js / SearchService /
            //     PartsPreview send `resetselection`.
            //
            //   insertfile
            //     Image / media insertion. In WASM mode the base64 data=
            //     payload is embedded in the message itself (not on a
            //     server that peers could HTTP-fetch), so relaying the
            //     full message gives every peer the image bytes.
            //     NOTE: insertfile in WASM mode goes through
            //     postMobileMessage (not fws.send), so it's intercepted
            //     by the postMobileMessage wrapper below, not here.
            //     It IS in the list so the receive-side filter passes it
            //     through to remote-client Kits.
            //
            // NOT relayed (intentionally — per-user view / server-side):
            //   setclientpart / selectclientpart / setpage  → each user
            //     can view a different slide or sheet
            //   windowmouse / windowgesture / windowcommand → clicks
            //     inside per-user dialogs; doc-side effect comes via uno
            //   clientzoom, tileprocessed, commandvalues,
            //   gettextselection, paintwindow → local view state / queries
            //   attemptlock, closedocument, versionrestore, downloadas,
            //   exportas, renamefile → server-side WOPI ops
            var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
                text.startsWith('textinput ') || text.startsWith('windowkey ') ||
                text.startsWith('uno ') ||
                text.startsWith('removetextcontext ') ||
                text.startsWith('removetextcontent ') ||
                text.startsWith('contentcontrolevent ') ||
                text.startsWith('moveselectedclientparts ') ||
                text.startsWith('completefunction ') ||
                text.startsWith('selecttext ') ||
                text.startsWith('insertfile ') ||
                text === 'resetselection';
            if (isUserInput) {
                if (!activated) {
                    console.log('[relay] Dropping input (not activated yet): ' + text.substring(0, 40));
                    return;
                }
                sendToRelay(0x00, myViewId, data);

                // User-initiated save (Ctrl+S → COOL emits `uno .uno:Save`):
                // create a checkpoint and upload the saved file to storage.
                // Only the ORIGINATOR runs this — other peers receive the
                // same uno via relay, save locally, but don't double-upload
                // (their processUIMessage path doesn't schedule a save).
                //
                // saveAndUploadCheckpoint waits 1.5s for Kit to flush the
                // save before reading /wasm/<name>; if Ctrl+S is hammered,
                // each call queues its own delayed upload — wasteful but
                // not harmful (each uploads the same final bytes).
                if (isUserSaveCommand(text)) {
                    console.log('[relay] User save detected (' + text.substring(0, 40) +
                                ') — scheduling checkpoint + upload');
                    saveAndUploadCheckpoint();
                }
            } else {
                // Non-user-input (tileprocessed, clientzoom, etc.) goes
                // directly to Kit SYNCHRONOUSLY via postMobileMessage.
                // These are not relayed and must not be deferred.
                if (globalThis.postMobileMessage) {
                    globalThis.postMobileMessage(data);
                }
                // The toolbar Save button sends `save dontTerminateEdit=…`
                // (lowercase, no uno: prefix) — this goes to Kit directly
                // (not relayed, which is correct: the save is a local Kit
                // operation). BUT we still need to create a checkpoint and
                // upload the result to storage so other peers and the file
                // listing stay in sync. Schedule saveAndUploadCheckpoint
                // the same way we do for `uno .uno:Save` (Ctrl+S).
                if (text.startsWith('save ') && text.includes('dontTerminateEdit')) {
                    console.log('[relay] Toolbar save detected — scheduling checkpoint + upload');
                    saveAndUploadCheckpoint();
                }
            }
        }

        var FWS = fws.constructor;
        if (FWS && FWS.prototype) FWS.prototype.send = interceptedSend;
        fws.send = interceptedSend;
        console.log('[relay] Send interceptor installed');

        // ── postMobileMessage wrapper ──────────────────────────────
        // COOL's FileInserter in WASM mode calls postMobileMessage
        // directly (not fws.send), sending:
        //   insertfile name=<n> type=graphic data=<base64>
        // This bypasses interceptedSend entirely. We wrap
        // postMobileMessage so `insertfile` messages are routed
        // through the relay (they carry the full base64 payload, so
        // every peer receives the image bytes). All other messages
        // pass through to the Kit unchanged.
        // ── postMobileMessage wrapper ──────────────────────────────
        // COOL's FileInserter in WASM mode calls postMobileMessage
        // directly (not fws.send), sending:
        //   insertfile name=<n> type=graphic data=<base64>
        // This bypasses interceptedSend entirely. We wrap
        // postMobileMessage so `insertfile` messages are routed
        // through the relay (they carry the full base64 payload, so
        // every peer receives the image bytes). All other messages
        // pass through to the Kit unchanged.
        //
        // Guard: when OUR OWN processUIMessage delivers a relay echo
        // back to the local Kit (via sendToKit → postMobileMessage),
        // we must NOT re-intercept it — that would create an infinite
        // relay→self→relay loop. The `_deliveringToKit` flag is set
        // in processOneKitMessage to suppress re-interception.
        if (typeof globalThis.postMobileMessage === 'function') {
            var origPostMobile = globalThis.postMobileMessage;
            globalThis.postMobileMessage = function(msg) {
                // Skip re-interception when delivering a relay echo to Kit.
                if (globalThis._deliveringToKit) {
                    return origPostMobile(msg);
                }
                if (typeof msg === 'string' && msg.startsWith('insertfile ')) {
                    if (!activated) {
                        console.log('[relay] Dropping insertfile (not activated yet)');
                        return;
                    }
                    console.log('[relay] Intercepted insertfile via postMobileMessage (' +
                                msg.length + ' chars) — routing through relay');
                    sendToRelay(0x00, myViewId, msg);
                    return;
                }
                return origPostMobile(msg);
            };
            console.log('[relay] postMobileMessage wrapper installed (catches insertfile)');
        }
    }

    // --- Remote client management ---
    // Messages FROM remote client Kit sessions back to JS. These include
    // tile invalidations, status changes, cursor positions, etc. triggered
    // by remote users' actions. We forward the relevant ones to the primary
    // view's Kit session so the local canvas re-renders.
    globalThis.onRemoteClientMessage = function(clientId, data) {
        var text = typeof data === 'string' ? data : '';
        if (!text) return;

        // Log all messages from remote client for debugging
        if (text.startsWith('invalidate') || text.startsWith('statechanged') ||
            text.startsWith('status:') || text.startsWith('error:')) {
            console.log('[relay] Remote client ' + clientId + ' → ' + text.substring(0, 120));
        }

        // Only forward messages that reflect DOCUMENT changes (not remote
        // view UI state). The remote client sends hundreds of statechanged
        // messages during init (toolbar enabled/disabled etc.) — forwarding
        // those would corrupt the primary view's UI state.
        var shouldForward = text.startsWith('invalidatetiles:');
        // Word count and modified status are document-level and must be
        // forwarded: COOL's Kit emits .uno:StateWordCount through the
        // remote-client channel even for the LOCAL view, so if we don't
        // forward it the #StateWordCount widget never updates. (This was
        // briefly removed in an attempt to avoid a cross-doc clobber
        // during hot-switch, but that broke the wc widget for everyone —
        // see test-regression-room-switch which reads wc for validation.)
        if (text.indexOf('.uno:StateWordCount=') >= 0) shouldForward = true;
        if (text.indexOf('.uno:ModifiedStatus=') >= 0) shouldForward = true;

        if (shouldForward) {
            // Defer to next tick — onRemoteClientMessage is called from
            // EM_ASM on the main thread; calling onmessage synchronously
            // can cause reentrancy issues with the COOL message handler.
            var msg = text;
            setTimeout(function() {
                var ws = globalThis.TheFakeWebSocket;
                if (ws && ws.onmessage) {
                    ws.onmessage({ data: msg });
                }
            }, 0);
        }

        // Other messages from remote Kit (commandresult, tile data, etc.)
        // are specific to the remote view and can be ignored.
    };

    function sendToRemoteClient(clientId, text) {
        if (text.startsWith('textinput ')) {
            var match = text.match(/text=(.+)/);
            if (match) {
                var chars = decodeURIComponent(match[1]);
                for (var ci = 0; ci < chars.length; ci++) {
                    var charCode = chars.charCodeAt(ci);
                    Module._handle_remote_message(clientId,
                        Module.stringToNewUTF8('key type=input char=' + charCode + ' key=0'));
                    Module._handle_remote_message(clientId,
                        Module.stringToNewUTF8('key type=up char=0 key=0'));
                }
            }
        } else {
            Module._handle_remote_message(clientId, Module.stringToNewUTF8(text));
        }
    }

    function createRemoteClient(viewId) {
        if (remoteClients[viewId]) return;
        console.log('[relay] Creating remote client for viewId=' + viewId);
        var clientId = Module._create_remote_client();
        remoteClients[viewId] = { clientId: clientId, ready: false, queue: [] };
        console.log('[relay] Remote client created: viewId=' + viewId + ' clientId=' + clientId);
        sendToRelay(0x00, myViewId, 'presence viewId=' + myViewId);
    }

    // --- Poll for C++ ready signals ---
    function globalPollReady() {
        if (!Module || !Module.calledRun || !Module._poll_remote_client_ready) {
            setTimeout(globalPollReady, 500);
            return;
        }
        var readyId = Module._poll_remote_client_ready();
        if (readyId > 0) {
            for (var vid in remoteClients) {
                if (remoteClients[vid].clientId === readyId && !remoteClients[vid].ready) {
                    console.log('[relay] Client ' + readyId + ' (viewId=' + vid + ') ready');
                    remoteClients[vid].ready = true;
                    var q = remoteClients[vid].queue;
                    remoteClients[vid].queue = [];
                    if (q.length > 0) {
                        console.log('[relay] Flushing ' + q.length + ' queued msgs');
                        for (var i = 0; i < q.length; i++) {
                            try { sendToRemoteClient(readyId, q[i]); } catch(e) {}
                        }
                    }
                    break;
                }
            }
        }
        setTimeout(globalPollReady, 500);
    }
    setTimeout(globalPollReady, 1000);

    // --- Save-trigger handler ---
    function handleSaveTrigger() {
        console.log('[relay] Save-trigger received');
        saveAndUploadCheckpoint();
    }

    // True when the COOL JS layer dispatches a user-initiated save.
    // Ctrl+S, the toolbar Save button, and File→Save all funnel through
    // the same .uno:Save command. The Sidebar/Auto-save also produce
    // .uno:Save — that's still legit "user wants to persist this" intent.
    function isUserSaveCommand(text) {
        if (!text || !text.startsWith('uno ')) return false;
        var cmd = text.substring(4).split('?')[0].split(/\s/)[0];
        // Accept the bare Save plus the explicit-as variants. We do NOT
        // include FileSave (legacy alias) — COOL maps that internally.
        return cmd === '.uno:Save' || cmd === '.uno:SaveAs';
    }

    function saveAndUploadCheckpoint() {
        if (!connected) return;
        sendToKit('save dontTerminateEdit=1 dontSaveIfUnmodified=0');
        // Short delay for Kit to process the save — 1.5s is enough for
        // small docs. Previous 5s delay caused late joiners to miss
        // checkpoints when they connected during the delay window.
        setTimeout(function() {
            var saveAtSeq = lastSeq;
            var wopiSrc = params.get('WOPISrc') || '';
            // 1. Download saved file from editor's temp storage
            var editorFileUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
            origFetch(editorFileUrl).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
                var bytes = new Uint8Array(buf);
                // 2. Compute the full SHA-256 hex of the document.
                return crypto.subtle.digest('SHA-256', bytes).then(function(hashBuf) {
                    var hashArr = new Uint8Array(hashBuf);
                    var hashHex = Array.from(hashArr).map(function(b) {
                        return b.toString(16).padStart(2, '0');
                    }).join('');
                    // 3. Upload file to FILE STORAGE SERVER (the viewer).
                    //    This is the canonical store; late-joiners read from
                    //    here. The relay only learns the hash + seq for
                    //    coordination — it never stores file bytes.
                    var viewerFileUrl = getFileStorageUrl(wopiSrc);
                    return origFetch(viewerFileUrl, {
                        method: 'POST',
                        body: new Blob([bytes]),
                        mode: 'cors',
                    }).then(function() {
                        // 4. Report to relay. Frame layout:
                        //      [0]   type (0x07)
                        //      [1-4] viewId (uint32 BE)
                        //      [5-8] saveAtSeq (uint32 BE)
                        //      [9..] hash hex string (UTF-8, 64 ASCII chars)
                        //
                        //    We send only the hash here — NOT the file bytes.
                        //    Sending the body would burn `filesize` bytes of
                        //    WebSocket traffic per save (the file already
                        //    went to /api/files in step 3). The relay's
                        //    0x07 handler reads buf.slice(9).toString() as
                        //    the hash.
                        var hashBytes = new TextEncoder().encode(hashHex);
                        var frame = new Uint8Array(5 + 4 + hashBytes.length);
                        frame[0] = 0x07;
                        frame[1] = (myViewId >>> 24) & 0xFF;
                        frame[2] = (myViewId >>> 16) & 0xFF;
                        frame[3] = (myViewId >>> 8) & 0xFF;
                        frame[4] = myViewId & 0xFF;
                        frame[5] = (saveAtSeq >>> 24) & 0xFF;
                        frame[6] = (saveAtSeq >>> 16) & 0xFF;
                        frame[7] = (saveAtSeq >>> 8) & 0xFF;
                        frame[8] = saveAtSeq & 0xFF;
                        frame.set(hashBytes, 9);
                        ws.send(frame);
                        console.log('[relay] Checkpoint: file=' + bytes.length + 'B → /api/files; ' +
                                    'sent hash=' + hashHex.substring(0, 16) + '… (' + frame.length + 'B frame) seq=' + saveAtSeq);
                    });
                });
            }).catch(function(e) {
                console.error('[relay] Checkpoint failed: ' + e.message);
            });
        }, 1500);
    }

    // Resolve the file storage URL for a given WOPISrc.
    //
    // The viewer's /api/files/ endpoint is the source-of-truth file store.
    // We need this URL so saved checkpoints can be uploaded back here (so
    // late-joiners see the latest content). Resolution order:
    //   1. fileStorageUrl query param — set by the viewer when it builds the
    //      iframe URL. The robust path; works regardless of referrer policy
    //      or cross-origin restrictions.
    //   2. parent.location.origin — works only when same-origin.
    //   3. document.referrer — set unless `referrerpolicy="no-referrer"`.
    //   4. Fallback: the editor's own /wasm/ endpoint. This is wrong for
    //      the source-of-truth (the viewer never sees it) but at least
    //      stores the bytes so the editor can re-load them. Late-join
    //      sync into the viewer's storage will be broken in this mode.
    function getFileStorageUrl(wopiSrc) {
        return resolveFileStorageBase() + '/api/files/' + encodeURIComponent(wopiSrc);
    }

    // Build the URL for a content-addressable blob. Returns null if we
    // can't resolve the file-storage origin AND the caller should fall
    // back to /api/files/<name>.
    function getBlobUrl(hash) {
        if (!hash) return null;
        var base = resolveFileStorageBase();
        if (!base) return null;
        return base + '/api/blobs/' + encodeURIComponent(hash);
    }

    // Resolve the base URL of the viewer (which serves both /api/files/
    // and /api/blobs/). Same resolution order as the old getFileStorageUrl.
    function resolveFileStorageBase() {
        var explicit = params.get('fileStorageUrl');
        if (explicit) {
            if (explicit.charAt(explicit.length - 1) === '/') explicit = explicit.slice(0, -1);
            return explicit;
        }
        try {
            if (window.parent !== window) {
                var origin = window.parent.location.origin;
                if (origin && origin !== 'null') return origin;
            }
        } catch(e) {}
        if (document.referrer) {
            try { return new URL(document.referrer).origin; } catch(e) {}
        }
        // Last resort: the editor's own origin. /api/blobs/ doesn't live
        // there, so getBlobUrl will return a 404 and the late-joiner code
        // will fall back to /wasm/ via the source list.
        console.warn('[relay] resolveFileStorageBase: no fileStorageUrl param, no same-origin parent, no referrer');
        return window.location.origin;
    }

    // --- Process a sequenced UI message ---
    function processUIMessage(msg, seq) {
        lastSeq = seq;

        var text = new TextDecoder().decode(msg.payload.slice(4)); // Skip seq bytes
        var vid = msg.viewId;

        if (text === 'HULLO' || text === 'BYE' || text.startsWith('tileprocessed ')) return;

        // Presence: trigger remote client creation
        if (text.startsWith('presence ')) {
            if (vid !== myViewId && !remoteClients[vid]) {
                createRemoteClient(vid);
            }
            return;
        }

        // pasteb64 is no longer sent (paste blobs are now converted to
        // insertfile or textinput before relaying). Keep the handler as a
        // no-op for backward compat with any in-flight messages.
        if (text.startsWith('pasteb64 ')) return;

        // Keep the receive-side filter in sync with interceptedSend above
        // — see the long comment there for which prefixes mutate the doc
        // and which are intentionally per-user.
        var isUserInput = text.startsWith('key ') || text.startsWith('mouse ') ||
            text.startsWith('textinput ') || text.startsWith('windowkey ') ||
            text.startsWith('uno ') ||
            text.startsWith('removetextcontext ') ||
            text.startsWith('removetextcontent ') ||
            text.startsWith('contentcontrolevent ') ||
            text.startsWith('moveselectedclientparts ') ||
            text.startsWith('completefunction ') ||
            text.startsWith('selecttext ') ||
            text.startsWith('insertfile ') ||
            text === 'resetselection';
        if (!isUserInput) return;

        if (text.startsWith('uno ')) {
            console.log('[relay] UNO via relay: vid=' + vid + ' myVid=' + myViewId +
                        ' isSelf=' + (vid === myViewId) + ' cmd=' + text.substring(0, 60));
        }

        // Log relay-routed messages for debugging
        if (text.startsWith('key ') && text.includes('char=')) {
            console.log('[relay] processUI: vid=' + vid + ' myVid=' + myViewId + ' isSelf=' + (vid===myViewId) + ' ' + text.substring(0, 50));
        }

        // Own viewId → local Kit session (own cursor)
        if (vid === myViewId) {
            if (text.startsWith('textinput ')) {
                var match = text.match(/text=(.+)/);
                if (match) {
                    var chars = decodeURIComponent(match[1]);
                    for (var ci = 0; ci < chars.length; ci++) {
                        var charCode = chars.charCodeAt(ci);
                        sendToKit('key type=input char=' + charCode + ' key=0');
                        sendToKit('key type=up char=0 key=0');
                    }
                }
            } else {
                sendToKit(text);
            }
            return;
        }

        // Other viewId → remote client session (their cursor)
        if (!remoteClients[vid]) {
            createRemoteClient(vid);
        }
        var rc = remoteClients[vid];
        if (!rc.ready) {
            rc.queue.push(text);
            return;
        }
        try {
            sendToRemoteClient(rc.clientId, text);
        } catch(e) {
            console.error('[relay] Remote send failed: ' + e.message);
        }
    }

    // --- Process relay message ---
    function processRelayMessage(msg) {
        // 0x08: Save-trigger
        if (msg.type === 0x08) {
            handleSaveTrigger();
            return;
        }

        // 0x0A: Checkpoint mismatch — relay rejected our hash, must re-download
        if (msg.type === 0x0A) {
            try {
                var mismatch = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('[relay] CHECKPOINT MISMATCH: expected=' + mismatch.expected + ' — will re-download');
                // The relay will send a new 0x05 with the correct checkpoint
                // Reset state so we re-process it
                activated = false;
                lateJoinFileReady = false;
            } catch(e) {}
            return;
        }

        // 0x05: Join-response
        if (msg.type === 0x05) {
            if (msg.payload.length > 0) {
                try {
                    var info = JSON.parse(new TextDecoder().decode(msg.payload));
                    if (info.first) {
                        // First client — no file to download
                        isFirstClient = true;
                        joinFileSeq = 0;
                        console.log('[relay] First client in room');
                        if (coolwsdReady) activateClient();
                        return;
                    }

                    // Late joiner — download the checkpoint by HASH from
                    // the content-addressable blob endpoint. The relay
                    // promised this hash; the blob endpoint returns
                    // exactly those bytes; the SHA-256 we compute will
                    // match — no chance of drift, no 0x0A re-download
                    // dance, no stale-hash deadlock.
                    //
                    // Falls back to /api/files/<name> + /wasm/<name> if
                    // the blob endpoint is unavailable (older deploys).
                    joinFileSeq = info.seq;
                    var wopiSrc = params.get('WOPISrc') || '';
                    var editorWopiUrl = window.location.origin + '/wasm/' + encodeURIComponent(wopiSrc);
                    var blobUrl = info.hash ? getBlobUrl(info.hash) : null;
                    var nameUrl = getFileStorageUrl(wopiSrc);
                    console.log('[relay] Join-response: relay-expected hash=' + (info.hash||'').substring(0, 16) + '… seq=' + info.seq +
                        (blobUrl ? ' — fetching by hash from ' + blobUrl.replace(/\/[a-f0-9]{16,}.*$/, '/<hash>') : ' — fetching by name'));

                    // Try sources in order: blob-by-hash → name → editor's own /wasm/.
                    var sources = [];
                    if (blobUrl) sources.push({ kind: 'blob', url: blobUrl });
                    sources.push({ kind: 'name', url: nameUrl });
                    sources.push({ kind: 'editor-wasm', url: editorWopiUrl });

                    function tryNext(idx) {
                        if (idx >= sources.length) {
                            return Promise.reject(new Error('all sources exhausted'));
                        }
                        var s = sources[idx];
                        var opts = s.kind === 'editor-wasm' ? {} : { mode: 'cors' };
                        return origFetch(s.url, opts).then(function(r) {
                            if (!r.ok) throw new Error(s.kind + ' ' + r.status);
                            return r.arrayBuffer();
                        }).catch(function(e) {
                            console.log('[relay] Source "' + s.kind + '" failed (' + e.message + '), trying next');
                            return tryNext(idx + 1);
                        });
                    }
                    tryNext(0).then(function(buf) {
                        // Compute SHA-256 of what we actually loaded — keeps
                        // the integrity check honest even when we go via
                        // /api/blobs (where it's tautological).
                        var bytes = new Uint8Array(buf);
                        return crypto.subtle.digest('SHA-256', bytes).then(function(hashBuf) {
                            var hashArr = new Uint8Array(hashBuf);
                            joinFileHash = Array.from(hashArr).map(function(b) {
                                return b.toString(16).padStart(2, '0');
                            }).join('');
                            var matches = info.hash && info.hash === joinFileHash;
                            console.log('[relay] Downloaded ' + buf.byteLength + 'B; computed hash=' + joinFileHash.substring(0, 16) + '…' +
                                (matches ? ' (matches relay expected)' :
                                 info.hash ? ' (relay expected ' + info.hash.substring(0, 16) + '… — mismatch will be resolved by relay)' : ''));
                            lateJoinFileReady = true;
                            return origFetch(editorWopiUrl, { method: 'POST', body: new Blob([buf]) });
                        });
                    }).then(function() {
                        console.log('[relay] WOPI file updated — waiting for COOLWSD to load it');
                    }).catch(function(e) {
                        console.error('[relay] Late-join file sync failed: ' + e.message);
                    });
                } catch(e) {
                    console.log('[relay] Join-response parse error: ' + e.message);
                }
            }
            return;
        }

        // 0x02: Client joined
        if (msg.type === 0x02) {
            try {
                var joinInfo = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('[relay] Client joined: viewId=' + joinInfo.viewId + ' seq=' + joinInfo.seq);
                if (joinInfo.viewId !== myViewId && !remoteClients[joinInfo.viewId]) {
                    createRemoteClient(joinInfo.viewId);
                }
            } catch(e) {}
            return;
        }

        // 0x03: Client left
        if (msg.type === 0x03) {
            try {
                var leaveInfo = JSON.parse(new TextDecoder().decode(msg.payload));
                console.log('[relay] Client left: viewId=' + leaveInfo.viewId);
            } catch(e) {}
            return;
        }

        // 0x00: UI message (with seq#)
        if (msg.type === 0x00 && msg.payload.length >= 4) {
            var seq = ((msg.payload[0] << 24) | (msg.payload[1] << 16) |
                       (msg.payload[2] << 8) | msg.payload[3]) >>> 0;
            processUIMessage(msg, seq);
            return;
        }
    }

    // --- WebSocket handlers (named for reuse during room switch) ---
    function onWsMessage(event) {
        var msg = parseFrame(event.data);
        if (!msg) return;

        if (msg.type === 0x05 || msg.type === 0x08 || msg.type === 0x0A) {
            processRelayMessage(msg);
            return;
        }

        if (!coolwsdReady) {
            recvQueue.push(msg);
            return;
        }

        processRelayMessage(msg);
    }

    function onWsOpen() {
        connected = true;
        console.log('[relay] Connected');
        for (var i = 0; i < sendQueue.length; i++) ws.send(sendQueue[i]);
        sendQueue = [];
        initiateJoin();
    }

    ws.onmessage = onWsMessage;
    ws.onopen = onWsOpen;
    ws.onerror = function(err) { console.error('[relay] WebSocket error', err); };
    ws.onclose = function() { connected = false; console.log('[relay] Disconnected'); };

    // --- Activation when COOLWSD is ready (for late joiners) ---
    // Late joiners: wait for both COOLWSD ready AND file downloaded.
    // This needs to be restartable for room switches: after switching to
    // a new room, the previous activation poll has already cleared itself.
    var activationPollInterval = null;
    function startActivationPoll() {
        if (activationPollInterval) clearInterval(activationPollInterval);
        var pollStart = Date.now();
        var lastReportedReason = '';
        activationPollInterval = setInterval(function() {
            if (activated) { clearInterval(activationPollInterval); activationPollInterval = null; return; }
            if (coolwsdReady && lateJoinFileReady && !activated) {
                activateClient();
                clearInterval(activationPollInterval);
                activationPollInterval = null;
                return;
            }
            // Report what we're still waiting on so a stuck activation is
            // diagnosable from the console (and so the parent viewer can
            // surface "Joining session…" instead of looking frozen).
            var waiting = !coolwsdReady ? 'editor' : 'checkpoint download';
            var elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
            if (waiting !== lastReportedReason || (elapsed % 5 === 0 && elapsed > 0)) {
                lastReportedReason = waiting;
                console.log('[relay] Activation pending: waiting for ' + waiting + ' (' + elapsed + 's)');
                try {
                    parent.postMessage(JSON.stringify({
                        MessageId: 'RelayActivating',
                        Values: { waitingFor: waiting, elapsedSec: parseInt(elapsed, 10) }
                    }), '*');
                } catch(e) {}
            }
        }, 500);
    }
    startActivationPoll();
})();
