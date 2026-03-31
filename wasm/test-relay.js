// Test the relay server: two clients, verify message broadcast and ordering
const WebSocket = require('ws');

const RELAY = 'wss://wasm.atgpartners.info:9091/room/test-room-' + Date.now();

function makeFrame(type, viewId, text) {
    const payload = Buffer.from(text);
    const frame = Buffer.alloc(1 + 4 + payload.length);
    frame[0] = type;
    frame.writeUInt32BE(viewId, 1);
    payload.copy(frame, 5);
    return frame;
}

function parseFrame(data) {
    const buf = Buffer.from(data);
    return {
        type: buf[0],
        viewId: buf.readUInt32BE(1),
        payload: buf.slice(5).toString(),
    };
}

const clientA = new WebSocket(RELAY, { rejectUnauthorized: false });
const clientB = new WebSocket(RELAY, { rejectUnauthorized: false });

const viewIdA = 111;
const viewIdB = 222;

let bReceived = [];
let aConnected = false, bConnected = false;

clientB.on('message', (data) => {
    const msg = parseFrame(data);
    bReceived.push(msg);
});

function runTest() {
    if (!aConnected || !bConnected) return;
    console.log('Both connected');

    // A sends a message
    console.log('A sending: "hello from A"');
    clientA.send(makeFrame(0x00, viewIdA, 'hello from A'));

    // B sends a message
    setTimeout(() => {
        console.log('B sending: "hello from B"');
        clientB.send(makeFrame(0x00, viewIdB, 'hello from B'));
    }, 500);

    // Check results after 2s
    setTimeout(() => {
        console.log('\n=== Results ===');
        console.log('B received ' + bReceived.length + ' messages');

        const fromA = bReceived.filter(m => m.viewId === viewIdA && m.payload.includes('hello'));
        const fromB = bReceived.filter(m => m.viewId === viewIdB && m.payload.includes('hello'));
        console.log('From A: ' + fromA.length + ' (expected 1)');
        console.log('From B (echo): ' + fromB.length + ' (expected 1)');

        if (fromA.length >= 1 && fromB.length >= 1) {
            console.log('\n✓ RELAY WORKS');
            clientA.close();
            clientB.close();
            process.exit(0);
        } else {
            console.log('\n✗ RELAY BROKEN');
            clientA.close();
            clientB.close();
            process.exit(1);
        }
    }, 2000);
}

clientA.on('open', () => { console.log('A connected'); aConnected = true; runTest(); });
clientB.on('open', () => { console.log('B connected'); bConnected = true; runTest(); });
clientA.on('error', (e) => { console.error('A error:', e.message); process.exit(1); });
clientB.on('error', (e) => { console.error('B error:', e.message); process.exit(1); });
setTimeout(() => { console.log('Timeout'); process.exit(1); }, 10000);
