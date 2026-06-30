// Tiny shared helper: every test creates a Checklist, calls .check(label, ok, evidence)
// for each programmatic assertion, and on exit writes /tmp/static-deploy/public/shots-<name>/checklist.json
// which the report generator renders into the test's report.
const fs = require('fs');
const path = require('path');

class Checklist {
    constructor(testName, shotsDir) {
        this.testName = testName;
        this.shotsDir = shotsDir;
        this.items = [];
        this.startedAt = new Date().toISOString();
    }
    check(name, ok, evidence) {
        const item = {
            name,
            passed: !!ok,
            evidence: typeof evidence === 'string' ? evidence : (evidence == null ? '' : JSON.stringify(evidence)),
            t: Date.now(),
        };
        this.items.push(item);
        const mark = ok ? '✓' : '✗';
        const ev = item.evidence ? '  // ' + item.evidence : '';
        console.log(`  [check ${mark}] ${name}${ev}`);
        return ok;
    }
    save() {
        try {
            fs.mkdirSync(this.shotsDir, { recursive: true });
            const out = {
                test: this.testName,
                startedAt: this.startedAt,
                finishedAt: new Date().toISOString(),
                passed: this.items.every(x => x.passed),
                total: this.items.length,
                failed: this.items.filter(x => !x.passed).length,
                items: this.items,
            };
            fs.writeFileSync(path.join(this.shotsDir, 'checklist.json'),
                JSON.stringify(out, null, 2));
        } catch (e) {
            console.error('Failed to save checklist:', e.message);
        }
    }
    allPassed() { return this.items.every(x => x.passed); }
    summary() {
        const p = this.items.filter(x => x.passed).length;
        return `${p}/${this.items.length} checks passed`;
    }
}

module.exports = { Checklist };
