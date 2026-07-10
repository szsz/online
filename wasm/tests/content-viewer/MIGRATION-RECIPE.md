# Migration recipe — porting a legacy-viewer test to the content viewer

Target: `wasm/tests/content-viewer/test-cv-<oldslug>.js` (drop a leading
`regression-` from the slug only if the file name gets absurd; otherwise keep
it: `test-cv-regression-search.js`).

## Harness mapping

| Legacy | Content-viewer |
|---|---|
| `openViaViewer(browser, FILE_STORAGE_URL, name, bytes, opts)` | `openBytesViaContentViewer(browser, BASE, name, bytes, opts)` from `../../lib/open-via-content-viewer` |
| upload via `lib/v2-upload` + `#file=` links | not needed — the tester upload replaces it |
| two browsers on one secret (`coEditing:true` / two-tab) | `openCoEditPair(browser, BASE, name, bytes, {userA, userB})` → `{A:{page,editorFrame}, B:{...}, joinLink}` |
| a third+ browser joins | `joinViaContentViewer(browser, joinLink, {page, userName})` (new `browser.createBrowserContext()` per extra client) |
| doc-ready waits (shield/prewarm/`waitInFrame` readiness) | `await waitCvInteractive(page, 300000)` — spinner gone + tester Save enabled |
| char-count reads (`getCharCount`, `#StateWordCount` pokes) | `cvCharCount(page)` / `waitCvCharCount(page, pred, budget)` |
| `FILE_STORAGE_URL` / `EDITOR_URL` env | `const BASE = (process.argv[2] \|\| process.env.BASE_URL \|\| 'https://wasm-viewer-test.azurewebsites.net').replace(/\/+$/, '');` |
| save → viewer storage/checkpoint | tester **Save button** click (single-user: exports; co-edit: rotates the relay checkpoint via /shared-file) |

## Hard rules

- The test's SUBJECT assertions stay semantically identical — you are only
  swapping the harness (how the doc gets opened/waited on), never weakening
  what is verified.
- Real user input only: `page.keyboard`, `page.mouse`, real button clicks by
  bounding box. NO `sendUnoCommand`, NO `app.dispatcher.dispatch`, NO
  `page.evaluate(() => el.click())`. Reading state via `frame.evaluate`
  (selectors, textContent) is fine.
- Typing into the doc: click the iframe's doc area first
  (`const el = await page.$('iframe'); const box = await el.boundingBox();
  await page.mouse.click(box.x+box.width/2, box.y+300);`).
- Comments need a 1920x1080 viewport + a focus-verified click into
  `.cool-annotation-textarea` (see test-cv-comment-author.js for the exact
  pattern — copy it).
- Budgets: cold CV opens are 25–45s (up to ~190s at 1920x1080 viewports);
  use `waitCvInteractive(page, 300000)` and route legacy `env.scaleTimeout`
  patience through generous constants.
- Keep the house style: `check(label, cond, ev)` + `log()` + `ALL PASS` /
  `SOME FAILED` + `process.exit`, header comment explaining WHAT is verified,
  plus one line: `// Migrated from wasm/tests/<old path> — legacy version retired.`
- Fixtures: reuse the legacy test's fixture bytes/files verbatim
  (`test/data/*.docx` etc.). If a legacy test generated content by driving
  the legacy viewer UI, generate the same doc by typing through the CV
  editor instead.
- co-edit: names must differ per client; propagation asserts use
  `waitCvCharCount` with 60–90s budgets.
- `node --check` the result. Do NOT run the test (verification is central).

## What NOT to port

If, while porting, the test turns out to fundamentally depend on
legacy-viewer machinery (v2 API shapes, shield, prewarm, hot-switch UI,
`/wasm/<id>` endpoints), STOP and report it as NA instead of forcing it.
