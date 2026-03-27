// Message relay server for COOL WASM co-editing.
// Routes UI input messages between browser clients in rooms.
//
// Protocol: binary frames with header
//   [1 byte type][4 byte viewId][payload]
//
// Types:
//   0x00 = UI text message (client <-> client)
//   0x01 = assign viewId (server -> client)
//   0x02 = client joined (server -> all)
//   0x03 = client left (server -> all)
//   0x04 = save-request (late joiner -> relay -> one existing client)
//   0x05 = save-complete (existing client -> relay -> late joiner)
//   0x06 = late-join-ready (late joiner -> relay, triggers buffer flush)
//
// Usage: node wasm/message-relay.js

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');

const PORT = process.env.RELAY_PORT || 9091;
const SSL_CERT = process.env.SSL_CERT || '/etc/letsencrypt/live/wasm.atgpartners.info/fullchain.pem';
const SSL_KEY = process.env.SSL_KEY || '/etc/letsencrypt/live/wasm.atgpartners.info/privkey.pem';

const server = https.createServer({
    cert: fs.readFileSync(SSL_CERT),
    key: fs.readFileSync(SSL_KEY),
}, (req, res) => {
    res.writeHead(200);
    res.end('COOL Message Relay');
});

const wss = new WebSocket.Server({ noServer: true });

const rooms = new Map(); // roomId → { clients: Set<ws> }

const LATE_JOIN_TIMEOUT = 120000; // 2 minutes max buffering

server.on('upgrade', (req, socket, head) => {
    const match = req.url.match(/^\/room\/(.+)/);
    const roomId = match ? match[1] : 'default';

    wss.handleUpgrade(req, socket, head, (ws) => {
        if (!rooms.has(roomId)) {
            rooms.set(roomId, { clients: new Set() });
        }
        const room = rooms.get(roomId);
        room.clients.add(ws);

        // Per-client late-join state
        ws.isLateJoiner = false;
        ws.messageBuffer = [];
        ws.saveResponseReceived = false;
        ws.bufferingStartTime = 0;
        ws._roomId = roomId;

        console.log(`[${roomId}] Client connected (${room.clients.size} in room)`);

        ws.on('message', (data) => {
            const buf = Buffer.from(data);
            if (buf.length < 5) return;
            const type = buf[0];

            if (type === 0x04) {
                // Save-request from a late joiner
                // Don't start buffering yet — wait for save-complete.
                // Messages before save-complete are included in the saved file.
                ws.isLateJoiner = true;
                ws.bufferingActive = false; // start buffering only after 0x05
                ws.messageBuffer = [];
                ws.saveResponseReceived = false;
                ws.bufferingStartTime = Date.now();
                console.log(`[${roomId}] Save-request from late joiner`);

                // Forward to ONE existing client that is NOT a late joiner
                // (clients that received "no peers" have saveResponseReceived=true and isLateJoiner=false)
                let sent = false;
                for (const client of room.clients) {
                    if (client !== ws && !client.isLateJoiner && client.readyState === WebSocket.OPEN) {
                        client.send(data);
                        sent = true;
                        console.log(`[${roomId}] Forwarded save-request to existing client`);
                        break;
                    }
                }
                if (!sent) {
                    console.log(`[${roomId}] No existing clients — first client, no save needed`);
                    // Send save-complete with empty payload = "no save needed, you're first"
                    const noSaveFrame = Buffer.alloc(5);
                    noSaveFrame[0] = 0x05;
                    ws.send(noSaveFrame);
                    ws.isLateJoiner = false;
                    ws.saveResponseReceived = true;
                }

                // Set up timeout cleanup
                setTimeout(() => {
                    if (ws.isLateJoiner) {
                        console.log(`[${roomId}] Late joiner timed out, clearing buffer (${ws.messageBuffer.length} msgs)`);
                        ws.isLateJoiner = false;
                        ws.messageBuffer = [];
                    }
                }, LATE_JOIN_TIMEOUT);
                return;
            }

            if (type === 0x05) {
                // Save-complete from existing participant
                console.log(`[${roomId}] Save-complete received`);
                // Forward only to late joiner(s) and START buffering for them
                for (const client of room.clients) {
                    if (client.isLateJoiner && !client.saveResponseReceived && client.readyState === WebSocket.OPEN) {
                        client.saveResponseReceived = true;
                        client.bufferingActive = true; // NOW start buffering
                        client.messageBuffer = [];
                        client.send(data);
                        console.log(`[${roomId}] Forwarded save-complete to late joiner, buffering started`);
                    }
                }
                return;
            }

            if (type === 0x06) {
                // Late-join-ready: flush messages buffered AFTER save-complete.
                // These messages were NOT in the saved file.
                console.log(`[${roomId}] Late joiner ready, replaying ${ws.messageBuffer.length} post-save msgs`);
                for (const msg of ws.messageBuffer) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
                }
                ws.isLateJoiner = false;
                ws.bufferingActive = false;
                ws.messageBuffer = [];
                return;
            }

            // Type 0x00 (and any other): broadcast to all
            for (const client of room.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data);
                }
            }

            // Buffer for late joiners that are past the save point
            for (const client of room.clients) {
                if (client.isLateJoiner && client.bufferingActive && client.readyState === WebSocket.OPEN) {
                    client.messageBuffer.push(Buffer.from(data));
                }
            }
        });

        ws.on('close', () => {
            room.clients.delete(ws);
            console.log(`[${roomId}] Client disconnected (${room.clients.size} in room)`);
            if (room.clients.size === 0) {
                rooms.delete(roomId);
            }
        });
    });
});

server.listen(PORT, () => {
    console.log(`Message relay on port ${PORT}`);
});
