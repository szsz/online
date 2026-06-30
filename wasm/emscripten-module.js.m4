m4_changequote(@[,]@)m4_dnl
/* exported createEmscriptenModule */
function createEmscriptenModule(documentKind, documentDescriptor) {
	// ── WASM memory snapshot deferred load ──
	// If a snapshot exists in Cache API, we load the 73MB ArrayBuffer
	// DURING preRun (after WASM module instantiation) instead of at page
	// start. Loading it before module instantiation causes memory pressure
	// that breaks __wasm_call_ctors. The preRun function adds an Emscripten
	// run dependency to delay callMain() until the snapshot is loaded.
	// The actual HEAPU8 restore happens in the deploy.sh injection right
	// before callMain(), after initRuntime has fully completed.
	var _snapshotDepAdded = false;
	return {
		arguments: [documentKind, documentDescriptor],
		uno_scripts: [m4_ifelse(ENABLE_WASM_ZETAJS, @[true]@, @['zeta.js'm4_ifelse(ENABLE_WASM_EMBINDTEST, @[true]@, @[, 'smoketest.js']@)m4_ifelse(ENABLE_WASM_ZETAJS_EXAMPLE, @[true]@, @[, 'emscripten-zetajs-example.js']@)]@)],
		preRun: [function() {
			if (_snapshotDepAdded || !globalThis.__wasmSnapshotExists) return;
			_snapshotDepAdded = true;
			// Use a unique dep id to avoid colliding with main.js's
			// addRunDependency('snapshot-load') — the assert at
			// online.js:1150 (`!runDependencyTracking[id]`) fires if both
			// run on the same Module. Both deps must reach 0 for callMain.
			Module['addRunDependency']('snapshot-load-emm');

			// Fast path: wasm-loader.js already kicked off the snapshot
			// arrayBuffer() read and published the Promise. Awaiting it
			// here avoids a redundant 142 MB Cache-Storage re-read
			// (which previously cost ~485 ms on every warm restore +
			// stalled bundle.js parse on warm-1).
			var existing = globalThis.__wasmSnapshotDataPromise;
			if (existing && typeof existing.then === 'function') {
				console.log('[snapshot] preRun: awaiting eager-scheduled read');
				existing.then(function(buf) {
					if (buf) {
						console.log('[snapshot] Loaded ' +
							(buf.byteLength / 1048576).toFixed(0) +
							'MB via eager path (no redundant read)');
					}
					Module['removeRunDependency']('snapshot-load-emm');
				});
				return;
			}

			// Fallback: eager path didn't run (defensive; in practice
			// __wasmSnapshotExists=true ⇒ wasm-loader called
			// startSnapshotRead which always publishes a Promise).
			// Retains the original Cache-Storage path so a future
			// loader refactor that drops the eager scheduler doesn't
			// silently break warm restore.
			console.log('[snapshot] preRun: no eager promise; fallback to Cache re-read');
			caches.open('wasm-snapshot').then(function(cache) {
				return Promise.all([
					cache.match('/snapshot/heap-v2'),
					cache.match('/snapshot/meta')
				]);
			}).then(function(results) {
				var heapResp = results[0], metaResp = results[1];
				return Promise.all([
					heapResp ? heapResp.arrayBuffer() : Promise.resolve(null),
					metaResp ? metaResp.json() : Promise.resolve({})
				]);
			}).then(function(data) {
				var buf = data[0], meta = data[1];
				if (buf) {
					console.log('[snapshot] Loaded ' + (buf.byteLength / 1048576).toFixed(0) + 'MB from Cache API (fallback), heapBase=' + (meta.heapBase || 0));
					globalThis.__wasmSnapshotData = buf;
					globalThis.__wasmSnapshotMeta = meta;
				} else {
					console.log('[snapshot] Cache entry missing');
				}
				Module['removeRunDependency']('snapshot-load-emm');
			}).catch(function(e) {
				console.error('[snapshot] Deferred load error:', e);
				Module['removeRunDependency']('snapshot-load-emm');
			});
		}],
	};
}
