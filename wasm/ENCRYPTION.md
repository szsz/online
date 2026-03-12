# WASM P2P Co-editing: Encryption Design

## Overview

All data — documents, filenames, and relay messages — is encrypted using keys
derived from a single secret: the **URL fragment** (the part after `#`). The
server never receives this fragment (browsers do not send it in HTTP requests),
so the server operator cannot decrypt any user data.

```
https://host/wasm.html#0bba0cc658077b0fb94581ed573c512a
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                       128-bit random secret (auto-generated if absent)
```

## Key Derivation

All keys are derived from the URL fragment using **HMAC-SHA256** with different
salts. Each derivation is a single HMAC operation — no key stretching is needed
because the fragment is already 128 bits of random entropy.

```
URL Fragment (master secret — never leaves the browser)
│
├─ HMAC-SHA256(salt="cool-blob")  → Document ID     (blob name, relay room ID)
│
├─ HMAC-SHA256(salt="cool-file")  → File Key      (AES-256-GCM, document at rest)
│
├─ HMAC-SHA256(salt="cool-meta")  → Metadata Key  (AES-256-GCM, original filename)
│
└─ HMAC-SHA256(salt="cool-relay") → Relay Key     (AES-256-GCM, WebSocket messages)
```

Each salt produces an independent 256-bit key. Compromising one does not
compromise the others.

### Document ID (blob name + relay room)

```
HMAC-SHA256(key=urlFragment, message="cool-blob") → 64-char hex identifier
```

A deterministic identifier used as the blob name in storage and the relay room
name. Because HMAC is a one-way function, the server can identify *which* blob
is being accessed but cannot reverse it to obtain the encryption key. The same
URL always maps to the same identifier, so every save overwrites the previous
version in place.

**Derived in:** `wasm.html`, `emscripten-module.js`, `relay-client-boot.js`

### File Encryption Key

```
HMAC-SHA256(key=urlFragment, message="cool-file") → 256-bit AES-GCM key
```

Encrypts the document at rest in blob storage. Derived and used exclusively
inside a **Service Worker** (`wasm-crypto-sw.js`) that intercepts all
`/wasm/<hash>` HTTP requests at the browser's network layer:

- **POST** (upload/save): the Service Worker encrypts the plaintext document
  body before it leaves the browser. The server receives only ciphertext.
- **GET** (load): the Service Worker fetches the ciphertext from the server and
  decrypts it before returning it to the WASM module.

This is transparent to the C++ code in `wasmapp.cpp` — `emscripten_fetch`
makes normal HTTP requests and the Service Worker handles
encryption/decryption at the network layer.

**Ciphertext format:** `[12-byte random IV][AES-256-GCM ciphertext]`

**Derived in:** `wasm-crypto-sw.js`

### Metadata Encryption Key

```
HMAC-SHA256(key=urlFragment, message="cool-meta") → 256-bit AES-GCM key
```

Encrypts the original filename before storing it as a `<hash>.meta` blob on the
server. Derivation and encryption happen entirely in the browser (`wasm.html`).
The server stores the ciphertext; only someone with the URL fragment can decrypt
it to see the original filename.

**Ciphertext format:** `Base64( [12-byte random IV][AES-256-GCM ciphertext] )`

**Derived in:** `wasm.html`

### Relay Encryption Key

```
HMAC-SHA256(key=urlFragment, message="cool-relay") → 256-bit AES-GCM key
```

Provides end-to-end encryption for all WebSocket messages between Browser A
(WASM host) and Browser B (thin client) through the relay server.

**Ciphertext format:** `[12-byte random IV][AES-256-GCM ciphertext of [1-byte type T|B][payload]]`

The single-byte type prefix (`T` for text, `B` for binary) is inside the
ciphertext so the relay server cannot observe message types.

**Derived in:** `relay-crypto.js` (runs in both Browser A and Browser B)

## Trust Model

| Component | Can see |
|---|---|
| **Browser (with URL)** | Everything — plaintext document, filename, messages |
| **Server (blob storage)** | File hash (blob name), encrypted document, encrypted filename |
| **Relay server** | File hash (room ID), encrypted messages |
| **Attacker (no URL)** | Nothing — all values require the URL fragment to decrypt |

The server cannot:
- Decrypt stored documents (file key derived in Service Worker, never sent to server)
- Decrypt filenames (metadata key derived in browser)
- Read relay messages (relay key derived in browser)
- Reverse the document ID to obtain the URL fragment (HMAC is one-way)

## Data Flow

### Upload (new document)

```
Browser                          Service Worker                    Server
  │                                   │                              │
  ├─ POST /wasm/<hash> ─────────────→ │                              │
  │   (plaintext document)            │                              │
  │                                   ├─ encrypt(plaintext) ────────→│
  │                                   │   (ciphertext)               │
  │                                   │                              ├─ store blob
  │                                   │                              │
  ├─ POST /wasm/meta/<hash> ─────────────────────────────────────────→│
  │   (AES-encrypted filename)                                       ├─ store meta
```

### Load (open existing document)

```
Browser                          Service Worker                    Server
  │                                   │                              │
  ├─ HEAD /wasm/<hash> ──────────────────────────────────────────────→│
  │   (existence check, no body)                                     │
  │                                   │                              │
  │ ... WASM module starts ...        │                              │
  │                                   │                              │
  │  emscripten_fetch GET /wasm/<hash>→│                              │
  │                                   ├─ fetch(ciphertext) ←─────────┤
  │                                   ├─ decrypt(ciphertext)         │
  │  ←──── plaintext document ────────┤                              │
```

### Auto-save

```
COOLWSD (WASM)                   Service Worker                    Server
  │                                   │                              │
  ├─ POST /wasm/<hash> ─────────────→ │                              │
  │   (plaintext via saveToServer)    │                              │
  │                                   ├─ encrypt(plaintext) ────────→│
  │                                   │   (ciphertext)               │
  │                                   │                              ├─ overwrite blob
```

### Relay (co-editing)

```
Browser A (host)              Relay Server              Browser B (client)
  │                               │                          │
  ├─ AES-GCM encrypt ──────────→ │ ── forward (opaque) ───→ │
  │                               │                          ├─ AES-GCM decrypt
  │                               │                          │
  │  ←── forward (opaque) ─────── │ ←── AES-GCM encrypt ────┤
  ├─ AES-GCM decrypt              │                          │
```

## Sharing

To collaborate on a document, share the full URL including the fragment:

```
https://host/wasm.html#0bba0cc658077b0fb94581ed573c512a
```

Anyone with this URL can:
1. Decrypt and edit the document
2. Join the relay room for real-time co-editing
3. See the original filename

Anyone *without* the fragment sees only opaque hashes and ciphertext.
