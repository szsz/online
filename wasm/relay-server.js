const WebSocket = require('ws');
const http = require('http');
const url = require('url');

const PORT = process.env.RELAY_PORT || 9090;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('COOL WASM Relay Server\n');
});

const wss = new WebSocket.Server({ server });

// Room state: each room has one host and multiple thin clients
const rooms = new Map(); // roomId -> { host: ws, clients: Map<clientId, ws> }
let nextClientId = 1;

wss.on('connection', (ws, req) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const roomId = parsed.query.room || 'default';

    if (pathname === '/host') {
        // Browser A (WASM host) connecting
        if (!rooms.has(roomId)) {
            rooms.set(roomId, { host: null, clients: new Map() });
        }
        const room = rooms.get(roomId);
        room.host = ws;
        console.log(`Host connected to room [${roomId}]`);

        ws.on('message', (data, isBinary) => {
            // Host sends: 1 byte type + 4 byte clientId + payload
            // type 0 = data to client
            const buf = Buffer.from(data);
            if (buf.length < 5) return;
            const type = buf[0];
            const clientId = buf.readUInt32BE(1);
            const payload = buf.slice(5);

            if (type === 0) {
                const preview = payload.slice(0, 80).toString('utf8').replace(/[\r\n]/g, '\\n');
                console.log(`Host->Client ${clientId}: [${payload.length}B] ${preview}`);
                const client = room.clients.get(clientId);
                if (client && client.readyState === WebSocket.OPEN) {
                    client.send(payload, { binary: isBinary });
                } else {
                    console.log(`  Client ${clientId} not found or not open`);
                }
            }
        });

        ws.on('close', () => {
            console.log(`Host disconnected from room [${roomId}]`);
            // Disconnect all thin clients
            for (const [cid, client] of room.clients) {
                client.close();
            }
            rooms.delete(roomId);
        });

    } else if (pathname === '/client') {
        // Browser B (thin client) connecting
        const room = rooms.get(roomId);
        if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
            ws.close(4000, 'No host in room');
            return;
        }

        const clientId = nextClientId++;
        room.clients.set(clientId, ws);
        console.log(`Client ${clientId} connected to room [${roomId}]`);

        // Notify host: new client connected (type 1 = connect)
        const connectMsg = Buffer.alloc(5);
        connectMsg[0] = 1; // connect
        connectMsg.writeUInt32BE(clientId, 1);
        room.host.send(connectMsg);

        ws.on('message', (data, isBinary) => {
            // Forward thin client message to host: type 0 + clientId + payload
            const preview = Buffer.from(data).slice(0, 80).toString('utf8').replace(/[\r\n]/g, '\\n');
            console.log(`Client ${clientId}->Host: [${Buffer.from(data).length}B] ${preview}`);
            if (room.host && room.host.readyState === WebSocket.OPEN) {
                const payload = Buffer.from(data);
                const frame = Buffer.alloc(5 + payload.length);
                frame[0] = 0; // data
                frame.writeUInt32BE(clientId, 1);
                payload.copy(frame, 5);
                room.host.send(frame);
            }
        });

        ws.on('close', () => {
            console.log(`Client ${clientId} disconnected from room [${roomId}]`);
            room.clients.delete(clientId);
            // Notify host: client disconnected (type 2 = disconnect)
            if (room.host && room.host.readyState === WebSocket.OPEN) {
                const disconnectMsg = Buffer.alloc(5);
                disconnectMsg[0] = 2; // disconnect
                disconnectMsg.writeUInt32BE(clientId, 1);
                room.host.send(disconnectMsg);
            }
        });
    } else {
        ws.close(4001, 'Unknown path');
    }
});

server.listen(PORT, () => {
    console.log(`COOL WASM Relay Server listening on port ${PORT}`);
    console.log(`  Host URL:   ws://localhost:${PORT}/host?room=ROOM_ID`);
    console.log(`  Client URL: ws://localhost:${PORT}/client?room=ROOM_ID`);
});
