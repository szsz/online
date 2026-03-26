// Message relay server for COOL WASM.
// Routes messages between browser clients in rooms.
// Phase 1: single user, messages round-trip through the server.
// Phase 2: multiple users, messages broadcast to all in the room.
//
// Protocol: binary frames with 1-byte type prefix
//   0x00 + payload = text from UI (JS → WASM direction)
//   0x01 + payload = text from WASM (WASM → JS direction)
//   0x02 + payload = binary from UI
//   0x03 + payload = binary from WASM
//
// Usage: node wasm/message-relay.js
// Connect: ws://host:9090/room/<room-id>

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

// Room management: Map<roomId, Set<ws>>
const rooms = new Map();

server.on('upgrade', (req, socket, head) => {
    // Parse room ID from URL: /room/<id>
    const match = req.url.match(/^\/room\/(.+)/);
    const roomId = match ? match[1] : 'default';

    wss.handleUpgrade(req, socket, head, (ws) => {
        // Add to room
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
        }
        const room = rooms.get(roomId);
        room.add(ws);
        console.log(`[${roomId}] Client connected (${room.size} in room)`);

        ws.on('message', (data) => {
            for (const client of room) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data);
                }
            }
        });

        ws.on('close', () => {
            room.delete(ws);
            console.log(`[${roomId}] Client disconnected (${room.size} in room)`);
            if (room.size === 0) {
                rooms.delete(roomId);
            }
        });
    });
});

server.listen(PORT, () => {
    console.log(`Message relay on port ${PORT}`);
});
