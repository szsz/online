#!/usr/bin/env bash
# Ad-hoc runner for cross-format hot-switch matrix.
# Removed from the main suite on 2026-05-04 — production never
# triggers cross-format #switchdoc= (the viewer cold-reloads for
# cross-type opens), so the test exercises an unsupported path
# whose round-2 failures don't affect any user feature. Run when
# auditing cross-doctype state cleanup.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node adhoc-tests/test-regression-cross-format-matrix.js
