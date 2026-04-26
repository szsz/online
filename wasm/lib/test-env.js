// Load test environment from wasm/.env (local dev) OR from process.env (CI).
// All tests require FILE_STORAGE_URL, EDITOR_URL, and RELAY_URL.
// Copy wasm/.env.example to wasm/.env and fill in your values for local dev,
// or export the three URLs in env (CI does this from wasm/.env.deploy
// pointing at the deployed Azure App Services).

const fs = require('fs');
const path = require('path');

const required = ['FILE_STORAGE_URL', 'EDITOR_URL', 'RELAY_URL'];
const envPath = path.join(__dirname, '..', '.env');

// If the three URLs are already set in process.env (CI: TEST_TARGET=azure-deploy),
// skip the .env file requirement entirely. Otherwise load wasm/.env.
const allEnvSet = required.every((k) => !!process.env[k]);
if (!allEnvSet) {
    if (!fs.existsSync(envPath)) {
        console.error('ERROR: wasm/.env not found AND FILE_STORAGE_URL/EDITOR_URL/RELAY_URL not in env.');
        console.error('       Local dev: copy .env.example to .env and fill in your URLs.');
        console.error('       CI: export the three URLs from .env.deploy before running tests.');
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
}

for (const key of required) {
    if (!process.env[key]) {
        console.error(`ERROR: ${key} not set (neither in wasm/.env nor in process.env)`);
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
