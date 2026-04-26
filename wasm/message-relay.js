// Checkpoint-based relay server for COOL WASM co-editing.
//
// Architecture — zero divergence guarantee:
//   1. A room always has a CHECKPOINT: a file + hash + sequence number.
//      The checkpoint is the initial document or the last save from any browser.
//   2. All UI messages get monotonic sequence numbers and are logged since the checkpoint.
//   3. Every browser MUST start from the checkpoint:
//      - Download the checkpoint file
//      - Write it to WOPI (so the WASM module loads it)
//      - Replay all messages since the checkpoint
//      - Only THEN can the browser send changes
//   4. When a late joiner arrives:
//      - If changes exist since the last checkpoint, trigger a FRESH save first
//      - Wait for the save to complete (creates new checkpoint with 0 pending messages)
//      - Send the fresh checkpoint to the late joiner
//      - This ensures the joiner doesn't need to replay a huge backlog
//   5. Join-ready (0x06) includes the checkpoint hash the browser loaded.
//      The relay verifies it matches. If not → re-send current checkpoint.
//
// Protocol: binary frames [1 byte type][4 byte viewId][payload]
//   0x00 = UI message. Broadcast: [4 byte seq][original payload]
//   0x02 = client joined  (server -> all, JSON {viewId, seq})
//   0x03 = client left    (server -> all, JSON {viewId, seq})
//   0x04 = join-request   (client -> server, payload = WOPISrc)
//   0x05 = join-response  (server -> client, JSON {first, hash?, locator?, seq, cursors?, msgCount})
//   0x06 = join-ready     (client -> server, JSON {hash, locator?} — first client registers, late joiner confirms)
//   0x07 = save-rotation  (client -> server, JSON {hash, locator, seq, cursors} — after Ctrl+S)
//   0x0A = checkpoint-mismatch (server -> client, JSON {expected, locator, seq}) — re-download required

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

// Config comes from env (set by launch-relay.sh from wasm/.env). The
// default for PORT is a dev convenience only; SSL_CERT/KEY have no
// default — if they're unset, we run plain HTTP (Azure-terminated TLS).
const PORT = process.env.PORT || process.env.RELAY_PORT || 9091;
const SSL_CERT = process.env.SSL_CERT || '';
const SSL_KEY = process.env.SSL_KEY || '';
const RELAY_HOSTNAME = process.env.RELAY_HOSTNAME || '';

// Detect whether SSL certs are available. On Azure App Service, TLS is
// terminated by the platform so the relay runs plain HTTP/WS internally.
const useSSL = !!(SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY));

// Sanity check: verify the cert we're about to serve actually covers
// RELAY_HOSTNAME. Running with a mismatched SAN silently breaks
// browser wss handshakes — the failure mode is a closed WS with no
// error visible in application logs, just "co-editing doesn't work."
// Only runs when RELAY_HOSTNAME is set (so local/Azure runs that
// don't care about a specific hostname aren't pestered).
if (useSSL && RELAY_HOSTNAME) {
    try {
        const { X509Certificate } = require('crypto');
        const cert = new X509Certificate(fs.readFileSync(SSL_CERT));
        const subject = cert.subject || '';
        const san = cert.subjectAltName || '';
        const expectedOK = subject.includes(RELAY_HOSTNAME)
            || san.includes('DNS:' + RELAY_HOSTNAME);
        if (!expectedOK) {
            console.error('================================================================');
            console.error('WARN: relay cert SAN does not include ' + RELAY_HOSTNAME);
            console.error('      cert subject: ' + subject);
            console.error('      cert SAN: ' + san);
            console.error('      wss://' + RELAY_HOSTNAME + ' will fail browser TLS checks.');
            console.error('      Set SSL_CERT/SSL_KEY to a cert that covers ' + RELAY_HOSTNAME + '.');
            console.error('================================================================');
        }
    } catch(e) {
        console.warn('[relay] cert sanity check skipped: ' + e.message);
    }
}

// Inline debug UI — single-page app served at /debug/. Lists active
// rooms, streams messages from a chosen room over SSE.
const DEBUG_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Relay Debug</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI",
          ui-sans-serif, Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a; background: #f7f7f9; display: flex;
  }
  aside {
    width: 320px; background: #fff; border-right: 1px solid #e2e2e6;
    overflow-y: auto; flex-shrink: 0;
  }
  aside h2 {
    margin: 0; padding: 14px 16px; font-size: 14px; font-weight: 600;
    border-bottom: 1px solid #e2e2e6; background: #f0f0f3;
  }
  .rooms { list-style: none; margin: 0; padding: 0; }
  .rooms li {
    padding: 10px 16px; border-bottom: 1px solid #f0f0f3; cursor: pointer;
  }
  .rooms li:hover { background: #f0f7ff; }
  .rooms li.active { background: #e0eeff; }
  .rooms .name { font-weight: 600; word-break: break-all; }
  .rooms .meta { color: #6b7280; font-size: 11px; margin-top: 2px; }
  .empty { color: #9ca3af; padding: 16px; font-style: italic; }
  main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  header {
    padding: 12px 18px; background: #fff; border-bottom: 1px solid #e2e2e6;
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: 10px;
  }
  header h1 { font-size: 16px; margin: 0; word-break: break-all; }
  .summary {
    display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px;
    color: #4b5563;
  }
  .summary b { color: #111; font-weight: 600; }
  .controls { display: flex; gap: 8px; }
  button {
    font: inherit; padding: 4px 12px; border: 1px solid #cbd5e1;
    background: #fff; border-radius: 4px; cursor: pointer;
  }
  button:hover { background: #f0f7ff; }
  button[disabled] { opacity: 0.5; cursor: not-allowed; }
  #log {
    flex: 1; overflow-y: auto; padding: 8px 0; background: #fafafc;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  }
  .row {
    display: grid; grid-template-columns: 96px 56px 36px 140px 1fr;
    gap: 10px; padding: 4px 18px; align-items: baseline;
    border-bottom: 1px dashed #ececf0;
  }
  .row.event { background: #fffbe6; }
  .row.event .text { color: #6b5800; }
  .row .ts { color: #9ca3af; font-size: 11px; }
  .row .seq { color: #4b5563; text-align: right; }
  .row .kind {
    text-align: center; padding: 1px 4px; border-radius: 3px;
    font-size: 10px; text-transform: uppercase;
  }
  .row .kind.msg { background: #dcfce7; color: #166534; }
  .row .kind.event { background: #fde68a; color: #92400e; }
  .row .vid { color: #6b7280; }
  .row .text {
    word-break: break-all; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .text.dim { color: #9ca3af; }
  .empty-log { color: #9ca3af; padding: 24px; text-align: center; }
</style>
</head>
<body>
<aside>
  <h2>Rooms <span id="roomCount" style="color:#6b7280;font-weight:400;font-size:11px;"></span></h2>
  <ul id="rooms" class="rooms"></ul>
</aside>
<main>
  <header>
    <h1 id="roomName">Pick a room</h1>
    <div class="summary" id="roomMeta"></div>
    <div class="controls">
      <button id="clearBtn" disabled>Clear log</button>
      <label style="font-size:11px;color:#6b7280;display:flex;align-items:center;gap:4px;">
        <input type="checkbox" id="autoscroll" checked> autoscroll
      </label>
    </div>
  </header>
  <div id="log"><div class="empty-log">Pick a room from the left to see live messages.</div></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let currentRoom = null;
let es = null;
const KIND_FOR_EVENT = {
  connected: 'connect', disconnected: 'leave', activated: 'activate',
  checkpoint: 'checkpoint',
};

async function refreshRooms() {
  try {
    const r = await fetch('/debug/api/rooms');
    const items = await r.json();
    const ul = $('rooms');
    $('roomCount').textContent = '(' + items.length + ')';
    if (items.length === 0) {
      ul.innerHTML = '<li class="empty">No active rooms.</li>';
      return;
    }
    ul.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      if (it.id === currentRoom) li.className = 'active';
      const ageMin = (it.ageSec / 60).toFixed(1);
      li.innerHTML =
        '<div class="name"></div>' +
        '<div class="meta">' +
          it.activeCount + ' active / ' + it.clientCount + ' total · ' +
          'seq ' + it.seq + ' · ' +
          ageMin + 'm · ' +
          (it.checkpointHash ? 'ckpt ' + it.checkpointHash.substring(0, 8) + '…' : 'no ckpt') +
        '</div>';
      li.querySelector('.name').textContent = decodeURIComponent(it.id);
      li.onclick = () => openRoom(it.id);
      ul.appendChild(li);
    }
  } catch (e) {
    $('rooms').innerHTML = '<li class="empty">Error: ' + e.message + '</li>';
  }
}

function fmtTs(ms) {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8) + '.' +
         String(d.getMilliseconds()).padStart(3, '0');
}

function appendRow(rec) {
  const log = $('log');
  if (log.querySelector('.empty-log')) log.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'row ' + (rec.kind === 'event' ? 'event' : 'msg');
  const tsEl = document.createElement('div');
  tsEl.className = 'ts'; tsEl.textContent = fmtTs(rec.ts);
  const seqEl = document.createElement('div');
  seqEl.className = 'seq'; seqEl.textContent = rec.seq != null ? rec.seq : '';
  const kindEl = document.createElement('div');
  kindEl.className = 'kind ' + rec.kind;
  kindEl.textContent = rec.kind === 'event'
    ? (KIND_FOR_EVENT[rec.event] || rec.event || 'event')
    : 'msg';
  const vidEl = document.createElement('div');
  vidEl.className = 'vid';
  vidEl.textContent = rec.fromViewId != null
    ? '#' + rec.fromViewId + (rec.fromName ? ' ' + rec.fromName : '')
    : rec.viewId != null ? '#' + rec.viewId + (rec.name ? ' ' + rec.name : '') : '';
  const textEl = document.createElement('div');
  textEl.className = 'text';
  if (rec.kind === 'msg') {
    textEl.textContent = rec.text || '';
    if (rec.bytes) {
      const span = document.createElement('span');
      span.className = 'dim';
      span.textContent = '  (' + rec.bytes + 'B → ' + rec.recipients + ' recipients)';
      textEl.appendChild(span);
    }
  } else {
    // Event — render the relevant fields compactly.
    const parts = [];
    if (rec.event === 'connected')    parts.push('client connected');
    if (rec.event === 'disconnected') parts.push('client disconnected');
    if (rec.event === 'activated')    parts.push('viewId ' + rec.viewId + ' activated (' + rec.activeCount + ' active)');
    if (rec.event === 'checkpoint')   parts.push('checkpoint ' + (rec.hash||'').substring(0, 16) + '… atSeq=' + rec.atSeq + ' (pruned ' + rec.pruned + ')');
    if (parts.length === 0) parts.push(JSON.stringify(rec));
    textEl.textContent = parts.join(' · ');
  }
  row.appendChild(tsEl); row.appendChild(seqEl); row.appendChild(kindEl);
  row.appendChild(vidEl); row.appendChild(textEl);
  log.appendChild(row);
  if ($('autoscroll').checked) log.scrollTop = log.scrollHeight;
}

function renderSummary(room) {
  $('roomName').textContent = decodeURIComponent(room.id);
  $('roomMeta').innerHTML =
    '<span><b>' + room.activeCount + '</b> active / <b>' + room.clientCount + '</b> total</span>' +
    '<span>seq <b>' + room.seq + '</b></span>' +
    '<span>unsaved <b>' + room.unsavedMsgs + '</b></span>' +
    '<span>checkpoint <b>' + (room.checkpointHash ? room.checkpointHash.substring(0, 16) + '…' : '—') + '</b></span>';
}

async function openRoom(roomId) {
  currentRoom = roomId;
  await refreshRooms();
  if (es) { try { es.close(); } catch(e) {} es = null; }
  $('log').innerHTML = '<div class="empty-log">Loading…</div>';
  $('clearBtn').disabled = false;
  es = new EventSource('/debug/api/rooms/' + encodeURIComponent(roomId) + '/stream');
  es.addEventListener('snapshot', (ev) => {
    const data = JSON.parse(ev.data);
    renderSummary(data.room);
    $('log').innerHTML = '';
    for (const rec of data.log) appendRow(rec);
  });
  es.addEventListener('rec', (ev) => appendRow(JSON.parse(ev.data)));
  es.onerror = () => {
    // EventSource auto-reconnects; just visually mark the disconnect.
    $('roomName').textContent = decodeURIComponent(roomId) + ' (reconnecting…)';
  };
  $('clearBtn').onclick = () => { $('log').innerHTML = ''; };
}

refreshRooms();
setInterval(refreshRooms, 4000);
</script>
</body>
</html>`;

const rooms = new Map();

class Room {
    constructor(id) {
        this.id = id;
        this.createdAt = Date.now();
        this.clients = new Set();
        this.activeClients = new Set();
        this.seq = 0;

        // Checkpoint — pure metadata. The relay NEVER stores the file
        // bytes; `checkpointLocator` is a URL any client can fetch the
        // bytes from.
        //
        // Initial registration: first client's 0x06 after activation.
        // Rotation: any client's 0x07 after Ctrl+S; replaces the
        // tuple and prunes messageLog to seq > checkpointSeq.
        //
        // `checkpointCursors` is a snapshot of the per-viewId cursor
        // state at checkpoint.seq — late joiners apply these before
        // starting replay so they see peer cursors immediately without
        // waiting for the next cursor broadcast.
        this.checkpointHash = null;
        this.checkpointLocator = null;
        this.checkpointSeq = 0;
        this.checkpointCursors = [];   // [{viewId, frame: base64}]

        // Live cursor tracking: as 0x00 broadcasts flow through the
        // relay, we snapshot the most recent cursor-related frame per
        // viewId. On 0x07 we copy this map into the checkpoint.
        this.cursors = new Map();      // viewId → {frame: Buffer}

        // Joiners that arrived before the first client's 0x06
        // registered the checkpoint. Served as soon as the checkpoint
        // is known.
        this.waitingForCheckpoint = new Set();

        // Message log; pruned on every checkpoint rotation so a
        // session with one save-per-hour never exceeds a few seconds'
        // worth of broadcast.
        this.messageLog = [];
        this.maxLogSize = 50000;

        // Separate debug ring buffer — captures EVERY frame and event,
        // independent of checkpoint pruning. Used by /debug/ to give a
        // full picture of what flowed through the room. Capped so a
        // long-running room doesn't grow unbounded.
        this.debugLog = [];
        this.debugMaxSize = 2000;
        // Listeners attached via /debug/api/rooms/:id/stream (SSE).
        this.debugListeners = new Set();
    }

    // Append a record to the debug log. `kind` is the high-level event:
    //   'msg' — a relayed user-input frame (broadcast)
    //   'event' — control or lifecycle event (join, leave, save, etc.)
    debugAppend(kind, fields) {
        const rec = Object.assign({ ts: Date.now(), kind }, fields);
        this.debugLog.push(rec);
        if (this.debugLog.length > this.debugMaxSize) {
            this.debugLog = this.debugLog.slice(-this.debugMaxSize);
        }
        // Push to any SSE listeners. Errors (closed connection) just
        // unregister the listener.
        for (const fn of this.debugListeners) {
            try { fn(rec); } catch (e) { this.debugListeners.delete(fn); }
        }
    }

    nextSeq() { return ++this.seq; }

    // Register or ROTATE the room's checkpoint.
    //  - Initial registration: on the first client's 0x06 (atSeq=0).
    //  - Rotation: on any client's 0x07 after Ctrl+S (atSeq = last
    //    broadcast seq at save time). Rotation prunes messageLog to
    //    seq > atSeq so future late joiners start on the new baseline
    //    without replaying pre-save history.
    // `cursors` is the cursor-state snapshot that goes into the
    // checkpoint payload; on initial registration it's empty, on
    // rotation it's whatever the relay's live cursor map holds.
    registerCheckpoint(hash, locator, atSeq, cursors) {
        if (!Room.isValidHexHash(hash)) {
            console.log(`[${this.id}] registerCheckpoint REJECTED malformed hash (len=${(hash||'').length})`);
            return false;
        }
        const isRotation = !!this.checkpointHash;
        const newSeq = typeof atSeq === 'number' ? atSeq : 0;
        if (isRotation && newSeq <= this.checkpointSeq) {
            console.log(`[${this.id}] registerCheckpoint REJECTED stale rotation (atSeq=${newSeq} <= current=${this.checkpointSeq})`);
            return false;
        }
        this.checkpointHash = hash;
        this.checkpointLocator = locator || null;
        this.checkpointSeq = newSeq;
        this.checkpointCursors = cursors || [];
        // Prune log: only messages strictly newer than this checkpoint
        // remain, so a late joiner landing on the new baseline doesn't
        // double-apply old frames.
        const before = this.messageLog.length;
        this.messageLog = this.messageLog.filter(m => m.seq > newSeq);
        const pruned = before - this.messageLog.length;
        console.log(`[${this.id}] CHECKPOINT ${isRotation ? 'ROTATED' : 'REGISTERED'} hash=${hash} locator=${locator || '(none)'} atSeq=${newSeq} cursors=${(cursors||[]).length} pruned=${pruned}`);
        this.debugAppend('event', {
            event: 'checkpoint',
            hash, locator: locator || null,
            atSeq: newSeq, pruned,
            rotation: isRotation,
        });
        // Flush anyone parked waiting for the first registration.
        for (const ws of this.waitingForCheckpoint) {
            if (ws.readyState === WebSocket.OPEN) this.serveCheckpoint(ws);
        }
        this.waitingForCheckpoint.clear();
        return true;
    }

    // Snapshot the live cursor map in the format shipped in 0x05/0x07
    // payloads: [{viewId, frame: base64}].
    snapshotCursors() {
        const out = [];
        for (const [viewId, entry] of this.cursors) {
            if (entry && entry.frame) {
                out.push({ viewId, frame: entry.frame.toString('base64') });
            }
        }
        return out;
    }

    // Hex-hash sanity check. We accept any-length hex string of at least
    // 16 chars; current clients send 64 (full SHA-256). Anything that's
    // not an even-length hex string is treated as junk (legacy bytes-as-
    // string from before the SHA-256 fix landed).
    static isValidHexHash(s) {
        return typeof s === 'string' && s.length >= 16 && /^[0-9a-fA-F]+$/.test(s);
    }

    get fileHash() { return this.checkpointHash; }
    get fileSeq() { return this.checkpointSeq; }

    hasUnsavedChanges() {
        return this.messageLog.length > 0;
    }

    broadcast(originFrame) {
        const seq = this.nextSeq();
        const viewId = originFrame.slice(1, 5);
        const payload = originFrame.slice(5);

        const frame = Buffer.alloc(5 + 4 + payload.length);
        frame[0] = 0x00;
        viewId.copy(frame, 1);
        frame.writeUInt32BE(seq, 5);
        payload.copy(frame, 9);

        this.messageLog.push({ seq, frame });
        if (this.messageLog.length > this.maxLogSize) {
            this.messageLog = this.messageLog.slice(-this.maxLogSize);
        }

        for (const client of this.activeClients) {
            if (client.readyState === WebSocket.OPEN) client.send(frame);
        }
        // Buffer for joining clients that are already downloading
        for (const client of this.clients) {
            if (client._joinBuffering) client._joinBuffer.push(frame);
        }

        // Debug: capture the broadcast for /debug/. Decode the payload as
        // UTF-8 (truncated) — user input is text. activeClients is the
        // set of recipients.
        const fromViewId = viewId.readUInt32BE(0);
        // Detect encrypted payload: [keyVer:4][nonce:12][ct...] starts with
        // a non-ASCII byte pattern (key version > 0, nonce is random bytes).
        // Plaintext always starts with an ASCII command keyword.
        const isEncrypted = payload.length > 16 && payload[0] === 0 && payload[1] === 0;
        const text = isEncrypted
            ? '[encrypted: ' + payload.length + 'B, keyVer=' + payload.readUInt32BE(0) + ']'
            : payload.toString('utf8');
        // Capture name from presence messages
        if (!isEncrypted && text.startsWith('presence ')) {
            const nameMatch = text.match(/name=(\S+)/);
            if (nameMatch) {
                for (const c of this.clients) {
                    if (c._viewId === fromViewId) { c._name = nameMatch[1]; break; }
                }
            }
        }
        // Track the most recent cursor-related broadcast per viewId so
        // a future checkpoint rotation (0x07) or late-join 0x05 can
        // ship peer cursor state without waiting for each peer to
        // re-emit their cursor. Covers selection and graphic cursors
        // too — any message whose payload describes where a view's
        // focus/selection currently is.
        if (!isEncrypted && /^(invalidateviewcursor|textselection|graphicselection|cellcursor|invalidatecursor):/.test(text)) {
            this.cursors.set(fromViewId, { frame: Buffer.from(frame) });
        }
        // Look up sender name for debug display
        let fromName = null;
        for (const c of this.clients) {
            if (c._viewId === fromViewId && c._name) { fromName = c._name; break; }
        }
        this.debugAppend('msg', {
            seq,
            type: 0x00,
            fromViewId,
            fromName,
            text: text.length > 200 ? text.substring(0, 200) + '…' : text,
            bytes: payload.length,
            recipients: this.activeClients.size,
        });
        return seq;
    }

    sendControl(ws, type, viewId, payload) {
        const payloadBuf = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload || []);
        const frame = Buffer.alloc(5 + payloadBuf.length);
        frame[0] = type;
        frame.writeUInt32BE(viewId || 0, 1);
        payloadBuf.copy(frame, 5);
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }

    // Tell a joiner what checkpoint to fetch and what messages to
    // replay on top. The relay never holds bytes; `locator` (if set)
    // is the URL the joiner fetches them from. The client is
    // responsible for hash-verifying whatever it downloads against
    // `hash`.
    //
    // Peer cursor state is shipped as ordinary 0x00 broadcast frames,
    // but ONLY when the checkpoint has rotated (seq > 0) — at that
    // point the matching broadcasts have been pruned from messageLog
    // and the cursor snapshot is the only way a late joiner learns
    // peer cursor positions.
    //
    // At the initial checkpoint (seq=0) the messageLog is whole and
    // ALREADY contains every cursor broadcast, so prepending would
    // double-deliver them — the late joiner's Kit would process the
    // same textselection/invalidateviewcursor twice and diverge.
    serveCheckpoint(ws) {
        if (!this.checkpointHash) return false;
        const cursorFrames = [];
        if (this.checkpointSeq > 0) {
            for (const entry of this.checkpointCursors || []) {
                try { cursorFrames.push(Buffer.from(entry.frame, 'base64')); }
                catch(e) {}
            }
        }
        const info = JSON.stringify({
            first: false,
            hash: this.checkpointHash,
            locator: this.checkpointLocator || null,
            seq: this.checkpointSeq,
            cursorCount: cursorFrames.length,
            msgCount: this.messageLog.length,
        });
        this.sendControl(ws, 0x05, 0, info);
        ws._joinBuffering = true;
        ws._joinBuffer = cursorFrames.concat(this.messageLog.map(m => m.frame));
        ws._expectedHash = this.checkpointHash;
        console.log(`[${this.id}] Served checkpoint hash=${this.checkpointHash} seq=${this.checkpointSeq} cursors=${cursorFrames.length} + ${this.messageLog.length} msgs to viewId=${ws._viewId}`);
        return true;
    }

    announceJoin(viewId) {
        const seq = this.nextSeq();
        const payload = JSON.stringify({ viewId, seq });
        const buf = Buffer.from(payload);
        const frame = Buffer.alloc(5 + buf.length);
        frame[0] = 0x02;
        frame.writeUInt32BE(viewId, 1);
        buf.copy(frame, 5);
        for (const c of this.activeClients) {
            if (c.readyState === WebSocket.OPEN) c.send(frame);
        }
    }

    announceLeave(viewId) {
        const seq = this.nextSeq();
        const payload = JSON.stringify({ viewId, seq });
        const buf = Buffer.from(payload);
        const frame = Buffer.alloc(5 + buf.length);
        frame[0] = 0x03;
        frame.writeUInt32BE(viewId, 1);
        buf.copy(frame, 5);
        for (const c of this.activeClients) {
            if (c.readyState === WebSocket.OPEN) c.send(frame);
        }
    }
}

function getRoom(roomId) {
    if (!rooms.has(roomId)) rooms.set(roomId, new Room(roomId));
    return rooms.get(roomId);
}

// --- HTTP(S) server ---

// Build a JSON-friendly summary of a Room — used by the debug endpoints.
function roomSummary(room) {
    return {
        id: room.id,
        createdAt: room.createdAt,
        ageSec: Math.floor((Date.now() - room.createdAt) / 1000),
        seq: room.seq,
        clientCount: room.clients.size,
        activeCount: room.activeClients.size,
        waitingForCheckpoint: room.waitingForCheckpoint.size,
        checkpointHash: room.checkpointHash,
        checkpointLocator: room.checkpointLocator,
        checkpointSeq: room.checkpointSeq,
        logMsgs: room.messageLog.length,
        debugLogSize: room.debugLog.length,
    };
}

const requestHandler = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Debug UI + API ─────────────────────────────────────────────
    if (req.url === '/debug' || req.url === '/debug/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DEBUG_HTML);
        return;
    }
    if (req.url === '/debug/api/rooms') {
        const items = [];
        for (const room of rooms.values()) items.push(roomSummary(room));
        items.sort((a, b) => b.createdAt - a.createdAt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(items));
        return;
    }
    let m = req.url.match(/^\/debug\/api\/rooms\/([^/]+)\/stream$/);
    if (m) {
        const roomId = decodeURIComponent(m[1]);
        const room = rooms.get(roomId);
        if (!room) { res.writeHead(404); res.end('No such room'); return; }
        // Server-Sent Events for live tailing of new debug records.
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        // Send a backlog snapshot first so the client renders without a
        // gap, then stream new events as they arrive.
        res.write('event: snapshot\ndata: ' + JSON.stringify({
            room: roomSummary(room),
            log: room.debugLog,
        }) + '\n\n');
        const onRec = (rec) => {
            try { res.write('event: rec\ndata: ' + JSON.stringify(rec) + '\n\n'); }
            catch (e) { room.debugListeners.delete(onRec); }
        };
        room.debugListeners.add(onRec);
        // Heartbeat to keep proxies from dropping the connection. SSE
        // comments (lines starting with ':') don't fire any client
        // event, they just keep bytes flowing.
        const hb = setInterval(() => {
            try { res.write(': hb\n\n'); } catch (e) {}
        }, 15000);
        req.on('close', () => {
            clearInterval(hb);
            room.debugListeners.delete(onRec);
        });
        return;
    }
    m = req.url.match(/^\/debug\/api\/rooms\/([^/]+)$/);
    if (m) {
        const roomId = decodeURIComponent(m[1]);
        const room = rooms.get(roomId);
        if (!room) { res.writeHead(404); res.end('No such room'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            room: roomSummary(room),
            log: room.debugLog,
        }));
        return;
    }

    // ── Original /room/:id/file API ────────────────────────────────
    const match = req.url.match(/^\/room\/([^/]+)\/file$/);
    if (!match) { res.writeHead(200); res.end('Checkpoint Relay v3 — debug at /debug/'); return; }

    const roomId = decodeURIComponent(match[1]);
    const room = rooms.get(roomId);

    if (req.method === 'GET') {
        // Metadata only. The relay never stores bytes — late joiners
        // download from `checkpointLocator`.
        if (!room || !room.checkpointHash) { res.writeHead(404); res.end('No checkpoint'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            hash: room.checkpointHash,
            locator: room.checkpointLocator,
            seq: room.checkpointSeq,
        }));
        return;
    }

    if (req.method === 'POST') {
        // Out-of-band checkpoint registration — only used by tests that
        // want to pre-seed a room before any WS client connects. Body:
        // JSON { hash, locator? }. In normal operation the first client's
        // 0x06 registers the checkpoint, and this endpoint is unused.
        const chunks = [];
        let total = 0;
        req.on('data', c => { chunks.push(c); total += c.length; });
        req.on('end', () => {
            try {
                const obj = JSON.parse(Buffer.concat(chunks, total).toString());
                const r = getRoom(roomId);
                const ok = r.registerCheckpoint(
                    obj.hash, obj.locator || null,
                    typeof obj.seq === 'number' ? obj.seq : 0,
                    obj.cursors || []
                );
                res.writeHead(ok ? 200 : 409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    hash: r.checkpointHash, locator: r.checkpointLocator,
                    seq: r.checkpointSeq, accepted: ok,
                }));
            } catch(e) {
                res.writeHead(400);
                res.end('Invalid JSON: ' + e.message);
            }
        });
        return;
    }
    res.writeHead(405); res.end();
};

const server = useSSL
    ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, requestHandler)
    : http.createServer(requestHandler);

// --- WebSocket server ---
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const match = req.url.match(/^\/room\/(.+)/);
    const roomId = match ? match[1] : 'default';

    wss.handleUpgrade(req, socket, head, (ws) => {
        const room = getRoom(roomId);
        room.clients.add(ws);
        ws._roomId = roomId;
        ws._viewId = 0;
        ws._joining = true;
        ws._joinBuffering = false;
        ws._joinBuffer = [];
        ws._expectedHash = null;

        console.log(`[${roomId}] Connected (${room.clients.size} total, ${room.activeClients.size} active)`);
        room.debugAppend('event', {
            event: 'connected',
            clientCount: room.clients.size,
            activeCount: room.activeClients.size,
        });

        ws.on('message', (data) => {
            const buf = Buffer.from(data);
            if (buf.length < 5) return;
            const type = buf[0];
            const viewId = buf.readUInt32BE(1);

            // ── 0x04: Join request ──
            //
            // Three paths, no save-trigger anywhere:
            //   1. First client (no checkpoint yet, no active peers) →
            //      activate immediately; expect this client's 0x06 to
            //      carry { hash, locator } and register the checkpoint.
            //   2. Late joiner AND checkpoint already set → serve
            //      checkpoint + messageLog. Joiner fetches bytes from
            //      `locator`, verifies, sends 0x06 for confirmation.
            //   3. Joiner arrives before the first client's 0x06 has
            //      landed (active peer exists but checkpointHash null) →
            //      park in waitingForCheckpoint. When first 0x06 comes
            //      in, `registerCheckpoint` flushes all parked joiners.
            if (type === 0x04) {
                ws._viewId = viewId;
                console.log(`[${roomId}] JOIN viewId=${viewId} active=${room.activeClients.size} checkpoint=${!!room.checkpointHash} log=${room.messageLog.length}`);

                if (room.checkpointHash) {
                    // Checkpoint exists — serve it. This covers both
                    // "active peer present" and "all peers gone but
                    // room cached" cases (we don't care which).
                    room.serveCheckpoint(ws);
                    return;
                }
                if (room.activeClients.size === 0) {
                    // Genuinely first client. Activate and expect
                    // their 0x06 to register the checkpoint.
                    console.log(`[${roomId}]   → First client — activating, awaiting 0x06 to register checkpoint`);
                    room.sendControl(ws, 0x05, 0, JSON.stringify({ first: true, seq: 0 }));
                    ws._joining = false;
                    room.activeClients.add(ws);
                    return;
                }
                // Active peer present but checkpoint not yet registered.
                // Park until the first client's 0x06 lands.
                console.log(`[${roomId}]   → Waiting for first client's 0x06 to register checkpoint`);
                room.waitingForCheckpoint.add(ws);
                return;
            }

            // ── 0x06: Join ready ──
            //
            // Payload: JSON { hash, locator? }
            //   hash    — sha256 of the plaintext bytes the client loaded
            //   locator — URL the file manager serves those bytes from
            //             (optional; only the FIRST client's 0x06 uses it)
            //
            // First client (_joining=false — already activated on 0x04):
            //   uses this to register the room checkpoint. One-shot.
            // Late joiner (_joining=true, served a checkpoint on 0x04):
            //   confirms hash match. Mismatch → 0x0A redirect at locator.
            if (type === 0x06) {
                let clientHash = null;
                let clientLocator = null;
                if (buf.length > 5) {
                    try {
                        const info = JSON.parse(buf.slice(5).toString());
                        clientHash = info.hash || null;
                        clientLocator = info.locator || null;
                    } catch(e) {}
                }

                if (!ws._joining) {
                    // First client post-activation. Register the
                    // initial checkpoint at seq 0 — this flushes any
                    // joiners parked in waitingForCheckpoint.
                    if (clientHash && !room.checkpointHash) {
                        room.registerCheckpoint(clientHash, clientLocator, 0, []);
                    }
                    return;
                }

                // Late joiner confirming hash.
                const expected = ws._expectedHash || room.checkpointHash;
                if (expected && clientHash && clientHash !== expected) {
                    console.log(`[${roomId}] CHECKPOINT MISMATCH viewId=${viewId}: client=${clientHash.substring(0,16)}… expected=${expected.substring(0,16)}… — redirecting to locator`);
                    room.sendControl(ws, 0x0A, 0, JSON.stringify({
                        expected,
                        locator: room.checkpointLocator,
                        seq: room.checkpointSeq,
                    }));
                    ws._joinBuffering = false;
                    ws._joinBuffer = [];
                    return;
                }

                console.log(`[${roomId}] JOIN READY viewId=${viewId} hash=${(clientHash||'none').substring(0,16)}… replaying ${ws._joinBuffer.length} msgs`);
                for (const frame of ws._joinBuffer) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
                }
                ws._joining = false;
                ws._joinBuffering = false;
                ws._joinBuffer = [];
                ws._expectedHash = null;
                room.activeClients.add(ws);
                room.announceJoin(viewId);
                console.log(`[${roomId}] ACTIVATED viewId=${viewId} (${room.activeClients.size} active)`);
                room.debugAppend('event', {
                    event: 'activated',
                    viewId,
                    name: ws._name || null,
                    activeCount: room.activeClients.size,
                });
                return;
            }

            // ── 0x07: Save-rotation — rotate the room checkpoint ──
            // Payload: JSON { hash, locator, seq, cursors? }
            //   hash     — sha256 of the plaintext bytes just saved
            //   locator  — URL late joiners fetch those bytes from
            //   seq      — last broadcast seq the saving client had
            //              processed when it started the save. Must be
            //              strictly greater than the current
            //              checkpointSeq; the relay rejects otherwise.
            //   cursors  — optional; if the client doesn't provide
            //              them, the relay uses its own live cursor
            //              map (server-authoritative).
            //
            // Effect: registerCheckpoint replaces the tuple and prunes
            // messageLog to seq' > seq. Already-connected peers keep
            // their in-memory state. Future late joiners land on the
            // new baseline.
            if (type === 0x07) {
                if (ws._joining) {
                    console.log(`[${roomId}] 0x07 rejected — viewId=${viewId} not activated`);
                    return;
                }
                if (buf.length <= 5) return;
                let info;
                try { info = JSON.parse(buf.slice(5).toString()); }
                catch(e) {
                    console.log(`[${roomId}] 0x07 rejected — bad JSON: ${e.message}`);
                    return;
                }
                const hash = info.hash;
                const locator = info.locator || null;
                const atSeq = typeof info.seq === 'number' ? info.seq : null;
                if (atSeq == null) {
                    console.log(`[${roomId}] 0x07 rejected — seq required`);
                    return;
                }
                const cursors = Array.isArray(info.cursors) && info.cursors.length
                    ? info.cursors
                    : room.snapshotCursors();
                room.registerCheckpoint(hash, locator, atSeq, cursors);
                return;
            }

            // ── 0x09: Ack ──
            if (type === 0x09) return;

            // ── 0x00: UI message ──
            if (ws._joining) {
                console.log(`[${roomId}] REJECTED msg from joining viewId=${viewId}`);
                return;
            }
            room.broadcast(buf);
        });

        ws.on('close', () => {
            room.clients.delete(ws);
            room.activeClients.delete(ws);
            room.waitingForCheckpoint.delete(ws);
            if (ws._viewId) room.announceLeave(ws._viewId);
            console.log(`[${roomId}] Disconnected (${room.clients.size} total, ${room.activeClients.size} active)`);
            room.debugAppend('event', {
                event: 'disconnected',
                viewId: ws._viewId || 0,
                clientCount: room.clients.size,
                activeCount: room.activeClients.size,
            });
            if (room.clients.size === 0) {
                // If there are unsaved messages since the last checkpoint,
                // keep the room alive so a reconnecting client can replay
                // them. This prevents data loss on hard-refresh when WASM
                // boot takes >60s.
                if (room.messageLog.length > 0) {
                    console.log(`[${roomId}] Room empty but ${room.messageLog.length} unsaved messages — keeping alive`);
                } else {
                    setTimeout(() => {
                        if (room.clients.size === 0 && room.messageLog.length === 0) {
                            rooms.delete(roomId);
                            console.log(`[${roomId}] Room cleaned up (no unsaved messages)`);
                        }
                    }, 60000);
                }
            }
        });
    });
});

server.listen(PORT, () => {
    console.log(`Checkpoint relay on port ${PORT} (v3) [${useSSL ? 'HTTPS' : 'HTTP'}]`);
});
