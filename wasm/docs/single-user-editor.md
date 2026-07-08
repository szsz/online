# Embedding the editor in your own viewer (single-user mode)

This editor is **LibreOffice compiled to WebAssembly** served as a
static site behind Azure Front Door. You embed it as an iframe in
your own page (the "viewer"). Single-user mode means no co-editing
relay — every keystroke goes to the local Kit, every save writes
back through your viewer. It's the simplest integration surface;
co-edit is a strict superset.

This document is the integration contract: what you must do on your
side, what the editor will do on its side, and the byte-level
protocol between them.

---

## 1. What you provide

A web page (any framework, any backend) that:

1. Serves itself over HTTPS with the cross-origin-isolation headers
   set on the embedding page:

   ```
   Cross-Origin-Opener-Policy:    same-origin
   Cross-Origin-Embedder-Policy:  require-corp
   ```

   And the editor iframe inherits cross-origin isolation via
   Permissions-Policy:

   ```
   Permissions-Policy: cross-origin-isolated=(self "<EDITOR_ORIGIN>"),
                       clipboard-read=(self "<EDITOR_ORIGIN>"),
                       clipboard-write=(self "<EDITOR_ORIGIN>")
   ```

   Without these the WASM threads (SharedArrayBuffer) won't start.

2. Holds the document bytes — plaintext, in memory or in your own
   storage. The editor never reaches your storage directly; it asks
   you for bytes over `postMessage`.

3. Embeds the editor in an `<iframe>` and answers a handful of
   `postMessage` requests from it (the bridge protocol below).

You do **not** need:

- A backend that speaks WOPI, ESI, or any other office-server protocol.
- Any cross-origin endpoint reachable from the editor's origin —
  CORS, CORP, exposed APIs, none of it. The bridge keeps every
  byte exchange inside the browser.
- The relay broker. That's only for live co-editing.

## 2. What the editor provides

A URL of the form:

```
<EDITOR_ORIGIN>/<EDITOR_BUILD_ID>/browser/dist/cool.html
    ?WOPISrc=<filename or opaque id>
    &access_token=<anything; pass an empty string if you have no auth>
    &fileStorageUrl=<your viewer's origin>
    &UserName=<display name shown on cursor>
    [&lang=<BCP-47 locale>]      // e.g. de-DE; defaults to en-US
    [&displayName=<title>]        // human-readable title for chrome
```

- `EDITOR_ORIGIN` and `EDITOR_BUILD_ID` are what the editor team
  hands you. Each build is content-addressed by a folder ID; you
  can pin to a specific build for stability or follow the latest
  via the build index.
- **Omit `&relay=`** to get single-user mode. Adding the relay URL
  switches the same build into co-edit mode without other changes
  on your side.

Inside that iframe the editor will:

- Load ~280 MB of WASM + data (cached by a Service Worker on the
  editor origin; first visit is heavy, subsequent visits are warm).
- Register `/sw-bridge.js` on the editor origin with scope `/`.
- Open a `WOPISrc` document by issuing a `GET <editor-origin>/wasm/<WOPISrc>`
  — which the Service Worker intercepts and routes to **you** via
  `postMessage`.
- Periodically `POST <editor-origin>/wasm/<WOPISrc>` with the saved
  document bytes after `Ctrl+S` (or `.uno:Save`).
- Send a few status-event `postMessage`s to the parent.

You decide what those bytes mean (filenames, IDs, ciphertext — the
editor doesn't care).

## 3. The bridge protocol

The Service Worker on the editor origin intercepts these URL prefixes
on **same-origin** requests from the iframe and posts them to your
viewer instead of going to the network:

| Prefix | When | What you should return |
|---|---|---|
| `/wasm/<id>` | Kit opening or re-fetching the document, plus the save POST after Ctrl+S | The bytes — your file's plaintext on GET; cache the body on POST |

That's the only prefix you have to answer in single-user mode. The
SW intercepts a few more paths the relay-adapter uses in co-edit
mode (`/api/keys/`, `/api/blobs/`, `/api/v2/file/`, `/api/files/`),
but in single-user the relay-adapter short-circuits before
fetching any of them — your handler will never see a
`sw-bridge-request` for those paths. You can ignore them entirely
or reply with `status: 0` as a defensive fall-through if you ever
plumb relay support later.

### About `<id>` in `/wasm/<id>`

That `<id>` is the value you supplied as `?WOPISrc=<id>` when you
built the iframe URL — Kit just echoes it back in every fetch.
Kit was originally built to talk to WOPI fileservers where one
process serves multiple documents in parallel, so the URL had to
discriminate them. The bridge inherits the URL shape because it
lets the unmodified Kit code path work.

**Practical consequence:** for a single-doc embedding, the `<id>`
is meaningless to your handler. You already know which file is
loaded — you put it there. Treat the bridge as "respond to any
`/wasm/*` GET with my one file's bytes, accept any POST as the
new saved version." Pick `WOPISrc=doc` (or any fixed string) and
keep a single ArrayBuffer, not a map.

The `<id>` only earns its keep when you do one of these later:

- Embed two editor iframes in the same parent page (e.g.
  side-by-side compare). Both share your one `message` listener;
  the `<id>` (= each iframe's WOPISrc) tells you which one a
  request belongs to.
- Use the editor's hot-switch feature to replace the document in
  the same iframe over time (`switchdocument url=…/wasm/<new>`
  posted to Kit). The new `<id>` distinguishes the next document
  from the previous one.

If neither of those applies, ignore the `<id>`.

Every other request (HTML, JS, WASM, image, CSS) goes to the editor
origin's network. You don't see those.

### Wire format

The iframe's `wasm-loader.js` forwards each intercepted request to
`window.parent` (your viewer) as a structured-clone message:

```js
// Editor → viewer (sent on every Kit fetch in the bridged paths)
{
  type:    'sw-bridge-request',
  id:      '<uuid>',                 // correlate response
  url:     '<editor-origin>/wasm/<id>?…',
  method:  'GET' | 'POST' | 'PUT' | 'HEAD',
  body:    ArrayBuffer | null,       // present on POST/PUT
}

// Viewer → editor (reply matching by id)
{
  type:    'sw-bridge-response',
  id:      '<uuid from request>',
  status:  200 | 404 | 500 | 0,      // 0 = "no bridge, fall through"
  headers: { 'content-type': 'application/octet-stream', … },
  body:    ArrayBuffer | null,
}
```

The editor `postMessage`s to `window.parent` with target origin set
to your viewer's origin (which you supplied via `fileStorageUrl=…`
in the iframe URL). You should reply with `event.source.postMessage(
response, event.origin, transferList)`.

`ArrayBuffer` bodies are zero-copy via `Transferable`: include the
buffer in the third `postMessage` argument's transfer list. A 50 MB
document costs the same as a 1 KB one.

The Service Worker has a **15 second per-request timeout**. If you
don't reply (or reply with `status: 0`), it falls through to a
network fetch on the editor origin — which 404s, because there's no
dynamic endpoint there. So you do need to reply.

### Status `0` (no bridge available)

If your viewer doesn't want to serve a request (e.g. for paths you
don't recognise, or during startup), reply with `status: 0`. The SW
treats that as a sentinel meaning "give up the bridge for this
request" and immediately falls through to the network. Avoids
burning the 15 s timeout on requests you know you can't answer.

## 4. Minimum viable viewer (single-user)

A static HTML page that opens a document end-to-end:

```html
<!doctype html>
<title>Editor host</title>
<style>html,body,iframe{margin:0;height:100vh;width:100vw;border:0}</style>
<input type="file" id="picker">
<iframe id="editor" allow="cross-origin-isolated; clipboard-read; clipboard-write"></iframe>

<script>
const EDITOR_ORIGIN    = 'https://wasmeditor-...azurefd.net';
const EDITOR_BUILD_ID  = 'YYYY-MM-DD-<id>';      // pin or fetch latest
const MY_ORIGIN        = window.location.origin;

// One iframe, one document. We don't need a map — Kit will request
// whatever WOPISrc we gave it, and we always answer with the same
// file. Pick a fixed key; treat the path id as informational.
const WOPI_KEY = 'doc';
let docBytes   = null;     // ArrayBuffer of the currently loaded file
let docName    = 'doc';

document.getElementById('picker').onchange = async (e) => {
    const f = e.target.files[0];
    docBytes = await f.arrayBuffer();
    docName  = f.name;

    document.getElementById('editor').src =
        EDITOR_ORIGIN + '/' + EDITOR_BUILD_ID + '/browser/dist/cool.html' +
        '?WOPISrc=' + WOPI_KEY +
        '&access_token=' +
        '&fileStorageUrl=' + encodeURIComponent(MY_ORIGIN) +
        '&UserName=' + encodeURIComponent('Local user') +
        '&displayName=' + encodeURIComponent(f.name);
};

// Answer bridge requests. Note that we never inspect the `<id>` in
// the URL — we know which file is loaded, Kit's just echoing back
// the WOPISrc we already chose.
window.addEventListener('message', (ev) => {
    if (ev.origin !== EDITOR_ORIGIN) return;
    const msg = ev.data;
    if (!msg || msg.type !== 'sw-bridge-request') return;

    const reply = (status, body, headers = {}) => {
        ev.source.postMessage(
            { type: 'sw-bridge-response', id: msg.id, status, headers, body },
            ev.origin,
            body ? [body] : []);
    };

    const path = new URL(msg.url).pathname;
    if (!path.startsWith('/wasm/')) return reply(0, null);   // not ours; SW falls through

    if (msg.method === 'GET') {
        if (!docBytes) return reply(404, null);
        // Clone so future GETs survive the structured-clone transfer.
        return reply(200, docBytes.slice(0),
            { 'content-type': 'application/octet-stream' });
    }
    if (msg.method === 'POST') {
        // Kit just saved — body is the new document bytes.
        docBytes = msg.body;
        offerDownload(docName, msg.body);     // persist however you like
        return reply(200,
            new TextEncoder().encode(JSON.stringify({ ok: true })).buffer,
            { 'content-type': 'application/json' });
    }
    reply(405, null);
});

function offerDownload(name, buf) {
    const url = URL.createObjectURL(new Blob([buf]));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click(); URL.revokeObjectURL(url);
}
</script>
```

That's the entire single-user host. Pick a file → an iframe opens →
edit → Ctrl+S triggers a download of the modified file.

## 5. Lifecycle and timing

- **First visit on this browser/origin pair**: ~25–45 s to
  `content_verified` (canvas painted + status text). The editor's
  Service Worker is installing, the WASM binary is streaming and
  compiling (no V8 code cache yet), LibreOffice is cold-initializing,
  and the document is parsing — the cold-init dominates, not the
  download.
- **Subsequent visits**: ~7–10 s. WASM is in Cache Storage and a
  HEAPU8 snapshot warm-restores LibreOffice, so only the document
  load happens.
- **Editor iframe ↔ parent handshake**: the iframe registers the
  Service Worker, gates Kit's startup on the SW being active, then
  starts fetching `/wasm/<id>`. From your side: be ready to answer
  bridge requests before you set the iframe `src`.

## 6. Frame status — knowing when the doc is ready

The editor doesn't broadcast a "doc ready" message — it just renders.
Cheapest detector from the parent: poll selectors inside the iframe.

| Doc type | Selector that lights up when ready | Pattern to match |
|---|---|---|
| Writer (docx, odt) | `#StateWordCount` | `/\d+\s+(words?|characters?)/` |
| Calc (xlsx, ods, csv) | `#StatusDocPos` | `/Sheet\s\d+\s+of\s+\d+/` |
| Impress (pptx, odp) | `#SlideStatus` | `/Slide\s\d+\s+of\s+\d+/` |

```js
function isReady(frame) {
  const wc = frame.document.querySelector('#StateWordCount')?.textContent || '';
  const dp = frame.document.querySelector('#StatusDocPos')?.textContent || '';
  const sl = frame.document.querySelector('#SlideStatus')?.textContent || '';
  return /\d+\s+(word|character)/.test(wc)
      || /Sheet\s\d+\s+of\s+\d+/.test(dp)
      || /Slide\s\d+\s+of\s+\d+/.test(sl);
}
```

If you need an event instead of a poll, the editor also posts a
`{MessageId: 'WasmDocReady'}` to the parent when it's done. You can
listen with the same `message` event handler:

```js
window.addEventListener('message', (ev) => {
    try {
        const m = JSON.parse(ev.data);
        if (m.MessageId === 'WasmDocReady') console.log('doc ready');
    } catch {}
});
```

## 7. URL params reference

Required:

- `WOPISrc=<id>` — the id you'll receive in every `/wasm/<id>` bridge
  request. Pick any unique-per-tab string; 64 hex chars works fine.
- `fileStorageUrl=<your-origin>` — the editor will only `postMessage`
  the parent if `parent.location.origin === <this>`. Without it the
  iframe assumes "no parent", treats every bridge request as
  unanswerable, and falls through to network 404s.

Recommended:

- `UserName=<name>` — shown on the live cursor in co-edit; cosmetic
  in single-user.
- `access_token=` — pass empty string. The editor doesn't validate
  it, it just plumbs it through Kit's WOPI shim. Required by the URL
  shape but not used for authentication.
- `lang=<bcp47>` — sets the UI language. The editor build ships
  ~38 locales; falls back to `en-US` if unknown.

Optional:

- `displayName=<title>` — title in the editor chrome / save dialog.
- `singleuser` / `readonly=1` — `viewer-public/index.html` flags
  meaningful to *that* viewer; the editor itself doesn't read them.
- `planc=0` / `planc=1` — disable / force the snapshot-restore code
  path; useful only when debugging warm-start regressions.

Co-edit only:

- `relay=<wss://…/room/<room-key>>` — switches the iframe into
  co-edit mode. Omit for single-user. Multiple browsers passing the
  same `relay=` URL converge edits in real time.

## 8. CORS / iframe sandboxing

You may host the editor in a sandboxed iframe; you need at minimum:

```html
<iframe sandbox="allow-scripts allow-same-origin allow-downloads"
        allow="cross-origin-isolated; clipboard-read; clipboard-write">
```

`allow-same-origin` is needed because the editor sets cookies on its
own origin and reads URL hash. `allow-downloads` is needed if you
want users to trigger native Save-As. The Permissions-Policy
delegation listed in section 1 is what unlocks SharedArrayBuffer
inside the iframe.

## 9. Known limitations in single-user mode

- **No live convergence across tabs.** Single-user means no relay.
  Two tabs editing the same id will diverge until one saves and the
  other reloads.
- **Save is best-effort.** The editor's `Ctrl+S` POSTs back through
  the bridge; you decide whether to persist the bytes. If your
  bridge handler returns non-200, the editor logs a save error but
  keeps the in-memory document.
- **No undo across reload.** Reloading the iframe loses the
  in-memory undo stack; your last bridge-saved bytes are the
  starting point.

## 10. Where the contract lives in source

If you're integrating from outside this repo, you don't need to read
any of it — just match the wire format in section 3. If you're
reading this in-tree, the reference implementations are:

- `wasm/sw-bridge.js` — the editor-side Service Worker.
- `wasm/wasm-loader.js` — the iframe-side bridge relay.
- `wasm/viewer-public/lib/editor-bridge.js` — a reference viewer
  implementation of the parent-side handler.
