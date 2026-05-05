const __cl = require('./lib/inject-checklist');
// Regression: viewer + editor HTML routes must emit ETag and 304 on
// If-None-Match. Iter 53 (editor cool.html), iter 58 (editor-static
// cool.html), and iter 61 (viewer index/help/singleuser) added this.
//
// Without ETag, every navigation forces a full body roundtrip even
// though the content hasn't changed. The win is most visible on
// viewer/index.html (~25 KB) since it's the entry point.
//
// Curl-only test, no browser. Fast — runs in ~1s. Lives next to the
// other infrastructure regression tests.

const env = require('./lib/test-env');
const { fetchUrl } = require('./lib/fetch-url');

const T0 = Date.now();
const log = m => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}${ev ? ' [' + ev + ']' : ''}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

async function checkRoute(label, url, opts) {
    opts = opts || {};
    log(`-- ${label}: ${url}`);
    const first = await fetchUrl(url);
    check(`${label}: 200 on first GET`, first.status === 200, 'status=' + first.status);
    const etag = first.headers.etag;
    if (!etag) {
        if (opts.softEtag) {
            log(`  SKIP ${label}: ETag — server has no ETag yet (pending deploy of iter 58+)`);
            return;
        }
        check(`${label}: ETag header present`, false, 'etag=undefined');
        return;
    }
    check(`${label}: ETag header present`, true, 'etag=' + etag);
    const second = await fetchUrl(url, { 'If-None-Match': etag });
    check(`${label}: 304 with If-None-Match`,
          second.status === 304,
          'status=' + second.status);
    check(`${label}: 304 has no body`,
          (second.body || '').length === 0,
          'body.len=' + (second.body || '').length);
    const third = await fetchUrl(url, { 'If-None-Match': '"definitely-not-the-etag"' });
    check(`${label}: 200 when ETag mismatch`,
          third.status === 200,
          'status=' + third.status);
}

(async () => {
    log('=== Regression: HTML routes 304 on If-None-Match ===');

    const VIEWER = env.FILE_STORAGE_URL;
    const EDITOR = env.EDITOR_URL;

    // Viewer routes — iter 61
    await checkRoute('viewer /',                `${VIEWER}/`);
    await checkRoute('viewer /index.html',      `${VIEWER}/index.html`);
    await checkRoute('viewer /singleuser.html', `${VIEWER}/singleuser.html`);
    // /help may not exist on Azure-deploys without help.html bundled — soft check
    try {
        const helpProbe = await fetchUrl(`${VIEWER}/help`);
        if (helpProbe.status === 200) {
            await checkRoute('viewer /help', `${VIEWER}/help`);
        } else {
            log(`  SKIP viewer /help (status=${helpProbe.status})`);
        }
    } catch (e) {
        log(`  SKIP viewer /help (${e.message})`);
    }

    // Editor cool.html — iter 58. softEtag while the editor-static
    // server hasn't been restarted on the iter 58 code yet (SIGHUP is
    // a no-op there post-build-time-hashing refactor; needs a real
    // restart on next deploy). After that, this should harden.
    await checkRoute('editor /browser/cool.html', `${EDITOR}/browser/cool.html`,
                     { softEtag: true });

    // /config.js — iter 54 (already covered, but rolling regression)
    await checkRoute('viewer /config.js', `${VIEWER}/config.js`);

    log(allPassed ? '=== PASS ===' : '=== FAIL ===');
    process.exit(allPassed ? 0 : 1);
})().catch(e => { console.error('crash:', e); process.exit(2); });
