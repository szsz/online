// Test the relay server: two clients, verify message broadcast
const WebSocket = require('ws');

const RELAY = 'wss://wasm.atgpartners.info:9091/room/test-room';

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
    const type = buf[0];
    const viewId = buf.readUInt32BE(1);
    const payload = buf.slice(5).toString();
    return { type, viewId, payload };
}

const clientA = new WebSocket(RELAY, { rejectUnauthorized: false });
const clientB = new WebSocket(RELAY, { rejectUnauthorized: false });

const viewIdA = 111;
const viewIdB = 222;

let bReceived = [];

clientB.on('message', (data) => {
    const msg = parseFrame(data);
    bReceived.push(msg);
    console.log(`B received: type=${msg.type} viewId=${msg.viewId} payload="${msg.payload}"`);
});

clientA.on('open', () => {
    console.log('A connected');
    clientB.on('open', () => {
        console.log('B connected');
        
        // A sends a message
        console.log('A sending: "hello from A"');
        clientA.send(makeFrame(0x00, viewIdA, 'hello from A'));
        
        // B sends a message
        setTimeout(() => {
            console.log('B sending: "hello from B"');
            clientB.send(makeFrame(0x00, viewIdB, 'hello from B'));
        }, 500);
        
        // Check results
        setTimeout(() => {
            console.log('\n=== Results ===');
            console.log('B received ' + bReceived.length + ' messages:');
            bReceived.forEach((m, i) => {
                console.log(`  ${i}: viewId=${m.viewId} payload="${m.payload}"`);
            });
            
            const fromA = bReceived.filter(m => m.viewId === viewIdA);
            const fromB = bReceived.filter(m => m.viewId === viewIdB);
            console.log('\nFrom A: ' + fromA.length + ' (expected 1)');
            console.log('From B: ' + fromB.length + ' (expected 1, own echo)');
            
            if (fromA.length >= 1) {
                console.log('\n✓ RELAY WORKS: B received A\'s message');
            } else {
                console.log('\n✗ RELAY BROKEN: B did not receive A\'s message');
            }
            
            clientA.close();
            clientB.close();
            process.exit(0);
        }, 1500);
    });
});

clientA.on('error', (e) => console.error('A error:', e.message));
clientB.on('error', (e) => console.error('B error:', e.message));
