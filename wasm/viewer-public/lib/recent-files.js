// recent-files.js — LocalStorage registry of files this browser has
// visited. Each entry is {secret, fileId, cachedName, lastVisited}.
//
// The secret is base64url-encoded 128 bits. Without it we cannot
// decrypt the file. The cachedName is plaintext (safe — same browser
// that held the URL fragment).

(function (global) {
    'use strict';

    const KEY = 'rf_v1';

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return { files: [] };
            const obj = JSON.parse(raw);
            if (!obj || !Array.isArray(obj.files)) return { files: [] };
            return obj;
        } catch(e) { return { files: [] }; }
    }
    function save(state) {
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e) {}
    }

    function remember({ secret, fileId, cachedName }) {
        const state = load();
        const existing = state.files.find(f => f.fileId === fileId);
        const now = new Date().toISOString();
        if (existing) {
            existing.lastVisited = now;
            if (cachedName) existing.cachedName = cachedName;
            if (secret) existing.secret = secret;
        } else {
            state.files.push({ secret, fileId, cachedName: cachedName || null, lastVisited: now });
        }
        save(state);
    }

    function forget(fileId) {
        const state = load();
        state.files = state.files.filter(f => f.fileId !== fileId);
        save(state);
    }

    function list() {
        const state = load();
        return state.files.slice().sort((a, b) =>
            String(b.lastVisited).localeCompare(String(a.lastVisited)));
    }

    function find(fileId) {
        return load().files.find(f => f.fileId === fileId) || null;
    }

    global.RecentFiles = { remember, forget, list, find };
})(typeof window !== 'undefined' ? window : globalThis);
