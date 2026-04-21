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
			console.log('[snapshot] preRun: adding dependency for deferred snapshot load');
			Module['addRunDependency']('snapshot-load');
			// Skip soffice.data download on restore — the VFS already has
			// all unpacked files from the snapshot. Remove the run dependency
			// that the data loader added, so we don't block on a 24MB fetch.
			var dataDepKey = null;
			for (var k in Module['runDependencies'] || {}) {
				if (k.indexOf('soffice.data') >= 0) { dataDepKey = k; break; }
			}
			if (!dataDepKey) {
				// Emscripten stores deps as a counter + tracking object.
				// Try the known key from the compiled output.
				var knownKeys = [
					'datafile_/lo/core-build-impress/workdir/CustomTarget/static/emscripten_fs_image/soffice.data',
					'datafile_/lo/core-build/workdir/CustomTarget/static/emscripten_fs_image/soffice.data',
					'soffice.data.js.metadata'
				];
				for (var i = 0; i < knownKeys.length; i++) {
					Module['removeRunDependency'](knownKeys[i]);
				}
				console.log('[snapshot] Removed soffice.data run dependencies (snapshot has VFS data)');
			} else {
				Module['removeRunDependency'](dataDepKey);
				console.log('[snapshot] Removed run dependency: ' + dataDepKey);
			}
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
					console.log('[snapshot] Loaded ' + (buf.byteLength / 1048576).toFixed(0) + 'MB from Cache API (deferred), heapBase=' + (meta.heapBase || 0));
					globalThis.__wasmSnapshotData = buf;
					globalThis.__wasmSnapshotMeta = meta;
				} else {
					console.log('[snapshot] Cache entry missing');
				}
				Module['removeRunDependency']('snapshot-load');
			}).catch(function(e) {
				console.error('[snapshot] Deferred load error:', e);
				Module['removeRunDependency']('snapshot-load');
			});
		}],
	};
}
