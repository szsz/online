// Test: Folder API — create folders, upload files into folders, list tree.
// Verifies the viewer-server folder endpoints and storage layer folder support.

const http = require('http');
const VIEWER = process.env.VIEWER_URL || 'http://localhost:6934';
const T0 = Date.now();
function log(m) { console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); }

function api(method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, VIEWER);
        const opts = { method, headers: headers || {} };
        const req = http.request(url, opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch(e) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (body) {
            if (typeof body === 'object' && !(body instanceof Buffer)) {
                req.setHeader('Content-Type', 'application/json');
                req.end(JSON.stringify(body));
            } else {
                req.end(body);
            }
        } else {
            req.end();
        }
    });
}

let allPassed = true;
function check(label, cond) {
    if (cond) log(`  ✓ ${label}`);
    else { log(`  ✗ FAIL: ${label}`); allPassed = false; }
}

(async () => {
    const ts = Date.now();
    log('=== Folder API Test ===');

    // 1. Create folders
    log('--- Creating folders ---');
    const r1 = await api('POST', '/api/folders', { path: `test-${ts}` });
    check('Create root folder', r1.status === 200 && r1.body.created);

    const r2 = await api('POST', '/api/folders', { path: `test-${ts}/sub1` });
    check('Create subfolder', r2.status === 200 && r2.body.created);

    const r3 = await api('POST', '/api/folders', { path: `test-${ts}/sub1/deep` });
    check('Create deep subfolder', r3.status === 200 && r3.body.created);

    // 2. List folders
    const folders = await api('GET', '/api/folders');
    check('Folder list contains root', folders.body.includes(`test-${ts}`));
    check('Folder list contains sub1', folders.body.includes(`test-${ts}/sub1`));
    check('Folder list contains deep', folders.body.includes(`test-${ts}/sub1/deep`));

    // 3. Upload files into folders
    log('--- Uploading files into folders ---');
    const r4 = await api('POST', `/api/files/${encodeURIComponent(`test-${ts}/doc1.docx`)}`, Buffer.from('docx content'));
    check('Upload to root folder', r4.status === 200 && r4.body.name === `test-${ts}/doc1.docx`);

    const r5 = await api('POST', `/api/files/${encodeURIComponent(`test-${ts}/sub1/sheet.xlsx`)}`, Buffer.from('xlsx content'));
    check('Upload to subfolder', r5.status === 200 && r5.body.name === `test-${ts}/sub1/sheet.xlsx`);

    const r6 = await api('POST', `/api/files/${encodeURIComponent(`test-${ts}/sub1/deep/slides.pptx`)}`, Buffer.from('pptx content'));
    check('Upload to deep folder', r6.status === 200 && r6.body.name === `test-${ts}/sub1/deep/slides.pptx`);

    // 4. List files — verify all three appear
    const files = await api('GET', '/api/files/');
    const names = files.body.map(f => f.name);
    check('File list has root file', names.includes(`test-${ts}/doc1.docx`));
    check('File list has subfolder file', names.includes(`test-${ts}/sub1/sheet.xlsx`));
    check('File list has deep file', names.includes(`test-${ts}/sub1/deep/slides.pptx`));

    // 5. Download file from nested path
    log('--- Downloading nested file ---');
    const r7 = await api('GET', `/api/files/${encodeURIComponent(`test-${ts}/sub1/sheet.xlsx`)}`);
    check('Download nested file', r7.status === 200 && r7.body === 'xlsx content');

    // 6. Path traversal rejection
    log('--- Security checks ---');
    const r8 = await api('POST', '/api/folders', { path: '../escape' });
    check('Reject path traversal in folder', r8.status === 400);

    const r9 = await api('POST', `/api/files/${encodeURIComponent('../escape.txt')}`, Buffer.from('bad'));
    check('Reject path traversal in file', r9.status === 500 || r9.body.error);

    // Summary
    log('');
    if (allPassed) {
        log('✓ ALL FOLDER API TESTS PASSED');
    } else {
        log('✗ SOME TESTS FAILED');
        process.exitCode = 1;
    }
})();
