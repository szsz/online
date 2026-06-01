// local-loader.js — iframe "open one local file" bootstrap.
//
// Static-baked into cool.html by wasm/build-dist.sh as a defer'd
// <script>. Runs after online.js defines createOnlineModule and before
// the deferred emscripten-module.js / bundle.js call into it.
//
// Two responsibilities:
//
//   A. Locale override (always runs).
//      Reads ?lang= (ISO 3166-1 Alpha-2) and writes
//      globalThis.LANG, overriding the 'en-US' hardcode in
//      browser/js/global.js's Emscripten branch. Must run before
//      bundle.js — l10n-all.js (prepended to bundle.js by
//      wasm/tools/cache-bust-build.js) reads window.LANG
//      synchronously at parse time to pick which LOCALIZATIONS
//      table to install.
//
//   B. Local-file injection (only when ?localFileId= is set, so
//      cool.html stays a drop-in for the regular collaboration flow
//      served by COOLWSD):
//        1. Force __wasmKillswitchPreloadDisabled — single-file mode
//           doesn't want LO Core's preloadDocumentModules.
//        2. Wrap createOnlineModule with a preRun that fetches
//           /local-file/{id} (served by the wrapper app's SW from
//           its cache) and writes the bytes into the Emscripten FS
//           at file_path. Boot is gated on addRunDependency('userfile').
//        3. Prepend onRuntimeInitialized to call wasm_set_user_name
//           (wasm/wasmapp.cpp) before bundle.js sends HULLO, so the
//           relay cursor label + Track Changes author match ?UserName=.
(function () {
	var params = new URLSearchParams(location.search);

	var lang = params.get("lang");
	if (lang) {
		globalThis.LANG = lang;
	}

	var fileId = params.get("localFileId");
	if (!fileId) {
		return;
	}
	var filePath = params.get("file_path");
	if (!filePath || filePath[0] !== "/" || filePath.indexOf("\0") !== -1) {
		console.error("local-loader: invalid file_path:", filePath);
		return;
	}

	var username = params.get("UserName") || "";
	if (username.length > 256) {
		username = username.slice(0, 256);
	}

	window.__wasmKillswitchPreloadDisabled = true;

	var _orig = createOnlineModule;
	createOnlineModule = function (module) {
		module.preRun = module.preRun || [];
		module.preRun.push(function () {
			globalThis.Module.addRunDependency("userfile");
			fetch("/local-file/" + encodeURIComponent(fileId))
				.then(function (r) {
					return r.arrayBuffer();
				})
				.then(function (data) {
					var fs = globalThis.Module.FS;
					try {
						fs.mkdirTree("/tmp");
					} catch (e) {}
					fs.writeFile(filePath, new Uint8Array(data));
					globalThis.Module.removeRunDependency("userfile");
				})
				.catch(function (err) {
					console.error("local-loader: FS inject failed:", err);
					globalThis.Module.removeRunDependency("userfile");
				});
		});

		var result = _orig(module);

		// Prepend (not append) — must run before bundle.js's HULLO send.
		// Capture onRuntimeInitialized after _orig in case bundle.js
		// installed one during createOnlineModule().
		if (username) {
			var prevOnInit = module.onRuntimeInitialized;
			module.onRuntimeInitialized = function () {
				try {
					globalThis.Module.ccall(
						"wasm_set_user_name",
						null,
						["string"],
						[username],
					);
				} catch (e) {
					console.warn("local-loader: wasm_set_user_name failed:", e);
				}
				if (prevOnInit) prevOnInit.call(this);
			};
		}
		return result;
	};
})();
