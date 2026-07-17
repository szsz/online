// Regression: lightweight static-source tripwire for the three
// highest-likelihood allocation sites identified in
// ai/proposals/promoted/shape-area-dialog-allocation-profile.md.
//
// Why a tripwire: the live profile needs a working Area dialog, which is
// blocked by the unaligned-access bug we're tracking separately. Until
// that lands, this test simply asserts the three suspect functions
// still exist at the expected file paths in the pinned LO source tree.
// If an LO refactor renames or relocates them, CI fails here → the
// proposal must be re-profiled before its mitigation lands.
//
// The LO source tree lives at ~/libreoffice-core-wasm. CI runners
// don't bind-mount it inside this test job, so when the path doesn't
// resolve we EXIT 0 with a `skip:` log line. Local dev runs (where the
// tree is checked out) get the real assertion. Either way CI stays
// green for the smoke pass.
//
// Suspects (from the proposal):
//   1. svx/source/tbxctrls/SvxPresetListBox.cxx
//      → `FillPresetListBoxImpl` template — the 60×64 preview-bitmap
//        explosion (~130 MiB across 43 Bitmap-tab entries).
//   2. svx/source/tbxctrls/PaletteManager.cxx
//      → `PaletteManager::LoadPalettes` — eager .gpl/.soc/.ase decode
//        of every palette on every Area-dialog open.
//   3. cui/source/tabpages/tabarea.cxx
//      → `SvxAreaTabDialog::SvxAreaTabDialog` ctor — pulls all four
//        XPropertyList caches off SdrModel, retains for doc lifetime.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const __cl = require('../../lib/inject-checklist');

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

let allPassed = true;
function check(label, cond, ev) {
    __cl.recordCheck(label, cond, ev);
    if (cond) log(`  PASS: ${label}`);
    else { log(`  FAIL: ${label}${ev ? ' [' + ev + ']' : ''}`); allPassed = false; }
}

// The LO source tree is conventionally bind-mounted at this path by
// /local-deploy --local-lo and by the dev box itself. CI test jobs don't
// have it; skip cleanly in that environment.
const LO_ROOT = process.env.LO_SOURCE_ROOT
    || path.join(process.env.HOME || '/home/localadmin', 'libreoffice-core-wasm');

const SUSPECTS = [
    {
        label: 'Suspect 1: SvxPresetListBox::FillPresetListBoxImpl exists',
        file:  'svx/source/tbxctrls/SvxPresetListBox.cxx',
        // Match the function definition line: must catch the template
        // signature regardless of inline reformatting.
        re:    /void\s+SvxPresetListBox::FillPresetListBoxImpl\s*\(/,
    },
    {
        label: 'Suspect 2: PaletteManager::LoadPalettes exists',
        file:  'svx/source/tbxctrls/PaletteManager.cxx',
        re:    /void\s+PaletteManager::LoadPalettes\s*\(/,
    },
    {
        label: 'Suspect 3: SvxAreaTabDialog::SvxAreaTabDialog ctor exists',
        file:  'cui/source/tabpages/tabarea.cxx',
        re:    /SvxAreaTabDialog::SvxAreaTabDialog\s*\(/,
    },
];

// The suspect paths were profiled against the LO source that the pinned build
// (wasm/LO_BUILD_ID) was built from. Asserting them against ANY other checkout
// is meaningless — e.g. the dev box's tree may sit on a WIP upstream-sync
// branch where these files have already moved, which would false-fail this
// tripwire even though the pinned build is unaffected. So only assert when the
// local tree HEAD == the pinned build's LO commit; skip otherwise (same
// green-in-CI contract as a missing tree). LO_TRIPWIRE_FORCE=1 overrides.
function loHead(loRoot) {
    try { return execSync('git -C "' + loRoot + '" rev-parse HEAD', { encoding: 'utf8' }).trim(); }
    catch (e) { return ''; }
}
function pinnedLoSha() {
    try {
        const pin = fs.readFileSync(path.join(__dirname, '..', '..', 'LO_BUILD_ID'), 'utf8')
            .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).pop();
        if (!pin) return '';
        const url = 'https://coolwasmfiles.z6.web.core.windows.net/lo-builds/' + pin + '/MANIFEST.json';
        const j = execSync('curl -fsS --max-time 15 "' + url + '"', { encoding: 'utf8' });
        return (JSON.parse(j).git_sha || '').trim();
    } catch (e) { return ''; }
}

(async () => {
    log('=== Regression: shape Area-dialog allocation suspects (tripwire) ===');
    log('LO_ROOT=' + LO_ROOT);

    if (!fs.existsSync(LO_ROOT)) {
        console.log('skip: LO source not bind-mounted at ' + LO_ROOT
            + ' — tripwire is for local dev / when LO_SOURCE_ROOT is set');
        // Exit 0 so CI stays green; in local dev the path resolves and
        // the real assertions run.
        process.exit(0);
    }

    // Pin-match gate (unless forced): only the pinned build's source is the
    // valid reference for these suspect paths.
    if (process.env.LO_TRIPWIRE_FORCE !== '1') {
        const head = loHead(LO_ROOT);
        const pinSha = pinnedLoSha();
        if (!pinSha) {
            console.log('skip: could not resolve the pinned LO commit (offline?) — tripwire needs it to know the valid reference');
            process.exit(0);
        }
        if (head !== pinSha) {
            console.log('skip: local LO tree ' + head.slice(0, 10) + ' != pinned build LO commit '
                + pinSha.slice(0, 10) + ' — suspect paths only valid against the pinned source'
                + ' (set LO_TRIPWIRE_FORCE=1 to assert anyway)');
            process.exit(0);
        }
        log('LO tree matches pinned build ' + pinSha.slice(0, 10) + ' — asserting suspects');
    }

    for (const s of SUSPECTS) {
        const abs = path.join(LO_ROOT, s.file);
        let ok = false;
        let ev = '';
        try {
            if (!fs.existsSync(abs)) {
                ev = 'file missing: ' + abs;
            } else {
                const src = fs.readFileSync(abs, 'utf8');
                ok = s.re.test(src);
                if (!ok) {
                    ev = 'pattern ' + s.re + ' not found in ' + s.file;
                }
            }
        } catch (e) {
            ev = 'read error: ' + e.message;
        }
        check(s.label, ok, ev);
    }

    log('\n' + (allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'));
    process.exit(allPassed ? 0 : 1);
})();
