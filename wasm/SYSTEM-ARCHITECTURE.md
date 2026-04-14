# System Architecture: Three Separate Domains

## Overview

The system consists of three independent services, each on its own domain, each with a single clear responsibility:

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│   FILE STORAGE       │     │   RELAY SERVER       │     │   EDITOR APP        │
│   (Viewer)           │     │                      │     │                      │
│   FILE_STORAGE_URL   │     │   RELAY_URL           │     │   EDITOR_URL         │
│                      │     │                      │     │                      │
│   • File CRUD        │     │   • Message ordering  │     │   • WASM runtime     │
│   • File list UI     │     │   • Seq# assignment   │     │   • LibreOffice Kit  │
│   • Upload/download  │     │   • Broadcast         │     │   • Tile rendering   │
│   • User-facing      │     │   • Checkpoint hashes │     │   • Static assets    │
│     entry point      │     │   • Late-join state   │     │   • cool.html        │
└─────────┬───────────┘     └──────────┬──────────┘     └──────────┬──────────┘
          │                            │                           │
          │  ── Files (HTTP) ──────────┼───────────────────────────┤
          │                            │                           │
          │                            │  ── Messages (WebSocket) ─┤
          │                            │                           │
          └────────── iframe ──────────┼───────────────────────────┘
                                       │
                                  User's Browser
```

## Configuration

All domain URLs are set in deployment config, never hardcoded in source:

| Variable | Description | Example |
|----------|-------------|---------|
| `FILE_STORAGE_URL` | File storage / viewer server | `https://viewer.example.com:6934` |
| `EDITOR_URL` | Editor app serving WASM assets | `https://editor.example.com:6932` |
| `RELAY_URL` | Relay server (WebSocket) | `wss://relay.example.com:9091` |

In the viewer's `index.html`, these are JS constants at the top of the script. In tests, they are read from environment variables or a local `.env` file. They must not be committed to the repository.

## 1. File Storage Server (Viewer)

**Domain:** Configured via `FILE_STORAGE_URL` (e.g. `https://viewer.example.com:6934`)

**Sole responsibility:** Storing, listing, uploading, and downloading document files.

### What it does
- Serves the viewer UI (`index.html`) — the user's entry point
- Provides a REST API for file management (`/api/files/`)
- Stores uploaded documents on disk
- Stores checkpoint saves from co-editing sessions (same file, overwritten on each checkpoint)
- Serves a blank document for pre-warming (`/blank.docx`)
- Hosts no editor logic, no WASM, no relay

### API
```
GET  /                          → Viewer HTML page
GET  /api/files/                → JSON list of files [{name, size}]
GET  /api/files/:name           → Download file content
POST /api/files/:name           → Upload/overwrite file content (body = file bytes)
GET  /blank.docx                → Blank document for pre-warm
```

### What it does NOT do
- Does not run LibreOffice or any editor
- Does not relay co-editing messages
- Does not assign sequence numbers or manage rooms
- Does not know which files are being actively co-edited

## 2. Relay Server

**Domain:** Configured via `RELAY_URL` (e.g. `wss://relay.example.com:9091`)

**Sole responsibility:** Ordering co-editing messages and managing checkpoints.

### What it does
- Accepts WebSocket connections from browser tabs
- Groups connections into **rooms** (one room per document being co-edited)
- Assigns monotonically increasing **sequence numbers** to every broadcast message
- Broadcasts each message to all clients in the room (including the sender)
- Stores **checkpoint hashes** — the hash of the document at a known sequence number
- Stores **checkpoint files** — the saved document state uploaded by a client
- Handles **late join**: sends the latest checkpoint + replays messages since that checkpoint
- Sends **save-trigger** signals to clients to request checkpoint creation

### What it stores
- Checkpoint hashes + sequence numbers (per room, in memory)
- In-flight message queue (per room, since last checkpoint)

### What it does NOT do
- Does not store any files — not originals, not checkpoints (that's the file storage server)
- Does not parse or understand document content
- Does not run LibreOffice or render anything
- Does not serve any UI

### Protocol (binary WebSocket frames)
```
Frame format: [type: 1 byte] [viewId: 4 bytes] [payload: variable]

Types:
  0x00  UI message (key/mouse/textinput/uno) — relayed with seq#
  0x02  Client joined (broadcast by relay)
  0x03  Client left (broadcast by relay)
  0x04  Join request (client → relay)
  0x05  Join response (relay → client, includes checkpoint info)
  0x06  Join ready (client → relay, client finished syncing)
  0x08  Save trigger (relay → client, request checkpoint upload)
  0x0A  Checkpoint mismatch (relay → client, hash doesn't match)
```

## 3. Editor App (WASM)

**Domain:** Configured via `EDITOR_URL` (e.g. `https://editor.example.com:6932`)

**Sole responsibility:** Running the LibreOffice editor in the browser.

### What it does
- Serves static assets: `cool.html`, `bundle.js`, `online.wasm`, `soffice.data`, `wasm-loader.js`, `relay-adapter.js`
- Accepts document uploads via CORS POST (`/wasm/:name`) — these are temporary copies for the WASM to load
- The browser downloads the WASM binary, compiles it, and runs LibreOffice Kit entirely client-side
- Each browser tab runs its own independent WASM instance
- `relay-adapter.js` connects to the relay server and routes messages
- `wasm-loader.js` handles pre-warm, document switching, progress UI

### What it stores
- Static assets (immutable between deployments)
- Temporary document copies in `/wasm/` (uploaded by the viewer for the WASM to fetch)
- Nothing persistent — the WASM instance is ephemeral

### What it does NOT do
- Does not store the canonical files (that's the file storage server)
- Does not order messages (that's the relay server)
- Does not manage rooms or checkpoints
- Has no server-side document processing — everything runs in the browser

## How They Work Together

### Opening a document

```
1. User visits viewer (file storage server)
2. Viewer shows file list from /api/files/
3. User clicks a file
4. Viewer downloads file from its own /api/files/:name
5. Viewer uploads file to editor app's /wasm/:name (CORS POST)
6. Viewer creates iframe pointing to editor app:
   EDITOR_URL/browser/cool.html?WOPISrc=:name&relay=RELAY_URL/room/:name
7. Editor app's WASM loads the document from EDITOR_URL/wasm/:name
8. relay-adapter.js connects to relay room
```

### Co-editing flow

```
1. User A opens document → iframe connects to relay room
2. User A is first client → relay says "first" → A starts editing
3. User B opens same document → iframe connects to same relay room
4. Relay says "late join" → sends checkpoint hash + seq#
5. B downloads checkpoint file from the file storage server, loads it
6. Relay replays messages since checkpoint → B applies them
7. B sends join-ready → now B can send actions
8. Both A and B send actions through relay
9. Relay assigns seq# and broadcasts to both
10. Each applies messages in order to their own WASM
```

### Saving / Checkpoints

```
1. Relay sends save-trigger to a client (e.g., A)
2. A saves document locally, computes hash
3. A uploads saved file to the FILE STORAGE SERVER (not the relay)
4. A reports the hash + seq# to the relay
5. Relay stores hash + seq# (no file — just the hash)
6. Relay broadcasts checkpoint hash to all clients
7. Each client saves locally, computes hash, compares
8. If match → OK. If mismatch → DIVERGENCE ERROR.
```

## Domain Separation Rationale

| Concern | File Storage | Relay | Editor |
|---------|-------------|-------|--------|
| File persistence | ✓ | ✗ | ✗ |
| Message ordering | ✗ | ✓ | ✗ |
| Document rendering | ✗ | ✗ | ✓ |
| User authentication (future) | ✓ | ✗ | ✗ |
| Horizontal scaling | Independent | Independent | N/A (client-side) |
| State | Files on disk | Rooms in memory | Ephemeral (browser) |
| Can be replaced independently | Yes | Yes | Yes |

Each service can be developed, deployed, and scaled independently. The file storage server could be swapped for S3 or any WOPI-compatible host. The relay could be replaced with any ordered-broadcast service. The editor app is just static file hosting — it could be a CDN.
