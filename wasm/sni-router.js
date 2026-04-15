// sni-router.js — listen on :443, route TCP by TLS SNI to a backend.
//
// Each backend does its own TLS termination (with its own cert). This
// router reads only the ClientHello to pick the backend, then pipes
// bytes through. Backends stay on their internal ports.
//
// Configure via env:
//   PORT        listen port (default 443)
//   ROUTES      semicolon-separated host=backend mappings, e.g.
//               "viewer.szebeni.hu=127.0.0.1:6934;wasm.atgpartners.info=127.0.0.1:6932;relay.atgpartners.info=127.0.0.1:9091"
//   DEFAULT     fallback backend "host:port" when SNI doesn't match any route
//   CONNECT_TIMEOUT_MS   backend connect timeout (default 5000)
//   IDLE_TIMEOUT_MS      close if no data for this long (default 0 = never)
//
// Exposed metrics: logs every accept and every route decision.

const net = require('net');

const PORT = parseInt(process.env.PORT || '443', 10);
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || '5000', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS || '0', 10);

function parseRoutes(spec) {
    const routes = new Map();
    for (const entry of (spec || '').split(';').map(s => s.trim()).filter(Boolean)) {
        const eq = entry.indexOf('=');
        if (eq < 0) continue;
        const host = entry.substring(0, eq).trim().toLowerCase();
        const [h, p] = entry.substring(eq + 1).trim().split(':');
        routes.set(host, { host: h || '127.0.0.1', port: parseInt(p, 10) });
    }
    return routes;
}

const ROUTES = parseRoutes(process.env.ROUTES);
const DEFAULT = process.env.DEFAULT
    ? { host: process.env.DEFAULT.split(':')[0], port: parseInt(process.env.DEFAULT.split(':')[1], 10) }
    : null;

if (ROUTES.size === 0 && !DEFAULT) {
    console.error('no ROUTES and no DEFAULT set — nothing to route. Set ROUTES env.');
    process.exit(1);
}

// ── Parse SNI from a buffered TLS ClientHello ──────────────────────
//
// Returns one of:
//   { sni: string }          — found
//   { incomplete: true }     — need more bytes
//   { fatal: 'reason' }      — not TLS / malformed, drop the connection
function parseSNI(buf) {
    if (buf.length < 5) return { incomplete: true };
    // Record header: content_type(1)=0x16 handshake, legacy_version(2), length(2)
    if (buf[0] !== 0x16) return { fatal: 'not-handshake' };
    const recLen = buf.readUInt16BE(3);
    if (buf.length < 5 + recLen) return { incomplete: true };

    let off = 5;
    // Handshake header: msg_type(1)=0x01 ClientHello, length(3)
    if (buf[off] !== 0x01) return { fatal: 'not-client-hello' };
    off += 4;
    // ClientHello: legacy_version(2), random(32)
    off += 2 + 32;
    // legacy_session_id: length(1) + data
    if (off >= buf.length) return { incomplete: true };
    off += 1 + buf[off];
    // cipher_suites: length(2) + data
    if (off + 2 > buf.length) return { incomplete: true };
    off += 2 + buf.readUInt16BE(off);
    // legacy_compression_methods: length(1) + data
    if (off >= buf.length) return { incomplete: true };
    off += 1 + buf[off];
    // extensions: length(2) + data
    if (off + 2 > buf.length) return { incomplete: true };
    const extEnd = off + 2 + buf.readUInt16BE(off);
    off += 2;
    while (off + 4 <= extEnd && off + 4 <= buf.length) {
        const type = buf.readUInt16BE(off);
        const extLen = buf.readUInt16BE(off + 2);
        off += 4;
        if (type === 0x0000) {
            // server_name extension
            // server_name_list length(2)
            if (off + 2 > buf.length) return { incomplete: true };
            let snOff = off + 2;
            // At least one ServerName entry: name_type(1), hostname_length(2), hostname
            while (snOff + 3 <= off + extLen && snOff + 3 <= buf.length) {
                const nameType = buf[snOff];
                const nameLen = buf.readUInt16BE(snOff + 1);
                if (nameType === 0x00) {
                    if (snOff + 3 + nameLen > buf.length) return { incomplete: true };
                    return { sni: buf.slice(snOff + 3, snOff + 3 + nameLen).toString('utf8').toLowerCase() };
                }
                snOff += 3 + nameLen;
            }
            return { fatal: 'sni-extension-malformed' };
        }
        off += extLen;
    }
    // No SNI extension — client didn't send one. Use DEFAULT if set.
    return { sni: null };
}

const server = net.createServer((client) => {
    const peer = `${client.remoteAddress}:${client.remotePort}`;
    let buf = Buffer.alloc(0);
    let decided = false;

    const onData = (chunk) => {
        if (decided) return;  // safety — piping takes over
        buf = Buffer.concat([buf, chunk]);
        const res = parseSNI(buf);
        if (res.incomplete) {
            if (buf.length > 65536) {
                console.log(`[sni] ${peer}: ClientHello too large, closing`);
                client.destroy();
            }
            return;
        }
        if (res.fatal) {
            console.log(`[sni] ${peer}: ${res.fatal}, closing`);
            client.destroy();
            return;
        }
        const sni = res.sni;
        const route = (sni && ROUTES.get(sni)) || DEFAULT;
        if (!route) {
            console.log(`[sni] ${peer}: unknown SNI "${sni || '(none)'}", closing`);
            client.destroy();
            return;
        }
        decided = true;
        client.removeListener('data', onData);

        console.log(`[sni] ${peer} -> ${sni || '(no-sni, default)'} -> ${route.host}:${route.port}`);

        const backend = net.connect({ host: route.host, port: route.port });
        const connectTimer = setTimeout(() => {
            console.log(`[sni] ${peer}: backend ${route.host}:${route.port} connect timeout`);
            backend.destroy();
            client.destroy();
        }, CONNECT_TIMEOUT_MS);

        backend.once('connect', () => {
            clearTimeout(connectTimer);
            backend.write(buf);           // replay buffered ClientHello
            client.pipe(backend);
            backend.pipe(client);
            if (IDLE_TIMEOUT_MS > 0) {
                client.setTimeout(IDLE_TIMEOUT_MS);
                backend.setTimeout(IDLE_TIMEOUT_MS);
                client.on('timeout',  () => { client.destroy();  backend.destroy(); });
                backend.on('timeout', () => { client.destroy();  backend.destroy(); });
            }
        });
        backend.on('error', (e) => {
            clearTimeout(connectTimer);
            console.log(`[sni] ${peer}: backend error ${e.code || e.message}`);
            client.destroy();
        });
        client.on('error', () => backend.destroy());
        client.on('close', () => backend.destroy());
        backend.on('close', () => client.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
});

server.listen(PORT, () => {
    console.log(`SNI router listening on :${PORT}`);
    for (const [host, r] of ROUTES) {
        console.log(`  ${host} -> ${r.host}:${r.port}`);
    }
    if (DEFAULT) console.log(`  (default) -> ${DEFAULT.host}:${DEFAULT.port}`);
});

server.on('error', (e) => {
    if (e.code === 'EACCES' && PORT < 1024) {
        console.error(`Cannot bind :${PORT} — needs root or CAP_NET_BIND_SERVICE.`);
        console.error(`Grant with:  sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))`);
    }
    throw e;
});
