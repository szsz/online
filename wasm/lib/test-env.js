// Load test environment from $ENV_FILE (default $HOME/ENV/online.env) OR
// directly from process.env if the three URLs are already set (CI / wrappers
// that exported them). Env files live outside the repo so they're never
// committed; the launchers and CI scripts share the same convention.

const fs = require('fs');
const path = require('path');

const required = ['FILE_STORAGE_URL', 'EDITOR_URL', 'RELAY_URL'];
const envPath = process.env.ENV_FILE
    || path.join(process.env.HOME || '', 'ENV', 'online.env');

// If the three URLs are already set in process.env (CI scripts export them
// from $ENV_FILE before launching tests), skip the file load.
const allEnvSet = required.every((k) => !!process.env[k]);
if (!allEnvSet) {
    if (!fs.existsSync(envPath)) {
        console.error(`ERROR: env file not found at ${envPath} AND FILE_STORAGE_URL/EDITOR_URL/RELAY_URL not in env.`);
        console.error('       Local dev: create ~/ENV/online.env with the three URLs (and ports/cert paths).');
        console.error('       Or run via the CI scripts which export the values from $ENV_FILE.');
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
        console.error(`ERROR: ${key} not set (neither in ${envPath} nor in process.env)`);
        process.exit(1);
    }
}

// HTTP form of the relay URL — same host/port as RELAY_URL but with
// http(s):// scheme instead of ws(s)://. Used for the relay's REST endpoints
// (e.g. /room/<id>/file) which can't be reached over a WebSocket scheme.
const RELAY_HTTP = (process.env.RELAY_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

// JOBS_SCALE — multiplier for test timeouts when the suite runs under
// contention. run-all-tests.sh exports it from JOBS env (e.g. JOBS=2 →
// JOBS_SCALE=2). Tests pass scale-sensitive timeouts through scaleTimeout
// so they widen automatically instead of false-failing under load.
//
// Default 1.0 keeps solo-run behaviour unchanged. Don't apply this blindly
// to performance-budget assertions — those should keep their original
// numbers so a real perf regression still trips. Use only on "wait for
// thing to happen" timeouts that mark patience, not budget.
const JOBS_SCALE = (() => {
    const raw = process.env.JOBS_SCALE || process.env.TIMEOUT_SCALE;
    if (!raw) return 1.0;
    const n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) return 1.0;
    // Cap at 5× to prevent a typo from making tests hang for hours.
    return Math.min(n, 5.0);
})();

// DOWNLOAD_BUDGET_MS — fixed wall-time padding added on top of the scaled
// timeout for every patience budget. Use it when the test target makes
// the test pay a non-trivial wait that has nothing to do with what the
// test is checking — e.g. fetching a 270 MB online.wasm from Azure App
// Service B-tier on first cold visit. Default 0 (local-server target).
// CI sets it (e.g. 30000) for the Azure smoke phase.
const DOWNLOAD_BUDGET_MS = (() => {
    const raw = process.env.DOWNLOAD_BUDGET_MS;
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(n, 120000);
})();

function scaleTimeout(ms) {
    return Math.round(ms * JOBS_SCALE) + DOWNLOAD_BUDGET_MS;
}

// Iter 82: announce the scale once on first import so per-test logs
// make it obvious whether contention scaling is active. Without this
// a test that times out at ~scaled-budget looks identical to one that
// times out at base — the diagnoser has to hunt for the env var. Only
// log when scale > 1 so default solo runs stay quiet.
if (JOBS_SCALE > 1 && !process.env.__JOBS_SCALE_ANNOUNCED) {
    process.env.__JOBS_SCALE_ANNOUNCED = '1';
    // eslint-disable-next-line no-console
    console.log(`[test-env] JOBS_SCALE=${JOBS_SCALE} — patience timeouts widen by ${JOBS_SCALE}×`);
}
if (DOWNLOAD_BUDGET_MS > 0 && !process.env.__DOWNLOAD_BUDGET_ANNOUNCED) {
    process.env.__DOWNLOAD_BUDGET_ANNOUNCED = '1';
    // eslint-disable-next-line no-console
    console.log(`[test-env] DOWNLOAD_BUDGET_MS=${DOWNLOAD_BUDGET_MS} — added to every patience budget for slow-remote download wait`);
}

// Per-deploy editor folder id. Each editor build deploys to
// ${EDITOR_URL}/<EDITOR_DEPLOY_ID>/. The CI deploy step exports this
// (resolved from APP_BUILD_ID) into the test process's env. When unset
// (local dev with a flat editor, or pre-Phase-2 deploys), tests should
// fall through to the legacy non-prefixed URLs — i.e.
//   `${EDITOR_URL}${EDITOR_DEPLOY_PREFIX}/browser/cool.html`
// where EDITOR_DEPLOY_PREFIX is '' (empty) for flat and
// '/2026-05-11-085500' for per-deploy.
const EDITOR_DEPLOY_ID = (process.env.EDITOR_DEPLOY_ID || '').trim();
const EDITOR_DEPLOY_PREFIX = EDITOR_DEPLOY_ID ? '/' + EDITOR_DEPLOY_ID : '';

module.exports = {
    EDITOR_URL: process.env.EDITOR_URL,
    FILE_STORAGE_URL: process.env.FILE_STORAGE_URL,
    RELAY_URL: process.env.RELAY_URL,
    RELAY_HTTP_URL: RELAY_HTTP,
    VIEWER_URL: process.env.VIEWER_URL,
    EDITOR_DEPLOY_ID,
    EDITOR_DEPLOY_PREFIX,
    JOBS_SCALE,
    scaleTimeout,
};
