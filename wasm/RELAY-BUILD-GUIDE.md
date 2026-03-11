# COOL WASM Multi-Client Relay: Build & Deploy Guide

Step-by-step instructions to build and run Collabora Online WASM with multi-client collaborative editing via a relay server.

## Prerequisites

- Docker with the `lo-wasm-server` container (built from `public.ecr.aws/allotropia/libo-builders/wasm` image, committed as `lo-wasm-built`)
- Node.js (v20+) on the host
- The Collabora Online source tree at `/path/to/online`

## 1. Container Setup

The `lo-wasm-server` container must have the full COOL WASM build environment at `/lo/online` with LibreOffice Core built for WASM at `/lo/core`.

```bash
# Start the container (if not already running)
docker run -d --name lo-wasm-server -p 6931:6931 lo-wasm-built sleep infinity
```

## 2. Build the WASM Binary

### Automated (recommended)

```bash
bash wasm/build-and-run.sh rebuild
```

This syncs `wasmapp.cpp`, `wasmapp.hpp`, `Storage.cpp`, and `Makefile.am` into the container and runs `make` in `/lo/online/wasm`.

### Manual

```bash
# Copy modified source files into the container
docker cp wasm/wasmapp.cpp lo-wasm-server:/lo/online/wasm/wasmapp.cpp
docker cp wasm/wasmapp.hpp lo-wasm-server:/lo/online/wasm/wasmapp.hpp
docker cp wsd/Storage.cpp lo-wasm-server:/lo/online/wsd/Storage.cpp

# Rebuild inside the container
docker exec lo-wasm-server bash -c '
    source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
    cd /lo/online/wasm && make -j$(nproc)
'
```

### Key source changes

- **`wsd/Storage.cpp`**: Added `setDownloaded(true)` in the `MOBILEAPP` code path of `LocalStorage::downloadStorageFileToLocal`. Without this, every new session tries to re-download an already-loaded document, crashing with "document status cannot regress".
- **`wasm/wasmapp.cpp`**: Added `RemoteClient` struct, `create_remote_client()`, `handle_remote_message()`, `close_remote_client()`, and `send2RemoteJS()` for multi-client support.
- **`wasm/wasmapp.hpp`**: Declared the three new exported C++ functions.
- **`wasm/Makefile.am`**: Added `_create_remote_client`, `_handle_remote_message`, `_close_remote_client` to the Emscripten exports file.

## 3. Deploy Artifacts

### Automated

```bash
bash wasm/build-and-run.sh deploy
```

### Manual

```bash
# Copy WASM artifacts from container to browser/dist
for f in online.js online.wasm online.data online.worker.js; do
    docker cp lo-wasm-server:/lo/online/wasm/$f browser/dist/$f
done

# Copy relay JS files to browser/dist
cp wasm/relay-host.js browser/dist/
cp wasm/relay-client-boot.js browser/dist/
cp wasm/relay-server.js browser/dist/

# Generate relay-client.html from cool.html (removes WASM binary, swaps boot script)
docker exec lo-wasm-server bash -c '
    cd /lo/online/browser/dist
    sed \
      -e "s|<script type=\"text/javascript\" src=\"online.js\"></script>||" \
      -e "s|<script src=\"emscripten-module.js\" defer></script>|<script src=\"relay-client-boot.js\" defer></script>|" \
      cool.html > relay-client.html
'
docker cp lo-wasm-server:/lo/online/browser/dist/relay-client.html browser/dist/

# Also copy artifacts inside the container for emrun
docker exec lo-wasm-server bash -c '
    cp /lo/online/wasm/online.js /lo/online/browser/dist/
    cp /lo/online/wasm/online.wasm /lo/online/browser/dist/
    cp /lo/online/wasm/online.data /lo/online/browser/dist/
    cp /lo/online/wasm/online.worker.js /lo/online/browser/dist/
    cp /lo/online/wasm/relay-host.js /lo/online/browser/dist/
    cp /lo/online/wasm/relay-client-boot.js /lo/online/browser/dist/
    cp /lo/online/wasm/relay-server.js /lo/online/browser/dist/
'
```

## 4. Start Services

### Start emrun (serves WASM app on port 6931)

```bash
docker exec -d lo-wasm-server bash -c '
    source /home/builder/emsdk/emsdk_env.sh 2>/dev/null
    cd /lo/online
    emrun --no-browser --port 6931 --hostname 0.0.0.0 browser/dist/cool.html
'
```

### Install ws module and start relay server (port 9090)

```bash
npm install --no-save ws
nohup node wasm/relay-server.js > /tmp/relay-server.log 2>&1 &
```

## 5. Test Multi-Client Editing

### Browser A (WASM host)

1. Open: `http://localhost:6931/cool.html?file_path=/test/example.odt`
2. Wait for the document to fully load
3. Open the browser console and run:
   ```js
   var s = document.createElement('script'); s.src = 'relay-host.js'; document.head.appendChild(s);
   ```
4. Wait 2 seconds, then run:
   ```js
   RelayHost.connect('ws://localhost:9090/host?room=default');
   ```

### Browser B (thin client)

Open: `http://localhost:6931/relay-client.html?file_path=/test/example.odt&relayServer=ws://localhost:9090&relayRoom=default`

## 6. All-in-One Script

```bash
bash wasm/build-and-run.sh all
```

This runs rebuild + deploy + relay setup in sequence. See [`wasm/build-and-run.sh`](build-and-run.sh) for details.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `EADDRINUSE` on port 9090 | Old relay server still running | Kill the process: find PID with `netstat -ano \| grep :9090` |
| `EADDRINUSE` on port 9980 | Default relay port conflicts with existing COOL server | Relay server defaults to 9090 now; set `RELAY_PORT` env var if needed |
| "document status cannot regress" assertion | Missing `setDownloaded(true)` in MOBILEAPP path | Ensure `wsd/Storage.cpp` fix is applied and rebuilt |
| `event.data.startsWith is not a function` | Binary data passed as ArrayBuffer where string expected | The `relay-client-boot.js` newline check handles this |
| "nodocloaded" errors | Empty `file_path` in Browser B URL | Include `file_path=/test/example.odt` in Browser B's URL |
| "Failed to decompress pending deltas" | Tile binary data decoded as UTF-8 string | The newline check in `relay-client-boot.js` passes binary data as `Uint8Array` |

## File Reference

| File | Purpose |
|------|---------|
| [`wasm/relay-server.js`](relay-server.js) | Node.js WebSocket relay server (room-based routing) |
| [`wasm/relay-host.js`](relay-host.js) | Browser A bridge: connects WASM COOLWSD to relay |
| [`wasm/relay-client-boot.js`](relay-client-boot.js) | Browser B bootstrap: replaces `emscripten-module.js` |
| [`wasm/relay-client.html`](relay-client.html) | Generated from `cool.html` for thin client |
| [`wasm/build-and-run.sh`](build-and-run.sh) | Build, deploy, and launch script |
| [`wasm/wasmapp.cpp`](wasmapp.cpp) | C++ multi-client functions (create/handle/close) |
| [`wasm/wasmapp.hpp`](wasmapp.hpp) | C++ header with exported function declarations |
| [`wsd/Storage.cpp`](../wsd/Storage.cpp) | Fix: `setDownloaded(true)` for MOBILEAPP path |
