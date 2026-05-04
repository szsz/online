#!/usr/bin/env bash
# Ad-hoc runner for test-regression-sab-context.js.
# Demonstrates that puppeteer pages MUST use separate browserContexts
# for co-editing (shared context corrupts SAB / WASM memory).
# Removed from the main suite on 2026-05-04 — the corruption window
# is timing-dependent and flakes under JOBS=2.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node adhoc-tests/test-regression-sab-context.js
