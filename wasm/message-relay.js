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

const rooms = new Map();

class Room {
    constructor(id) {
        this.id = id;
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
    }

    nextSeq() { return ++this.seq; }

    // Register a checkpoint by hash+seq only. The relay does NOT store the
    // file — that's the file storage server's responsibility. We only track
    // the hash and sequence number for late-join coordination.
    registerCheckpoint(hash, atSeq) {
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
    }

    // Legacy compat — old clients may still upload file data
    createCheckpoint(buf, atSeq) {
        const hash = crypto.createHash('sha256').update(buf).digest('hex').substring(0, 16);
        this.registerCheckpoint(hash, atSeq);
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
const requestHandler = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const match = req.url.match(/^\/room\/([^/]+)\/file$/);
    if (!match) { res.writeHead(200); res.end('Checkpoint Relay v3'); return; }

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

        ws.on('message', (data) => {
            const buf = Buffer.from(data);
            if (buf.length < 5) return;
            const type = buf[0];
            const viewId = buf.readUInt32BE(1);

            // ── 0x04: Join request ──
            if (type === 0x04) {
                ws._viewId = viewId;
                console.log(`[${roomId}] JOIN viewId=${viewId} active=${room.activeClients.size} checkpoint=${!!room.checkpoint} unsaved=${room.messageLog.length}`);

                if (!room.checkpoint) {
                    // No checkpoint at all — first client ever
                    console.log(`[${roomId}]   → First client (no checkpoint)`);
                    room.sendControl(ws, 0x05, 0, JSON.stringify({ first: true, seq: 0 }));
                    ws._joining = false;
                    room.activeClients.add(ws);
                    return;
                }

                // ALWAYS trigger a fresh save when a new browser joins (if there are active peers)
                // This ensures the checkpoint includes ALL prior edits.
                // If no changes since last checkpoint, the save will produce the same file.
                if (room.activeClients.size === 0) {
                    // No active peers — serve current checkpoint directly
                    console.log(`[${roomId}]   → No active peers, serving cached checkpoint`);
                    room.serveCheckpoint(ws);
                    return;
                }

                // Wait for a fresh save before serving
                console.log(`[${roomId}]   → Requesting fresh save (unsaved=${room.messageLog.length})`);
                ws._waitingForSave = true;
                if (!room.savePending) {
                    room.triggerSave();
                }
                // 0x07 handler serves checkpoint to all waiting joiners
                // Timeout fallback in triggerSave
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
                    // MISMATCH — client loaded wrong checkpoint
                    console.log(`[${roomId}] CHECKPOINT MISMATCH viewId=${viewId}: client=${clientHash} expected=${expected}`);
                    // Tell client to re-download
                    const info = JSON.stringify({
                        expected: room.checkpointHash,
                        url: `/room/${encodeURIComponent(roomId)}/file`,
                        seq: room.checkpointSeq,
                    });
                    room.sendControl(ws, 0x0A, 0, info);
                    // Reset join state — client must re-download and re-send 0x06
                    ws._joinBuffering = false;
                    ws._joinBuffer = [];
                    room.serveCheckpoint(ws);
                    return;
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
            if (room.clients.size === 0) {
                setTimeout(() => {
                    if (room.clients.size === 0) {
                        rooms.delete(roomId);
                        console.log(`[${roomId}] Room cleaned up`);
                    }
                }, 60000);
            }
        });
    });
});

server.listen(PORT, () => {
    console.log(`Checkpoint relay on port ${PORT} (v3) [${useSSL ? 'HTTPS' : 'HTTP'}]`);
});
