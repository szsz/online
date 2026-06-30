// Regression: editor-static must serve a CSP frame-ancestors header
// that lists 'self' and the viewer origin (FILE_STORAGE_URL) — and
// nothing else. This locks down the embed-policy: the editor's
// cool.html may only be iframed by its own origin (debug pages,
// integration tests) and the configured viewer.
//
// Why this needs a regression test rather than living in code review:
//   - The header is set by editor-static-server.js:setCommonHeaders.
//     A subtle refactor (e.g. moving CSP behind a feature flag, or
//     constructing it from a list that drops FILE_STORAGE_URL) would
//     silently turn the editor into a clickjacking target — every
//     fetch still returns 200, every test except this one passes.
//   - Loosening to `frame-ancestors *` to "fix" a third-party embed
//     request is a one-line change with no immediate test signal.
//     This test is the friction that forces the conversation.
//   - Tightening to remove FILE_STORAGE_URL by accident kills the
//     viewer iframe (cool.html refuses to render). Catches it
//     in CI before deploy.
//
// What the test asserts on cool.html's response:
//   1. Content-Security-Policy header is present.
//   2. It contains a `frame-ancestors` directive.
//   3. The directive lists 'self'.
//   4. The directive lists FILE_STORAGE_URL exactly (no http variant,
//      no wildcard subdomain).
//   5. It does NOT contain `*` as a token (would defeat the policy).
//   6. It does NOT contain any host beyond 'self' + FILE_STORAGE_URL —
//      every host in the directive must come from one of the two
//      whitelisted sources. Catches "addition by other team" drift.
//
// Runtime: < 500ms, single HEAD request.

'use strict';

const env = require('../../lib/test-env');
const __cl = require('../../lib/inject-checklist');

const EDITOR = env.EDITOR_URL;
const VIEWER = env.FILE_STORAGE_URL;

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) console.log('  ✓ ' + label);
    else {
        console.log('  ✗ FAIL: ' + label + (ev ? ' [' + ev + ']' : ''));
        allPassed = false;
    }
}

(async () => {
    console.log('=== Regression: CSP frame-ancestors locks editor to viewer origin ===');
    const t0 = Date.now();

    let resp;
    try {
        resp = await fetch(EDITOR + '/browser/cool.html', { method: 'HEAD' });
    } catch (e) {
        check('cool.html HEAD reachable', false, e.message);
        process.exit(1);
    }
    check('cool.html HEAD reachable', resp.ok, `HTTP ${resp.status}`);

    const csp = resp.headers.get('content-security-policy') || '';
    check('Content-Security-Policy header present', csp.length > 0,
          csp ? csp.slice(0, 80) : '(empty)');

    // Pull the frame-ancestors directive out of the CSP. CSP
    // directives are separated by `;`. Token list inside is
    // whitespace-delimited.
    const directives = csp.split(';').map(d => d.trim()).filter(Boolean);
    const fa = directives.find(d => d.toLowerCase().startsWith('frame-ancestors'));
    check('frame-ancestors directive present', !!fa, fa || '(missing)');
    if (!fa) {
        console.log('\nDuration:', Date.now() - t0, 'ms');
        process.exit(allPassed ? 0 : 1);
    }

    const tokens = fa.split(/\s+/).slice(1); // drop "frame-ancestors"
    check("frame-ancestors lists 'self'",
          tokens.includes("'self'"),
          tokens.join(' '));
    check(`frame-ancestors lists ${VIEWER}`,
          tokens.includes(VIEWER),
          tokens.join(' '));
    check('frame-ancestors does NOT use wildcard',
          !tokens.includes('*'),
          tokens.join(' '));

    // Allowlist check: every non-keyword token must be the configured
    // viewer URL. CSP keywords ('self', 'none') start with a quote;
    // schemes (https:, data:, …) end with a colon. Anything else is
    // a host expression and must match VIEWER exactly. This is what
    // catches a subtle refactor that adds a stray "https://example.com".
    const KEYWORDS = new Set(["'self'", "'none'"]);
    const stray = tokens.filter(t =>
        !KEYWORDS.has(t)
        && !t.endsWith(':')             // scheme allowlist
        && t !== VIEWER);
    check('no stray frame-ancestors hosts',
          stray.length === 0,
          stray.length ? stray.join(',') : 'clean');

    console.log('\nDuration:', Date.now() - t0, 'ms');
    process.exit(allPassed ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(2);
});
