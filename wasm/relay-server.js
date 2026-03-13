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
// graceTimer: when host disconnects, room stays alive for 30s for failover
const rooms = new Map(); // roomId -> { host, hostReady, clients, graceTimer, pendingClients }
let nextClientId = 1;

function sendControl(ws, type, clientId) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const msg = Buffer.alloc(5);
    msg[0] = type;
    msg.writeUInt32BE(clientId || 0, 1);
    ws.send(msg);
}

wss.on('connection', (ws, req) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const roomId = parsed.query.room || 'default';

    if (pathname === '/host') {
        // Browser A (WASM host) connecting
        if (!rooms.has(roomId)) {
            rooms.set(roomId, { host: null, hostReady: false, clients: new Map(), graceTimer: null });
        }
        const room = rooms.get(roomId);

        // Reject if room already has a live host
        if (room.host && room.host.readyState === WebSocket.OPEN) {
            console.log(`Host rejected for room [${roomId}] — already has host`);
            ws.close(4001, 'Room already has host');
            return;
        }

        // Cancel grace timer if reconnecting during grace period
        if (room.graceTimer) {
            clearTimeout(room.graceTimer);
            room.graceTimer = null;
            console.log(`New host connected during grace period for room [${roomId}]`);
        }

        room.host = ws;
        room.hostReady = false;
        console.log(`Host connected to room [${roomId}] (${room.clients.size} existing clients, waiting for ready signal)`);

        // Don't announce clients to host or host to clients yet —
        // wait for host to send type=6 (ready) after WASM runtime init.

        function markHostReady(signal) {
            if (room.hostReady) return;
            room.hostReady = true;
            if (room._readyTimer) { clearTimeout(room._readyTimer); room._readyTimer = null; }
            console.log(`Host ready in room [${roomId}] (signal=${signal}), disconnecting ${room.clients.size} stale clients to reconnect fresh`);

            // Disconnect all existing (stale) clients — they were from the
            // old host session. Send type=4 first so they know to reconnect,
            // then close. They'll reload and join as fresh clients.
            for (const [cid, client] of room.clients) {
                sendControl(client, 4, cid);
                client.close(4004, 'Reconnect to new host');
            }
            room.clients.clear();
        }

        // If host doesn't send type=6 within 15s, it's unresponsive — disconnect and failover
        room._readyTimer = setTimeout(() => {
            if (!room.hostReady && room.host === ws) {
                console.log(`Host in room [${roomId}] never became ready, disconnecting`);
                ws.close(4003, 'Host not ready');
            }
        }, 15000);

        ws.on('message', (data, isBinary) => {
            const buf = Buffer.from(data);
            if (buf.length < 5) return;
            const type = buf[0];
            const clientId = buf.readUInt32BE(1);
            const payload = buf.slice(5);

            // Mark host ready (type=6 explicit, or type=0 data implies ready)
            if (!room.hostReady && (type === 6 || type === 0)) {
                markHostReady('type=' + type);
                if (type === 6) return;
            }

            if (type === 0) {
                const client = room.clients.get(clientId);
                if (client && client.readyState === WebSocket.OPEN) {
                    client.send(payload, { binary: isBinary });
                }
            }
        });

        ws.on('close', () => {
            console.log(`Host disconnected from room [${roomId}]`);
            room.host = null;
            room.hostReady = false;
            if (room._readyTimer) { clearTimeout(room._readyTimer); room._readyTimer = null; }

            // Pick ONE client (lowest clientId) as failover candidate
            // Send type=3 (host-lost, you take over) only to that one
            // Send type=5 (wait-for-new-host) to all others
            let failoverCid = null;
            for (const [cid, client] of room.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    if (failoverCid === null || cid < failoverCid) {
                        failoverCid = cid;
                    }
                }
            }
            // Get the failover candidate's name
            const failoverClient = failoverCid !== null ? room.clients.get(failoverCid) : null;
            const failoverName = failoverClient ? (failoverClient._userName || 'someone') : 'someone';

            for (const [cid, client] of room.clients) {
                if (cid === failoverCid) {
                    console.log(`Room [${roomId}]: selected client ${cid} (${failoverName}) for failover`);
                    sendControl(client, 3, 0); // take over as host
                } else {
                    // Send type=5 with failover candidate's name appended
                    const nameBytes = Buffer.from(failoverName, 'utf8');
                    const msg = Buffer.alloc(5 + nameBytes.length);
                    msg[0] = 5;
                    msg.writeUInt32BE(0, 1);
                    nameBytes.copy(msg, 5);
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(msg);
                    }
                }
            }

            // Start 30s grace period for failover
            room.graceTimer = setTimeout(() => {
                console.log(`Grace period expired for room [${roomId}], cleaning up`);
                for (const [cid, client] of room.clients) {
                    client.close(4000, 'Host did not reconnect');
                }
                rooms.delete(roomId);
            }, 30000);
        });

    } else if (pathname === '/client') {
        const room = rooms.get(roomId);
        // Allow connection if room exists (even during grace period with no host)
        if (!room) {
            ws.close(4000, 'No host in room');
            return;
        }

        const clientId = nextClientId++;
        const clientName = parsed.query.name || 'Guest';
        room.clients.set(clientId, ws);
        ws._userName = clientName;
        console.log(`Client ${clientId} (${clientName}) connected to room [${roomId}]`);

        // If host is present and ready, notify it about the new client
        if (room.host && room.host.readyState === WebSocket.OPEN && room.hostReady) {
            sendControl(room.host, 1, clientId);
        } else if (!room.host) {
            // No host (grace period) — immediately tell this client
            sendControl(ws, 3, 0);
        }
        // If host exists but not ready yet, do nothing — host will learn
        // about this client when it sends type=6 (ready)

        ws.on('message', (data, isBinary) => {
            if (room.host && room.host.readyState === WebSocket.OPEN && room.hostReady) {
                const payload = Buffer.from(data);
                const frame = Buffer.alloc(5 + payload.length);
                frame[0] = 0;
                frame.writeUInt32BE(clientId, 1);
                payload.copy(frame, 5);
                room.host.send(frame);
            }
        });

        ws.on('close', () => {
            console.log(`Client ${clientId} disconnected from room [${roomId}]`);
            room.clients.delete(clientId);
            if (room.host && room.host.readyState === WebSocket.OPEN) {
                sendControl(room.host, 2, clientId);
            }
            // If room has no host and no clients, clean up
            if (!room.host && room.clients.size === 0) {
                if (room.graceTimer) clearTimeout(room.graceTimer);
                rooms.delete(roomId);
                console.log(`Room [${roomId}] empty, deleted`);
            }
        });
    } else {
        ws.close(4002, 'Unknown path');
    }
});

server.listen(PORT, () => {
    console.log(`COOL WASM Relay Server listening on port ${PORT}`);
    console.log(`  Host URL:   ws://localhost:${PORT}/host?room=ROOM_ID`);
    console.log(`  Client URL: ws://localhost:${PORT}/client?room=ROOM_ID`);
});
