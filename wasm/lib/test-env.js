// Load test environment from wasm/.env
// All tests require FILE_STORAGE_URL, EDITOR_URL, and RELAY_URL.
// Copy wasm/.env.example to wasm/.env and fill in your values.

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
    console.error('ERROR: wasm/.env not found. Copy .env.example to .env and fill in your URLs.');
    process.exit(1);
}

const lines = fs.readFileSync(envPath, 'utf8').split('\n');
for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.substring(0, eq).trim();
    const val = trimmed.substring(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
}

const required = ['FILE_STORAGE_URL', 'EDITOR_URL', 'RELAY_URL'];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`ERROR: ${key} not set in wasm/.env`);
        process.exit(1);
    }
}

// HTTP form of the relay URL — same host/port as RELAY_URL but with
// http(s):// scheme instead of ws(s)://. Used for the relay's REST endpoints
// (e.g. /room/<id>/file) which can't be reached over a WebSocket scheme.
const RELAY_HTTP = (process.env.RELAY_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

module.exports = {
    EDITOR_URL: process.env.EDITOR_URL,
    FILE_STORAGE_URL: process.env.FILE_STORAGE_URL,
    RELAY_URL: process.env.RELAY_URL,
    RELAY_HTTP_URL: RELAY_HTTP,
};
