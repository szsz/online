# COOL WASM Multi-Client Relay: Architecture Overview

## Goal

Enable collaborative editing of the same document across multiple browser tabs/windows, where only one browser runs the full Collabora Online WASM stack (LibreOffice + COOLWSD), and additional browsers connect as thin clients through a relay server.

## High-Level Architecture

```
Browser A (WASM Host)                    Browser B (Thin Client)
+---------------------------+            +---------------------------+
| LibreOffice (WASM)        |            | COOL JS UI (bundle.js)   |
| COOLWSD Server            |            | FakeWebSocket             |
| DocumentBroker            |            | relay-client-boot.js      |
|   Session 1 (local)       |            |                           |
|   Session 2 (remote)      |            |                           |
| relay-host.js             |            |                           |
+-------------|-------------+            +-------------|-------------+
              |                                        |
              | WebSocket                              | WebSocket
              | (binary frames)                        | (raw payload)
              |                                        |
         +----v----------------------------------------v----+
         |           Relay Server (Node.js)                  |
         |           wasm/relay-server.js                    |
         |           Port 9090                               |
         +---------------------------------------------------+
```

## Components

### Browser A: WASM Host

Browser A runs the complete Collabora Online stack compiled to WebAssembly:

- **LibreOffice Core** (compiled to WASM via Emscripten) - the actual document engine
- **COOLWSD** - the Collabora Online WebSocket Daemon, managing sessions and document state
- **DocumentBroker** - manages the loaded document and multiple client sessions
- **FakeSocket** - in-process socket emulation (replaces real TCP sockets in WASM/mobile builds)
- **relay-host.js** - JavaScript bridge that connects COOLWSD to the relay server

The host manages both a local session (for its own UI) and remote sessions (one per thin client). Each remote session has its own FakeSocket connection to COOLWSD and a dedicated forwarding thread.

### Relay Server

A lightweight Node.js WebSocket server (`relay-server.js`) that routes messages between the host and thin clients:

- **Room-based routing**: Each document editing session is a "room" with one host and multiple clients
- **Binary framing protocol**: Host messages use a 5-byte header (1 byte type + 4 bytes client ID) followed by payload
- **Message types**: `0` = data, `1` = client connected, `2` = client disconnected
- **Transparent forwarding**: The relay strips headers for client-bound messages and adds headers for host-bound messages

### Browser B: Thin Client

Browser B runs the standard COOL JavaScript UI (`bundle.js`, `global.js`) but without the WASM binary:

- **relay-client.html** - generated from `cool.html` by removing `online.js` (WASM) and replacing `emscripten-module.js` with `relay-client-boot.js`
- **relay-client-boot.js** - provides stub `createEmscriptenModule`/`createOnlineModule` functions, overrides `postMobileMessage` to send through relay, and handles the initialization sequence
- **FakeWebSocket** - COOL's built-in socket abstraction, now routed through the relay instead of to WASM

## Message Flow

### Outgoing (Browser B -> COOLWSD)

```
User action in Browser B
  -> bundle.js calls FakeWebSocket.send(msg)
  -> FakeWebSocket.send calls postMobileMessage(msg)
  -> postMobileMessage sends via relay WebSocket
  -> Relay server wraps: [type=0][clientId][payload] -> host WebSocket
  -> relay-host.js receives, extracts clientId + payload
  -> Calls Module._handle_remote_message(wasmClientId, payload)
  -> C++ writes to FakeSocket -> COOLWSD ClientSession -> Kit
```

### Incoming (COOLWSD -> Browser B)

```
Kit renders tile / sends status update
  -> COOLWSD writes to FakeSocket
  -> C++ forwarding thread reads from FakeSocket
  -> Calls send2RemoteJS(clientId, data) via MAIN_THREAD_EM_ASM
  -> JS callback: globalThis.onRemoteClientMessage(wasmClientId, data)
  -> relay-host.js wraps: [type=0][relayClientId][payload] -> relay WebSocket
  -> Relay server strips header, forwards payload to client WebSocket
  -> relay-client-boot.js receives ArrayBuffer
  -> Newline check: no newline = decode as string, has newline = pass as Uint8Array
  -> Calls TheFakeWebSocket.onmessage({data}) -> bundle.js processes message
```

### Session Lifecycle

1. Browser B connects to relay -> relay notifies host (type=1 message)
2. `relay-host.js` calls `Module._create_remote_client()` (C++)
3. C++ spawns a pthread, calls `fakeSocketConnect()` to COOLWSD
4. COOLWSD creates a new ClientSession + ChildSession (new document view)
5. C++ sends `fileURL` as first message (equivalent to WebSocket upgrade)
6. C++ notifies JS via `onRemoteClientReady` callback
7. `relay-host.js` flushes any queued messages for that client
8. Browser B sends `coolclient` + `load url=...` to complete initialization
9. COOLWSD responds with status, tiles, UI data
10. On disconnect: relay notifies host (type=2), C++ calls `fakeSocketClose`

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
| **emrun** | Emscripten's HTTP server with SharedArrayBuffer headers (COOP/COEP) |

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

## Limitations and Future Work

- **Relay host injection is manual**: Currently requires pasting JavaScript in the console to load `relay-host.js` and connect. Could be automated with a URL parameter or UI button.
- **Single-machine only**: The relay server, emrun, and browsers must all be on the same machine (localhost). For cross-machine use, the relay server needs a public address and HTTPS/WSS.
- **No authentication**: The relay server has no authentication. Any client can connect to any room.
- **SharedArrayBuffer requirement**: WASM with pthreads requires COOP/COEP headers, which emrun provides. A production deployment needs a server that sets these headers.
- **Tile delta decompression**: Binary tile data must be passed through as `Uint8Array`, not decoded as text. The newline-based detection in `relay-client-boot.js` handles this.
