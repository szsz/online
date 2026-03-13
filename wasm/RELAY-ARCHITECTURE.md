# COOL WASM P2P Co-editing: Architecture Overview

## Goal

Enable collaborative editing of the same document across multiple browser tabs/windows, where only one browser runs the full Collabora Online WASM stack (LibreOffice + COOLWSD), and additional browsers connect as thin clients through a relay server. All data is end-to-end encrypted using keys derived from the URL fragment — the server operator cannot decrypt any user data.

## URL Structure

```
https://host/wasm.html#0bba0cc658077b0fb94581ed573c512a
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                       128-bit random secret (auto-generated if absent)
```

The URL fragment is the master secret. It never leaves the browser (browsers do not send fragments in HTTP requests). All encryption keys, the document ID (blob name), and the relay room ID are derived from it via HMAC-SHA256. See `ENCRYPTION.md` for full key derivation details.

## High-Level Architecture

```
Browser A (WASM Host)                    Browser B (Thin Client)
+---------------------------+            +---------------------------+
| wasm.html (upload UI)     |            | wasm.html / relay-client  |
|   cool.html (iframe)      |            |   cool.html (iframe)      |
|     LibreOffice (WASM)    |            |     COOL JS UI (bundle.js)|
|     COOLWSD Server        |            |     FakeWebSocket          |
|     DocumentBroker        |            |     relay-client-boot.js   |
|       Session 1 (local)   |            |     relay-crypto.js        |
|       Session 2 (remote)  |            +-------------|-------------+
|     relay-host.js         |                          |
|     relay-crypto.js       |                          |
|   wasm-crypto-sw.js (SW)  |                          |
+-------------|-------------+                          |
              |                                        |
              | WebSocket (E2E encrypted)              | WebSocket (E2E encrypted)
              | [5-byte header][AES-GCM ciphertext]    | [AES-GCM ciphertext]
              |                                        |
         +----v----------------------------------------v----+
         |           Relay Server (Node.js)                  |
         |           relay-server.js                         |
         |           Sees only opaque ciphertext             |
         +---------------------------------------------------+
                              |
                     (cannot decrypt)
```

## Deployment

Two servers are required:

### Static Server (`server.js` in static-deploy)

- Serves all files from `public/` with COOP/COEP headers (required for SharedArrayBuffer/WASM pthreads)
- `/` defaults to `wasm.html`
- `/config.js` — runtime config (relay URL, CDN URL) from environment variables
- `/wasm/<hash>` — WOPI-like document load/save via Azure Blob Storage (or local fallback)
- `/wasm/meta/<hash>` — encrypted filename metadata storage
- The Service Worker (`wasm-crypto-sw.js`) intercepts `/wasm/<hash>` requests to encrypt/decrypt transparently

### Relay Server (`relay-server.js`)

- Lightweight Node.js WebSocket server routing messages between host and thin clients
- Default port 9090
- `/host?room=ROOM_ID` — WASM host connects here
- `/client?room=ROOM_ID&name=NAME` — thin clients connect here
- Room-based routing with host-ready handshake and failover support

## Components

### Browser A: WASM Host

Browser A runs the complete Collabora Online stack compiled to WebAssembly:

- **wasm.html** — entry point UI for file upload/selection, generates URL fragment if absent, registers Service Worker, derives document ID from fragment
- **cool.html** (iframe) — loads the WASM module and COOL JS client
- **LibreOffice Core** (compiled to WASM via Emscripten) — the actual document engine
- **COOLWSD** — the Collabora Online WebSocket Daemon, managing sessions and document state
- **DocumentBroker** — manages the loaded document and multiple client sessions
- **FakeSocket** — in-process socket emulation (replaces real TCP sockets in WASM/mobile builds)
- **emscripten-module.js** — creates the Emscripten module config, handles CDN URLs, file uploads, and relay host connection via `onRuntimeInitialized`
- **relay-host.js** — JavaScript bridge that connects COOLWSD to the relay server, manages client sessions, encrypts/decrypts via `relay-crypto.js`
- **relay-crypto.js** — derives AES-256-GCM key from URL fragment (salt `cool-relay`), encrypts outgoing and decrypts incoming relay messages
- **wasm-crypto-sw.js** — Service Worker that intercepts `/wasm/<hash>` HTTP requests, encrypts POST bodies and decrypts GET responses using a separate file key (salt `cool-file`)

The host manages both a local session (for its own UI) and remote sessions (one per thin client). Each remote session has its own FakeSocket connection to COOLWSD and a dedicated forwarding thread.

### Browser B: Thin Client

Browser B runs the standard COOL JavaScript UI (`bundle.js`, `global.js`) but without the WASM binary:

- **wasm.html** — same entry point; detects existing document via URL fragment hash, loads the relay client iframe instead of the WASM host iframe
- **relay-client.html** — derived from `cool.html`, replaces `online.js` (WASM) and `emscripten-module.js` with `relay-client-boot.js`
- **relay-client-boot.js** — provides stub `createEmscriptenModule`/`createOnlineModule` functions, overrides `postMobileMessage` to send through relay, handles initialization sequence and failover
- **relay-crypto.js** — same encryption module as host; derives the same relay key from the shared URL fragment
- **FakeWebSocket** — COOL's built-in socket abstraction, now routed through the relay instead of to WASM
- **Background WASM preloading** — thin clients preload WASM assets into Cache API so failover to host is fast

### Relay Server

A lightweight Node.js WebSocket server (`relay-server.js`) that routes messages between the host and thin clients:

- **Room-based routing**: Each document editing session is a "room" identified by the document ID hash (derived from URL fragment)
- **Binary framing protocol**: Host messages use a 5-byte header (1 byte type + 4 bytes client ID) followed by encrypted payload
- **Message types**:
  - `0` = data (encrypted payload)
  - `1` = client connected (server → host)
  - `2` = client disconnected (server → host)
  - `3` = host lost, you take over (server → failover client)
  - `4` = host restored, reconnect (server → clients)
  - `5` = wait for new host (server → non-failover clients, includes failover candidate name)
  - `6` = host ready (host → server, sent after WASM runtime init + document load)
- **Transparent forwarding**: The relay strips headers for client-bound messages and adds headers for host-bound messages. All payloads are opaque ciphertext.
- **Host-ready handshake**: New host must send type=6 within 15s or gets disconnected. Clients are not announced until host is ready.
- **Failover**: When host disconnects, lowest-clientId client is selected to take over (type=3). Others receive type=5 with the failover candidate's name. 30s grace period before room cleanup.

## Encryption Layer

All relay messages are encrypted end-to-end using AES-256-GCM with a key derived from the URL fragment. See `ENCRYPTION.md` for the full key derivation scheme.

| Layer | Key Salt | Derived In | Purpose |
|---|---|---|---|
| Document at rest | `cool-blob` → ID, `cool-file` → AES key | `wasm.html`, `wasm-crypto-sw.js` | Blob name + file encryption |
| Filename metadata | `cool-meta` | `wasm.html` | Encrypted original filename |
| Relay messages | `cool-relay` | `relay-crypto.js` | E2E encrypted WebSocket messages |
| Room/blob ID | `cool-blob` | `wasm.html`, `emscripten-module.js`, `relay-client-boot.js` | Deterministic document identifier |

## Message Flow

### Outgoing (Browser B -> COOLWSD)

```
User action in Browser B
  -> bundle.js calls FakeWebSocket.send(msg)
  -> FakeWebSocket.send calls postMobileMessage(msg)
  -> postMobileMessage calls relaySend(msg)
  -> relay-crypto.js encrypts: AES-GCM([type byte][payload]) -> [IV][ciphertext]
  -> Encrypted message sent via relay WebSocket
  -> Relay server wraps: [type=0][clientId][opaque payload] -> host WebSocket
  -> relay-host.js receives, extracts clientId + encrypted payload
  -> relay-crypto.js decrypts payload
  -> Calls Module._handle_remote_message(wasmClientId, plaintext)
  -> C++ writes to FakeSocket -> COOLWSD ClientSession -> Kit
```

### Incoming (COOLWSD -> Browser B)

```
Kit renders tile / sends status update
  -> COOLWSD writes to FakeSocket
  -> C++ forwarding thread reads from FakeSocket
  -> Calls send2RemoteJS(clientId, data) via MAIN_THREAD_EM_ASM
  -> JS callback: globalThis.onRemoteClientMessage(wasmClientId, data)
  -> relay-host.js calls sendToRelay(wasmClientId, data)
  -> relay-crypto.js encrypts: AES-GCM([type byte][payload]) -> [IV][ciphertext]
  -> Frame: [type=0][relayClientId][encrypted payload] -> relay WebSocket
  -> Relay server strips header, forwards opaque payload to client WebSocket
  -> relay-client-boot.js receives ArrayBuffer
  -> relay-crypto.js decrypts -> original type (text/binary) + payload
  -> Newline check for binary tile data: has newline = pass as Uint8Array
  -> Calls TheFakeWebSocket.onmessage({data}) -> bundle.js processes message
```

### Document Load/Save (via Service Worker)

```
Browser A                        wasm-crypto-sw.js (SW)              Static Server
  |                                   |                                   |
  |  POST /wasm/<hash> (plaintext) -> |                                   |
  |                                   | -- encrypt -> POST (ciphertext) ->|
  |                                   |                                   | store blob
  |                                   |                                   |
  |  GET /wasm/<hash> (from WASM) --> |                                   |
  |                                   | <-- fetch ciphertext -------------|
  |                                   | -- decrypt                        |
  |  <-- plaintext ------------------|                                   |
```

### Session Lifecycle

1. Browser B opens `wasm.html#<fragment>` → derives document ID hash → connects to relay `/client?room=<hash>`
2. Relay notifies host (type=1 message with clientId)
3. `relay-host.js` calls `Module._create_remote_client()` (C++)
4. C++ spawns a pthread, calls `fakeSocketConnect()` to COOLWSD
5. COOLWSD creates a new ClientSession + ChildSession (new document view)
6. C++ sends `fileURL` as first message (equivalent to WebSocket upgrade)
7. C++ notifies JS via `onRemoteClientReady` callback
8. `relay-host.js` flushes any queued messages for that client
9. Browser B sends `coolclient` + `load url=...` (encrypted) to complete initialization
10. COOLWSD responds with status, tiles, UI data (all encrypted through relay)
11. On disconnect: relay notifies host (type=2), C++ calls `fakeSocketClose`

### Host Ready Sequence

1. Host connects to relay `/host?room=<hash>` → server sets `hostReady=false`
2. Host loads WASM module → `emscripten-module.js` hooks `onRuntimeInitialized`
3. On runtime init: `RelayHost.connect()` called with `_deferReady=true` (no type=6 yet)
4. Poll for `TheFakeWebSocket.onmessage` to detect `status:` message (document loaded)
5. On `status:` received → `RelayHost.sendReady()` sends type=6 to relay
6. Relay marks host ready, disconnects any stale clients (type=4) so they reconnect fresh
7. New client connections are now announced to host (type=1)

### Failover Sequence

1. Host disconnects (browser closed, crash, etc.)
2. Relay selects lowest-clientId client → sends type=3 (take over as host)
3. Other clients receive type=5 (wait, with failover candidate's name)
4. Selected client's `relay-client-boot.js` posts `relay-host-lost` to parent `wasm.html`
5. `wasm.html` reloads iframe as WASM host (assets already cached via background preload)
6. New host connects to relay, sends type=6 when ready
7. Relay sends type=4 to remaining clients → they reconnect as fresh thin clients

## File Manifest

| File | Location | Purpose |
|---|---|---|
| `wasm.html` | `public/` | Entry point: upload UI, fragment management, iframe orchestration |
| `cool.html` | `public/` | COOL JS client, loads WASM module |
| `emscripten-module.js` | `wasm/` | Emscripten module config, CDN, relay host auto-connect |
| `relay-host.js` | `wasm/` | Host-side relay bridge (JS ↔ COOLWSD ↔ relay) |
| `relay-client-boot.js` | `wasm/` | Thin client relay boot (replaces WASM module) |
| `relay-client.html` | `wasm/` | Thin client HTML (cool.html without WASM) |
| `relay-server.js` | `wasm/` | Node.js WebSocket relay server |
| `relay-crypto.js` | `wasm/` | E2E encryption for relay messages (AES-256-GCM) |
| `wasm-crypto-sw.js` | `public/` | Service Worker for transparent file encryption |
| `server.js` | `static-deploy/` | Static file server with COOP/COEP + blob storage API |
| `wasmapp.cpp` | `wasm/` | C++ WASM bridge: create/handle/close remote clients |
| `build-and-run.sh` | `wasm/` | Build + deploy script for Docker-based WASM compilation |
| `ENCRYPTION.md` | `wasm/` | Detailed encryption key derivation documentation |

## Key Technologies

| Technology | Role |
|---|---|
| **Emscripten** | Compiles LibreOffice C++ and COOLWSD to WebAssembly |
| **WebAssembly (WASM)** | Runs LibreOffice + COOLWSD in the browser |
| **Emscripten pthreads** | Multi-threading via Web Workers (SharedArrayBuffer) |
| **FakeSocket** | In-process socket emulation replacing TCP in WASM builds |
| **MAIN_THREAD_EM_ASM** | Calls JavaScript from C++ worker threads (queued to main thread) |
| **EMSCRIPTEN_KEEPALIVE** | Prevents dead-code elimination of exported C++ functions |
| **WebSocket** | Communication between browsers and relay server |
| **Node.js + ws** | Lightweight relay server implementation |
| **Service Worker** | Transparent file encryption/decryption at the network layer |
| **Web Crypto API** | HMAC-SHA256 key derivation + AES-256-GCM encryption |
| **Cache API** | Background preloading of WASM assets for fast failover |
| **Azure Blob Storage** | Document persistence (with local fallback) |

## C++ Exported Functions

These functions are exported from WASM to JavaScript via `EMSCRIPTEN_KEEPALIVE`:

| Function | Purpose |
|---|---|
| `_handle_cool_message(msg)` | Handles messages from the local COOL JS client (existing) |
| `_create_remote_client()` | Creates a new remote client session, returns clientId |
| `_handle_remote_message(clientId, msg)` | Forwards a message from a remote client to COOLWSD |
| `_close_remote_client(clientId)` | Closes a remote client's session and cleans up |

## COOLWSD Multi-Session Architecture

COOLWSD natively supports multiple clients editing the same document:

- **DocumentBroker**: One per document, manages all sessions
- **ClientSession**: One per connected client (local or remote), runs in the DocBroker thread
- **ChildSession**: One per client view in the Kit process, handles LibreOffice interaction
- **Kit (lokit_main)**: Single process with multiple views, renders tiles per-view

For WASM, all of this runs in-browser. Each remote client gets:
- A FakeSocket pair for bidirectional communication
- A dedicated C++ forwarding thread (pthread -> Web Worker)
- A pipe pair for clean shutdown signaling

## Bug Fixes Applied

### `setDownloaded(true)` in MOBILEAPP path (`wsd/Storage.cpp`)

The `LocalStorage::downloadStorageFileToLocal` function had a bug where the `#else // MOBILEAPP` code path skipped calling `setDownloaded(true)`. This caused `isDownloaded()` to always return `false`, so every new session would re-enter `doDownloadDocument()` and crash with an assertion failure ("document status cannot regress") when trying to set the status back to `Loading` on an already-live document.

## Trust Model

| Component | Can see |
|---|---|
| **Browser (with URL fragment)** | Everything — plaintext document, filename, messages |
| **Static server (blob storage)** | Document hash (blob name), encrypted document, encrypted filename |
| **Relay server** | Document hash (room ID), encrypted relay messages |
| **Attacker (no URL fragment)** | Nothing — all values require the URL fragment to decrypt |
