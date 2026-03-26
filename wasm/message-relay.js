// Message relay server for COOL WASM co-editing.
// Routes UI input messages between browser clients in rooms.
// Assigns each client a unique viewId.
//
// Protocol: binary frames with header
//   [1 byte type][4 byte viewId][payload]
//
// Types:
//   0x00 = UI text message (from a client's JS UI)
//   0x01 = assign viewId (server → client, payload = empty)
//   0x02 = client joined (server → all, payload = empty)
//   0x03 = client left (server → all, payload = empty)
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

// Room management
const rooms = new Map(); // roomId → { clients: Set<ws> }

server.on('upgrade', (req, socket, head) => {
    const match = req.url.match(/^\/room\/(.+)/);
    const roomId = match ? match[1] : 'default';

    wss.handleUpgrade(req, socket, head, (ws) => {
        // Get or create room
        if (!rooms.has(roomId)) {
            rooms.set(roomId, { clients: new Set() });
        }
        const room = rooms.get(roomId);
        room.clients.add(ws);

        console.log(`[${roomId}] Client connected (${room.clients.size} in room)`);

        ws.on('message', (data) => {
            // Broadcast to ALL clients in the room (including sender)
            for (const client of room.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data);
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
