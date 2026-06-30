#!/usr/bin/env node
// Mint a GitHub App installation access token.
//
// Flow:
//   1. Sign an RS256 JWT (10-min TTL) with the App's private key. The App
//      itself authenticates this way to GitHub.
//   2. Call POST /app/installations/<id>/access_tokens to exchange the JWT
//      for an installation token (~1 h TTL). Installation tokens scope to
//      the repos the App is installed on.
//
// Usage:
//   node token.js                       # print installation access token to stdout
//   node token.js --jwt                 # print only the App-level JWT
//   node token.js --installation-id=N   # use a specific installation
//   node token.js --list-installations  # list installations + IDs (one per line)
//
// Config (in priority order):
//   - flags above
//   - env: GH_APP_ID, GH_APP_PRIVATE_KEY_PATH, GH_APP_INSTALLATION_ID
//   - hard-coded defaults below

const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

const DEFAULTS = {
    appId:      '3597037',
    keyPath:    '/home/localadmin/gitapp/szsz-online-bot.2026-05-04.private-key.pem',
    installId:  '',  // empty = auto-detect (first installation)
};

function arg(name) {
    const a = process.argv.find(a => a.startsWith('--' + name + '='));
    if (a) return a.split('=').slice(1).join('=');
    if (process.argv.includes('--' + name)) return true;
    return null;
}

const APP_ID    = process.env.GH_APP_ID || DEFAULTS.appId;
const KEY_PATH  = process.env.GH_APP_PRIVATE_KEY_PATH || DEFAULTS.keyPath;
const INSTALL_ID= arg('installation-id') || process.env.GH_APP_INSTALLATION_ID || DEFAULTS.installId;

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJWT(appId, keyPath) {
    const now = Math.floor(Date.now() / 1000);
    // Subtract 60s from iat to allow for clock skew vs GitHub.
    const header  = { alg: 'RS256', typ: 'JWT' };
    const payload = { iat: now - 60, exp: now + 540, iss: String(appId) };
    const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
    const key = fs.readFileSync(keyPath, 'utf8');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(data), key);
    return data + '.' + b64url(sig);
}

function ghRequest(method, urlPath, token, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : '';
        const req = https.request({
            hostname: 'api.github.com', port: 443, path: urlPath, method,
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'szsz-online-bot/1.0',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            }
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
                } else {
                    reject(new Error(method + ' ' + urlPath + ' → ' + res.statusCode + '\n' + text));
                }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function main() {
    const jwt = signJWT(APP_ID, KEY_PATH);

    if (arg('jwt')) { process.stdout.write(jwt + '\n'); return; }

    if (arg('list-installations')) {
        const installs = await ghRequest('GET', '/app/installations', jwt);
        for (const i of installs) {
            console.log(i.id + '\t' + i.account.login + '\t' + i.repository_selection
                + '\t' + (i.app_slug || ''));
        }
        return;
    }

    let id = INSTALL_ID;
    if (!id) {
        const installs = await ghRequest('GET', '/app/installations', jwt);
        if (!installs.length) throw new Error('App has no installations');
        id = installs[0].id;
    }

    const tok = await ghRequest('POST', '/app/installations/' + id + '/access_tokens', jwt);
    process.stdout.write(tok.token + '\n');
}

main().catch(e => { console.error('ERR: ' + e.message); process.exit(1); });
