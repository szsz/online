		// ── BEGIN locateFile-inject (sourced from wasm/snapshot-inject-locate-file.js) ──
		// Cache-bust support: bundle.js does
		//   globalThis.Module = createEmscriptenModule(...)
		// which clobbers the locateFile shim cool.html sets at the top of
		// the page. Re-derive locateFile from window.__assetMap so
		// online.js's findWasmBinary resolves online.wasm →
		// online.<hash>.wasm correctly. Without this the editor 404s on
		// the un-hashed name and aborts.
		locateFile: function(file, prefix) {
			var mapped = (typeof window !== 'undefined' && window.__assetMap && window.__assetMap[file]) || file;
			return (prefix || '') + mapped;
		},
		// ── END locateFile-inject ──
