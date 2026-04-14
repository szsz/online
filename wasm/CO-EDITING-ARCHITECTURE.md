# Co-Editing Architecture

## Core Principles

1. **Each browser tab runs its own full WASM instance.** There is no shared memory between tabs. Each tab is a fully independent LibreOffice instance with its own document in memory.

2. **Each instance has its own cursor.** Every user sees their own cursor independently. Remote users' cursors are displayed as colored markers but do not interfere with the local user's cursor position or selection.

3. **Every user action goes through the relay server first.** No action may be applied to the local document until the relay has assigned it a sequence number and broadcast it back. This guarantees total ordering across all clients.

4. **The relay server is the single source of truth for message ordering.** It assigns monotonically increasing sequence numbers. All clients process messages in the same order, producing identical document states.

## Message Flow

```
User action (type/click/UNO)
    ↓
interceptedSend() — does NOT apply locally yet
    ↓
Relay server assigns seq#, broadcasts to ALL clients (including sender)
    ↓
Each client receives broadcast in seq order
    ↓
Own viewId → sendToKit() (local view, local cursor)
Other viewId → sendToRemoteClient() (remote view, remote cursor)
```

### Intercepted Messages (go through relay)
- `key` — keyboard input
- `mouse` — mouse clicks, drags, selections
- `textinput` — IME/composition text
- `windowkey` — window-level keyboard events
- `uno` — UNO commands (InsertRows, Bold, DeleteColumns, etc.)

### NOT Intercepted (local only)
- `clientzoom`, `clientvisiblearea` — per-view display settings
- `tileprocessed`, `commandvalues` — tile cache management
- Status queries — don't modify document content

## Multi-View Architecture

Each WASM instance maintains multiple views of the same document:

- **Local view:** The user's own session. Has its own cursor, selection, scroll position. Receives the user's own actions back from the relay via `sendToKit()`.
- **Remote views:** One per remote user. Created via `create_remote_client()` in the Kit. Each has its own cursor and selection state. Receives remote users' actions via `sendToRemoteClient()` → `handle_remote_message()`.

All views share the same in-memory `Document` object in LibreOffice Kit. A change made through any view is immediately visible to all other views. Tile invalidations from any view trigger re-rendering for all views.

### Cursor Independence

- When User B clicks at position (x, y), the mouse event goes to B's remote view on A's WASM. **A's cursor does not move.** Only B's remote cursor marker updates.
- When User A types, the key events go to A's local view. **B's cursor is unaffected** on A's WASM.
- Each view tracks its own cursor, selection, and editing context independently.

### Why Remote Views Are Required

UNO commands (InsertRowsAfter, Bold, etc.) are **cursor-context-dependent** — they operate on the active selection/cursor of the view that sends them. To preserve the correct context:

- B's `InsertRowsAfter` must execute in B's remote view on A's WASM, where B's cursor is inside the table (positioned by B's prior mouse clicks).
- If it executed in A's local view, it would insert at A's cursor position — wrong result.

## Checkpoints

- A **checkpoint** is a saved copy of the document at a known sequence number.
- The checkpoint **file** is stored on the **file storage server** (not the relay).
- The relay stores only the checkpoint **hash** and **sequence number**.
- Checkpoints are created periodically (on save-trigger from relay) or after significant changes.
- When a checkpoint is created, the originating client:
  1. Saves the document and computes its content hash.
  2. Uploads the file to the **file storage server** (overwriting the previous version).
  3. Reports the hash + sequence number to the **relay server**.

## Late Join

1. New client connects to the relay room.
2. Relay responds with the latest checkpoint hash and sequence number.
3. Client downloads the checkpoint file from the **file storage server**.
4. Client verifies the downloaded file matches the checkpoint hash.
5. Client loads the document from the checkpoint file.
6. Relay replays all messages with sequence numbers > checkpoint sequence.
7. Client applies replayed messages in order (creating remote views as needed).
8. Client sends `join-ready` — only then may it send its own actions.

## Checkpoint Verification

- When a new checkpoint is created, **every connected client must verify** that their local document produces the same hash.
- Each client saves its document, computes the hash, and compares with the relay's checkpoint hash.
- **If hashes don't match → DIVERGENCE ERROR.** The client must show an error.
- **In tests, a checkpoint mismatch is a hard test failure.** Divergence should theoretically never happen if the relay ordering is correct and all clients process messages identically.

## Known Bug: Remote View Changes Not Visible

**Current status:** Remote client views are created and receive messages correctly (`handle_remote_message` confirms delivery). However, changes made through remote views do NOT trigger tile invalidations or status updates back to the primary view's JS rendering pipeline.

**Root cause:** The Kit's tile invalidation callback from the remote view's actions does not propagate to the primary view's `ClientSession` → JS tile cache → canvas re-render.

**Required fix:** When any view (local or remote) modifies the document, LibreOffice Kit sends `LOK_CALLBACK_INVALIDATE_TILES` to all registered view callbacks. The primary view's callback must process these invalidations and re-render affected tiles. This is a Kit/WASM integration issue in `wasmapp.cpp` or `Kit.cpp`.

## Test Requirements

Every co-editing test MUST verify:

1. **Content convergence** — after all edits complete and a sync period, all browsers have identical document content (word count match, and/or full text comparison).
2. **No checkpoint mismatches** — if a checkpoint is created during the test, all clients' hashes must match. A mismatch is a test failure.
3. **No OOB memory errors** — no `memory access out of bounds` crashes.
4. **Bidirectional sync** — changes from A appear on B AND changes from B appear on A.
5. **Structural changes** — insert/delete rows/columns, formatting commands must propagate correctly.
6. **Independent cursors** — each user's cursor operates independently; remote actions don't hijack the local cursor.
