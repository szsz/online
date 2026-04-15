const __cl = require('./lib/inject-checklist');
// Test the strict-ordering relay server v2:
// - Two clients complete join protocol
// - Both send messages
// - Verify: both receive same messages in same order with sequence numbers
// - Verify: sequence numbers are monotonically increasing

const WebSocket = require('ws');
const env = require('./lib/test-env');

const RELAY = env.RELAY_URL + '/room/test-room-' + Date.now();

function makeFrame(type, viewId, text) {
    const payload = Buffer.from(text || '');
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
    if (type === 0x00 && buf.length >= 9) {
        // UI message with seq#: [type 1b][viewId 4b][seq 4b][payload]
        const seq = buf.readUInt32BE(5);
        const payload = buf.slice(9).toString();
        return { type, viewId, seq, payload };
    }
    if (type === 0x05) {
        // Join response
        const payload = buf.slice(5).toString();
        return { type, viewId, payload, json: payload ? JSON.parse(payload) : null };
    }
    return { type, viewId, payload: buf.slice(5).toString() };
}

const viewIdA = 111;
const viewIdB = 222;

let aReceived = [];
let bReceived = [];
let aActivated = false;
let bActivated = false;

const clientA = new WebSocket(RELAY, { rejectUnauthorized: false });
const clientB = new WebSocket(RELAY, { rejectUnauthorized: false });

clientA.on('message', (data) => {
    const msg = parseFrame(data);
    if (msg.type === 0x05) {
        // Join response — send join-ready
        console.log('A got join-response: ' + (msg.json ? JSON.stringify(msg.json) : 'empty'));
        clientA.send(makeFrame(0x06, viewIdA, ''));
        aActivated = true;
        tryRunTest();
        return;
    }
    if (msg.type === 0x00) aReceived.push(msg);
});

clientB.on('message', (data) => {
    const msg = parseFrame(data);
    if (msg.type === 0x05) {
        console.log('B got join-response: ' + (msg.json ? JSON.stringify(msg.json) : 'empty'));
        clientB.send(makeFrame(0x06, viewIdB, ''));
        bActivated = true;
        tryRunTest();
        return;
    }
    if (msg.type === 0x00) bReceived.push(msg);
});

function tryRunTest() {
    if (!aActivated || !bActivated) return;
    console.log('Both activated');

    // A sends 3 messages
    console.log('A sending: "hello from A"');
    clientA.send(makeFrame(0x00, viewIdA, 'hello from A'));
    setTimeout(() => {
        clientA.send(makeFrame(0x00, viewIdA, 'second from A'));
    }, 200);

    // B sends a message between A's messages
    setTimeout(() => {
        console.log('B sending: "hello from B"');
        clientB.send(makeFrame(0x00, viewIdB, 'hello from B'));
    }, 100);

    // Check results
    setTimeout(() => {
        console.log('\n=== Results ===');
        console.log('A received ' + aReceived.length + ' messages');
        console.log('B received ' + bReceived.length + ' messages');

        // Both should have received all 3 messages
        const aFromA = aReceived.filter(m => m.viewId === viewIdA);
        const aFromB = aReceived.filter(m => m.viewId === viewIdB);
        const bFromA = bReceived.filter(m => m.viewId === viewIdA);
        const bFromB = bReceived.filter(m => m.viewId === viewIdB);

        console.log('A got: ' + aFromA.length + ' from self, ' + aFromB.length + ' from B');
        console.log('B got: ' + bFromA.length + ' from A, ' + bFromB.length + ' from self');

        // Check sequence numbers are monotonic
        let seqOk = true;
        for (const received of [aReceived, bReceived]) {
            for (let i = 1; i < received.length; i++) {
                if (received[i].seq <= received[i-1].seq) {
                    console.log('  SEQ ERROR: ' + received[i-1].seq + ' >= ' + received[i].seq);
                    seqOk = false;
                }
            }
        }

        // Check both clients got same messages in same order
        let orderOk = true;
        if (aReceived.length === bReceived.length) {
            for (let i = 0; i < aReceived.length; i++) {
                if (aReceived[i].seq !== bReceived[i].seq ||
                    aReceived[i].payload !== bReceived[i].payload) {
                    console.log('  ORDER MISMATCH at ' + i + ': A.seq=' + aReceived[i].seq +
                        ' B.seq=' + bReceived[i].seq);
                    orderOk = false;
                }
            }
        } else {
            orderOk = false;
        }

        console.log('Sequences monotonic: ' + (seqOk ? 'YES' : 'NO'));
        console.log('Same order both clients: ' + (orderOk ? 'YES' : 'NO'));

        __cl.recordCheck('Two clients connected and joined', aActivated && bActivated);
        __cl.recordCheck('A received own + B messages (>=3)', aReceived.length >= 3, 'count=' + aReceived.length);
        __cl.recordCheck('B received own + A messages (>=3)', bReceived.length >= 3, 'count=' + bReceived.length);
        __cl.recordCheck('Sequence numbers monotonic', seqOk);
        __cl.recordCheck('Same order on both clients', orderOk);

        const passed = aReceived.length >= 3 && bReceived.length >= 3 && seqOk && orderOk;

        if (passed) {
            console.log('\n✓ RELAY WORKS');
            // Print the ordered messages
            for (const m of aReceived) {
                console.log('  seq=' + m.seq + ' viewId=' + m.viewId + ' "' + m.payload + '"');
            }
        } else {
            console.log('\n✗ RELAY BROKEN');
        }

        clientA.close();
        clientB.close();
        process.exit(passed ? 0 : 1);
    }, 2000);
}

clientA.on('open', () => {
    console.log('A connected');
    // Send join request
    clientA.send(makeFrame(0x04, viewIdA, ''));
});

clientB.on('open', () => {
    console.log('B connected');
    clientB.send(makeFrame(0x04, viewIdB, ''));
});

clientA.on('error', (e) => { console.error('A error:', e.message); process.exit(1); });
clientB.on('error', (e) => { console.error('B error:', e.message); process.exit(1); });
setTimeout(() => { console.log('Timeout'); process.exit(1); }, 15000);
