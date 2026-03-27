// Smart message relay server for COOL WASM co-editing.
// Handles message routing, file storage, and late-join coordination.
//
// Protocol: binary frames with header
//   [1 byte type][4 byte viewId][payload]
//
// Types:
//   0x00 = UI message (client <-> client, broadcast)
//   0x01 = assign viewId (server -> client)
//   0x02 = client joined (server -> all)
//   0x03 = client left (server -> all)
//   0x04 = save-request (late joiner -> server)
//   0x05 = save-complete (server -> late joiner, payload = JSON {hash, url})
//   0x06 = late-join-ready (late joiner -> server, triggers buffer flush)
//   0x07 = file-upload (client -> server, payload = file bytes)
//   0x08 = save-trigger (server -> one client, asks to upload file via 0x07)
//
// HTTP endpoints (on same port):
//   GET  /room/<roomId>/file   — download current room file
//   POST /room/<roomId>/file   — upload file to room
//
// Usage: node wasm/message-relay.js

const WebSocket = require('ws');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const PORT = process.env.RELAY_PORT || 9091;
const SSL_CERT = process.env.SSL_CERT || '/etc/letsencrypt/live/wasm.atgpartners.info/fullchain.pem';
const SSL_KEY = process.env.SSL_KEY || '/etc/letsencrypt/live/wasm.atgpartners.info/privkey.pem';

// Room state: tracks clients, file, and message history
const rooms = new Map(); // roomId → Room

class Room {
    constructor(id) {
        this.id = id;
        this.clients = new Set();
        this.file = null;       // Buffer: current document bytes
        this.fileHash = null;   // SHA-256 of current file
        this.savePending = false;
    }

    setFile(buf) {
        this.file = Buffer.from(buf);
        this.fileHash = crypto.createHash('sha256').update(this.file).digest('hex').substring(0, 16);
        console.log(`[${this.id}] File stored: ${this.file.length} bytes, hash=${this.fileHash}`);
    }
}

function getRoom(roomId) {
    if (!rooms.has(roomId)) rooms.set(roomId, new Room(roomId));
    return rooms.get(roomId);
}

const LATE_JOIN_TIMEOUT = 120000;

// --- HTTPS server with file endpoints ---
const server = https.createServer({
    cert: fs.readFileSync(SSL_CERT),
    key: fs.readFileSync(SSL_KEY),
}, (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const match = req.url.match(/^\/room\/([^/]+)\/file$/);
    if (!match) {
        res.writeHead(200);
        res.end('COOL Smart Relay');
        return;
    }

    const roomId = decodeURIComponent(match[1]);
    const room = rooms.get(roomId);

    if (req.method === 'GET') {
        if (!room || !room.file) {
            res.writeHead(404);
            res.end('No file in room');
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'X-File-Hash': room.fileHash,
            'Content-Length': room.file.length,
        });
        res.end(room.file);
        console.log(`[${roomId}] File served: ${room.file.length} bytes`);
        return;
    }

    if (req.method === 'POST') {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const buf = Buffer.concat(chunks);
            const room = getRoom(roomId);
            room.setFile(buf);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hash: room.fileHash, size: buf.length }));
        });
        return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
});

// --- WebSocket server ---
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const match = req.url.match(/^\/room\/(.+)/);
    const roomId = match ? match[1] : 'default';

    wss.handleUpgrade(req, socket, head, (ws) => {
        const room = getRoom(roomId);
        room.clients.add(ws);

        ws.isLateJoiner = false;
        ws.bufferingActive = false;
        ws.messageBuffer = [];
        ws.saveResponseReceived = false;
        ws._roomId = roomId;

        console.log(`[${roomId}] Client connected (${room.clients.size} in room)`);

        ws.on('message', (data) => {
            const buf = Buffer.from(data);
            if (buf.length < 5) return;
            const type = buf[0];
            const viewId = buf.readUInt32BE(1);

            // --- 0x04: Save-request from late joiner ---
            if (type === 0x04) {
                ws.isLateJoiner = true;
                ws.bufferingActive = false;
                ws.messageBuffer = [];
                ws.saveResponseReceived = false;
                ws.bufferingStartTime = Date.now();

                // Always ask an existing client to save (to get latest edits)
                let sent = false;
                for (const client of room.clients) {
                    if (client !== ws && !client.isLateJoiner && client.readyState === WebSocket.OPEN) {
                        // Send save-trigger (0x08) to this client
                        const triggerFrame = Buffer.alloc(5);
                        triggerFrame[0] = 0x08;
                        triggerFrame.writeUInt32BE(viewId, 1);
                        client.send(triggerFrame);
                        sent = true;
                        console.log(`[${roomId}] Asked existing client to save`);
                        break;
                    }
                }
                if (!sent) {
                    if (room.file) {
                        // No active peers but we have a cached file — serve it
                        console.log(`[${roomId}] No active peers, serving cached file (hash=${room.fileHash})`);
                        ws.saveResponseReceived = true;
                        ws.bufferingActive = true;
                        ws.messageBuffer = [];
                        const payload = JSON.stringify({
                            hash: room.fileHash,
                            url: `/room/${encodeURIComponent(roomId)}/file`,
                        });
                        const payloadBuf = Buffer.from(payload);
                        const frame = Buffer.alloc(5 + payloadBuf.length);
                        frame[0] = 0x05;
                        frame.writeUInt32BE(0, 1);
                        payloadBuf.copy(frame, 5);
                        ws.send(frame);
                    } else {
                        // No peers, no file — first client
                        console.log(`[${roomId}] No peers — first client`);
                        const frame = Buffer.alloc(5);
                        frame[0] = 0x05;
                        ws.send(frame);
                        ws.isLateJoiner = false;
                        ws.saveResponseReceived = true;
                    }
                }

                setTimeout(() => {
                    if (ws.isLateJoiner) {
                        console.log(`[${roomId}] Late joiner timeout (${ws.messageBuffer.length} buffered)`);
                        ws.isLateJoiner = false;
                        ws.bufferingActive = false;
                        ws.messageBuffer = [];
                    }
                }, LATE_JOIN_TIMEOUT);
                return;
            }

            // --- 0x07: File upload from client ---
            // Always update the cached file. This keeps the relay's copy current.
            if (type === 0x07) {
                const fileData = buf.slice(5);
                room.setFile(fileData);

                // Notify any waiting late joiners
                for (const client of room.clients) {
                    if (client.isLateJoiner && !client.saveResponseReceived && client.readyState === WebSocket.OPEN) {
                        client.saveResponseReceived = true;
                        client.bufferingActive = true;
                        client.messageBuffer = [];
                        const payload = JSON.stringify({
                            hash: room.fileHash,
                            url: `/room/${encodeURIComponent(roomId)}/file`,
                        });
                        const payloadBuf = Buffer.from(payload);
                        const frame = Buffer.alloc(5 + payloadBuf.length);
                        frame[0] = 0x05;
                        frame.writeUInt32BE(0, 1);
                        payloadBuf.copy(frame, 5);
                        client.send(frame);
                        console.log(`[${roomId}] File received, notified late joiner (hash=${room.fileHash})`);
                    }
                }
                return;
            }

            // --- 0x06: Late-join-ready ---
            if (type === 0x06) {
                console.log(`[${roomId}] Late joiner ready, replaying ${ws.messageBuffer.length} post-save msgs`);
                for (const msg of ws.messageBuffer) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
                }
                ws.isLateJoiner = false;
                ws.bufferingActive = false;
                ws.messageBuffer = [];
                return;
            }

            // --- 0x00+: Normal broadcast ---
            for (const client of room.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data);
                }
            }
            // Buffer for active late joiners
            for (const client of room.clients) {
                if (client.bufferingActive && client.readyState === WebSocket.OPEN) {
                    client.messageBuffer.push(Buffer.from(data));
                }
            }
        });

        ws.on('close', () => {
            room.clients.delete(ws);
            console.log(`[${roomId}] Client disconnected (${room.clients.size} in room)`);
            if (room.clients.size === 0) {
                // Keep room for a while in case someone rejoins
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
    console.log(`Smart relay on port ${PORT}`);
});
