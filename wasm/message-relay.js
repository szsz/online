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
//   0x05 = join-response  (server -> client, JSON {hash, url, seq, first, msgCount})
//   0x06 = join-ready     (client -> server, payload = JSON {hash} — checkpoint hash verification)
//   0x07 = file-upload    (client -> server, payload = file bytes)
//   0x08 = save-trigger   (server -> one client)
//   0x0A = checkpoint-mismatch (server -> client, JSON {expected, url, seq}) — re-download required

const WebSocket = require('ws');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.PORT || process.env.RELAY_PORT || 9091;
const SSL_CERT = process.env.SSL_CERT || '/etc/letsencrypt/live/wasm.atgpartners.info/fullchain.pem';
const SSL_KEY = process.env.SSL_KEY || '/etc/letsencrypt/live/wasm.atgpartners.info/privkey.pem';

// Detect whether SSL certs are available. On Azure App Service, TLS is
// terminated by the platform so the relay runs plain HTTP/WS internally.
const useSSL = fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);

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

        // Checkpoint
        this.checkpoint = null;
        this.checkpointHash = null;
        this.checkpointSeq = 0;

        // Save coordination
        this.savePending = false;
        this.saveTimeout = null;

        // Message log since checkpoint (for replay)
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

    // Register a checkpoint by hash+seq only. The relay does NOT store the
    // file — that's the file storage server's responsibility. We only track
    // the hash and sequence number for late-join coordination.
    registerCheckpoint(hash, atSeq) {
        // Reject malformed hashes — older clients used to send file bytes
        // through this code path (the relay would .toString() them and
        // store binary as the hash). A subsequent joiner would then
        // perpetually mismatch the real file's SHA-256 from /api/files
        // and loop on 0x0A. Accept only proper hex hashes here.
        if (!Room.isValidHexHash(hash)) {
            console.log(`[${this.id}] registerCheckpoint REJECTED malformed hash (len=${(hash||'').length}, prefix=${(hash||'').substring(0, 8).replace(/[^\x20-\x7e]/g, '?')}…) — keeping previous`);
            return;
        }
        this.checkpointHash = hash;
        this.checkpointSeq = atSeq !== undefined ? atSeq : this.seq;
        this.savePending = false;
        if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }

        // Keep messages AFTER the checkpoint seq — these need to be replayed
        // to any browser that loads this checkpoint file.
        const before = this.messageLog.length;
        this.messageLog = this.messageLog.filter(m => m.seq > this.checkpointSeq);
        if (this.messageLog.length > this.maxLogSize) {
            this.messageLog = this.messageLog.slice(-this.maxLogSize);
        }
        console.log(`[${this.id}] CHECKPOINT: hash=${this.checkpointHash} atSeq=${this.checkpointSeq} roomSeq=${this.seq} replay=${this.messageLog.length} (pruned ${before - this.messageLog.length})`);
        this.debugAppend('event', {
            event: 'checkpoint',
            hash: this.checkpointHash,
            atSeq: this.checkpointSeq,
            roomSeq: this.seq,
            pruned: before - this.messageLog.length,
        });
    }

    // Legacy compat — old clients may still upload file data
    createCheckpoint(buf, atSeq) {
        const hash = crypto.createHash('sha256').update(buf).digest('hex').substring(0, 16);
        this.registerCheckpoint(hash, atSeq);
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

    triggerSave() {
        if (this.savePending) return false;
        for (const client of this.activeClients) {
            if (client.readyState === WebSocket.OPEN) {
                this.savePending = true;
                this.sendControl(client, 0x08, 0, '');
                console.log(`[${this.id}] Save triggered (${this.messageLog.length} unsaved msgs)`);
                this.saveTimeout = setTimeout(() => {
                    this.savePending = false;
                    console.log(`[${this.id}] Save timeout — serving stale checkpoint to waiting joiners`);
                    this._serveCheckpointToWaitingJoiners();
                }, 20000);
                return true;
            }
        }
        return false;
    }

    // Send current checkpoint + replay log to a joining client
    serveCheckpoint(ws) {
        if (!this.checkpointHash) return false;
        // Tell the client to download the checkpoint from the FILE STORAGE
        // SERVER (not the relay). The client knows its WOPISrc and can
        // fetch from FILE_STORAGE_URL/api/files/<WOPISrc>.
        const info = JSON.stringify({
            first: false,
            hash: this.checkpointHash,
            source: 'wopi',   // client downloads from file storage server
            seq: this.checkpointSeq,
            msgCount: this.messageLog.length,
        });
        this.sendControl(ws, 0x05, 0, info);
        ws._joinBuffering = true;
        ws._joinBuffer = this.messageLog.map(m => m.frame); // Copy current log
        ws._expectedHash = this.checkpointHash;
        console.log(`[${this.id}] Served checkpoint hash=${this.checkpointHash} + ${ws._joinBuffer.length} msgs to viewId=${ws._viewId}`);
        return true;
    }

    _serveCheckpointToWaitingJoiners() {
        for (const client of this.clients) {
            if (client._joining && client._waitingForSave && client.readyState === WebSocket.OPEN) {
                client._waitingForSave = false;
                if (this.checkpointHash) {
                    this.serveCheckpoint(client);
                } else {
                    // No checkpoint at all — activate as first
                    this.sendControl(client, 0x05, 0, JSON.stringify({ first: true, seq: this.seq }));
                    client._joining = false;
                    this.activeClients.add(client);
                }
            }
        }
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
        savePending: room.savePending,
        checkpointHash: room.checkpointHash,
        checkpointSeq: room.checkpointSeq,
        unsavedMsgs: room.messageLog.length,
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
        // Return checkpoint metadata only — the file itself is on the
        // file storage server, not the relay.
        if (!room || !room.checkpointHash) { res.writeHead(404); res.end('No checkpoint'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            hash: room.checkpointHash,
            seq: room.checkpointSeq,
        }));
        return;
    }

    if (req.method === 'POST') {
        // Accept hash+seq from client (client already uploaded file to
        // the file storage server).
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const room = getRoom(roomId);
                room.registerCheckpoint(body.hash, body.seq || room.seq);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ hash: room.checkpointHash, seq: room.checkpointSeq }));
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
        ws._waitingForSave = false;
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
            if (type === 0x04) {
                ws._viewId = viewId;
                console.log(`[${roomId}] JOIN viewId=${viewId} active=${room.activeClients.size} checkpoint=${!!room.checkpointHash} unsaved=${room.messageLog.length}`);

                // Classification rules (in order):
                //   1. No active peers AND no checkpoint → genuinely first.
                //      Activate immediately; the client owns the doc.
                //   2. Active peers exist → late joiner, regardless of
                //      whether a checkpoint exists yet. We trigger a fresh
                //      save on the active peer and serve the resulting
                //      checkpoint. (The previous code missed this when
                //      checkpointHash was still null — both tabs of a doc
                //      racing each other ended up classified as "first",
                //      so neither saw the other's edits.)
                //   3. No active peers but a checkpoint exists → late
                //      joiner, no save needed, serve cached.
                if (room.activeClients.size === 0 && !room.checkpointHash) {
                    console.log(`[${roomId}]   → First client (no peers, no checkpoint)`);
                    room.sendControl(ws, 0x05, 0, JSON.stringify({ first: true, seq: 0 }));
                    ws._joining = false;
                    room.activeClients.add(ws);
                    return;
                }
                if (room.activeClients.size === 0) {
                    console.log(`[${roomId}]   → No active peers, serving cached checkpoint`);
                    room.serveCheckpoint(ws);
                    return;
                }
                // Active peer(s) — wait for a fresh save (which may be the
                // active peer's very first save if no checkpoint exists yet).
                console.log(`[${roomId}]   → Active peer present, requesting fresh save (unsaved=${room.messageLog.length}, hasCheckpoint=${!!room.checkpointHash})`);
                ws._waitingForSave = true;
                if (!room.savePending) {
                    room.triggerSave();
                }
                return;
            }

            // ── 0x07: Checkpoint report (hash + seq, NO file) ──
            // The client has already saved the file to the file storage
            // server. It now reports the hash + seq to the relay so we can
            // coordinate late joiners.
            // Frame: [0x07][viewId 4b][seq 4b][hash string (optional)]
            if (type === 0x07) {
                let checkpointSeq = room.seq;
                let hash = null;
                if (buf.length >= 9) {
                    checkpointSeq = buf.readUInt32BE(5);
                    if (buf.length > 9) {
                        // Remaining bytes are the hash string
                        hash = buf.slice(9).toString();
                    }
                }
                if (!hash) {
                    // Legacy: client sent file bytes. Compute hash from data.
                    const fileData = buf.length > 9 ? buf.slice(9) : buf.slice(5);
                    hash = crypto.createHash('sha256').update(fileData).digest('hex').substring(0, 16);
                }

                const hasWaitingJoiners = [...room.clients].some(c => c._waitingForSave);
                const hasDownloadingJoiners = [...room.clients].some(c => c._joinBuffering);

                if (!room.savePending && (hasWaitingJoiners || hasDownloadingJoiners)) {
                    console.log(`[${roomId}] IGNORING voluntary checkpoint (hash=${hash} seq=${checkpointSeq}) — joiners active`);
                    return;
                }

                console.log(`[${roomId}] CHECKPOINT REPORT: hash=${hash}, seq=${checkpointSeq}, roomSeq=${room.seq}`);
                room.registerCheckpoint(hash, checkpointSeq);

                // Notify waiting joiners that checkpoint is ready
                for (const client of room.clients) {
                    if (client._waitingForSave && client.readyState === WebSocket.OPEN) {
                        client._waitingForSave = false;
                        room.serveCheckpoint(client);
                    }
                }
                return;
            }

            // ── 0x06: Join ready (with checkpoint hash verification) ──
            if (type === 0x06) {
                if (!ws._joining) return;

                // Parse the hash the client loaded
                let clientHash = null;
                if (buf.length > 5) {
                    try {
                        const info = JSON.parse(buf.slice(5).toString());
                        clientHash = info.hash;
                    } catch(e) {}
                }

                const expected = ws._expectedHash || room.checkpointHash;

                if (expected && clientHash && clientHash !== expected) {
                    // MISMATCH between what the relay has stored and what
                    // the client just computed from the file storage.
                    //
                    // Telling the client to re-download is a dead-end if the
                    // file in /api/files doesn't actually have the expected
                    // hash — the client downloads the same bytes, computes
                    // the same hash, and we loop forever (0x0A → re-download
                    // → 0x06 → 0x0A → …).
                    //
                    // The file storage is the source of truth. If our
                    // expected hash is stale or junk (legacy bytes-as-string)
                    // and the client's hash is well-formed, accept it: update
                    // our stored hash and let the client activate. The
                    // alternative is the user-visible deadlock the activation
                    // spinner now exposes.
                    if (Room.isValidHexHash(clientHash) && !Room.isValidHexHash(expected)) {
                        console.log(`[${roomId}] CHECKPOINT MISMATCH viewId=${viewId}: stored hash is malformed (legacy junk); accepting client hash=${clientHash}`);
                        room.checkpointHash = clientHash;
                        // fall through to the JOIN READY path
                    } else if (Room.isValidHexHash(clientHash)) {
                        // Both are valid hex but differ. The most likely
                        // cause is a previous client uploaded but never
                        // confirmed via 0x07, or two clients raced. Prefer
                        // the client's hash (which IS what the file storage
                        // currently contains) over our stored value, but log
                        // the divergence so it's diagnosable.
                        console.log(`[${roomId}] CHECKPOINT MISMATCH viewId=${viewId}: client=${clientHash} expected=${expected} — accepting client (storage is source of truth)`);
                        room.checkpointHash = clientHash;
                        // fall through to JOIN READY
                    } else {
                        // Client hash is malformed — old buggy client.
                        // Fall back to the original re-download dance.
                        console.log(`[${roomId}] CHECKPOINT MISMATCH viewId=${viewId}: client=${(clientHash||'').substring(0, 24)}… expected=${expected}`);
                        const info = JSON.stringify({
                            expected: room.checkpointHash,
                            url: `/room/${encodeURIComponent(roomId)}/file`,
                            seq: room.checkpointSeq,
                        });
                        room.sendControl(ws, 0x0A, 0, info);
                        ws._joinBuffering = false;
                        ws._joinBuffer = [];
                        room.serveCheckpoint(ws);
                        return;
                    }
                }

                // Hash matches (or no hash sent — backward compat) — activate
                const bufferedCount = ws._joinBuffer.length;
                console.log(`[${roomId}] JOIN READY viewId=${viewId} hash=${clientHash || 'none'} replaying ${bufferedCount} msgs`);

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
