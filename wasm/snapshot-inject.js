    // ── BEGIN snapshot-inject (sourced from wasm/snapshot-inject.js) ──
    // This block is spliced into online.js by wasm/tools/finalize-build.sh
    // immediately before `if (shouldRunNow) callMain(args);`. It runs once
    // per WASM startup. On a snapshot-cold start globalThis.__wasmSnapshotData
    // is undefined and the whole block is a no-op. On warm restore the heap
    // is populated, the mutex/CV/threadpool resets fire, and SECOND_INIT
    // takes the fast path.
    if (!ENVIRONMENT_IS_PTHREAD && typeof globalThis !== 'undefined' &&
        globalThis.__wasmSnapshotData && HEAPU8) {
      try {
        var _snapSrc = new Uint8Array(globalThis.__wasmSnapshotData);
        if (_snapSrc.length <= HEAPU8.length) {
          // Save pthread main thread descriptor across the heap copy.
          var _ptSelf = 0;
          try { _ptSelf = _pthread_self(); } catch(e) {}
          var _saved = null;
          if (_ptSelf > 0) {
            _saved = new Uint8Array(512);
            _saved.set(HEAPU8.subarray(_ptSelf, _ptSelf + 512));
          }
          HEAPU8.set(_snapSrc);
          if (_saved && _ptSelf > 0) HEAPU8.set(_saved, _ptSelf);
          try { if (typeof PThread !== 'undefined' && PThread.threadInitTLS) PThread.threadInitTLS(); } catch(e) {}
          try { if (typeof writeStackCookie === 'function') writeStackCookie(); } catch(e) {}
          // Tell C++ via the synchronous atomic — Desktop::Main reads this
          // from a worker thread later and a MAIN_THREAD_EM_ASM_INT proxy
          // would deadlock against the long-returned WASM main thread.
          try { Module.ccall('wasm_set_warm_restored', null, ['number'], [1]); } catch(e) {}
          // Plan C — clear the quiesce flag carried over from the snapshot.
          // The snapshot was captured with the kit thread holding quiesce=1
          // and the COOLWSD thread parked. On warm restore the COOLWSD
          // thread is freshly spawned (Web Workers don't survive); we want
          // it to enter its main loop normally without re-parking.
          try { Module.ccall('wasm_set_quiesce', null, ['number'], [0]); } catch(e) {}
          // Reinitialize the mutex/CV pairs that were captured mid-park.
          // Without this the new threads dereference dangling waiter
          // pointers in the captured pthread structs and trap with
          // "RuntimeError: unreachable" during the first cond/mutex op.
          try { Module.ccall('wasm_warm_restore_reset', null, [], []);
              console.log('WARM_DBG: wasm_warm_restore_reset returned OK');
          } catch(e) { console.warn('wasm_warm_restore_reset failed:', e); }
          // SolarMutex was held by a captured-but-now-dead thread. Reset
          // ownership so a fresh thread can acquire/release without
          // hitting IsCurrentThread() abort in doRelease.
          try { Module.ccall('wasm_warm_restore_solar_mutex_reset', null, [], []);
              console.log('WARM_DBG: SolarMutex reset OK');
          } catch(e) { console.warn('SolarMutex reset failed:', e); }
          // SvpSalYieldMutex (the actual VCL yield mutex used on every
          // lo_runLoop iteration) holds 7 internal mutex/CV/state members
          // whose pthread waiter lists in the captured snapshot reference
          // the dead cold thread. Plus SvpSalInstance::m_MainThread holds
          // the cold lokit_main thread id, so IsMainThread() returns false
          // on every warm thread. Placement-new the members and refresh
          // m_MainThread so the warm path is deterministic.
          try { Module.ccall('wasm_warm_restore_yield_mutex_reset', null, [], []);
              console.log('WARM_DBG: YieldMutex reset OK');
          } catch(e) { console.warn('YieldMutex reset failed:', e); }
          // FakeSocket's global theMutex/theCV are touched by every
          // kit↔COOLWSD message. Captured waiter list points at dead
          // cold threads — without this reset, fakeSocketConnect's
          // cv.wait() blocks forever on a phantom listener.
          try { Module.ccall('wasm_warm_restore_fakesocket_reset', null, [], []);
              console.log('WARM_DBG: FakeSocket reset OK');
          } catch(e) { console.warn('FakeSocket reset failed:', e); }
          // comphelper::ThreadPool static singleton's worker threads are
          // dead cold pthreads on warm. Calling getSharedOptimalPool()
          // would dispatch to dead workers (Calc multi-thread recalc,
          // image decode). Replace the singleton with a fresh pool — old
          // pool is intentionally leaked to avoid invoking ~ThreadPool()
          // which would try to join the dead pthreads.
          try { Module.ccall('wasm_warm_restore_threadpool_reset', null, [], []);
              console.log('WARM_DBG: ThreadPool reset OK');
          } catch(e) { console.warn('ThreadPool reset failed:', e); }
          // Clear the captured `coolwsd_server_socket_fd` and the
          // freshly-ready gate so is_preinit_done() returns 0 until the
          // new COOLWSD::run() finishes setting up its real server
          // socket and calls notify_coolwsd_server_socket_ready.
          try { Module.ccall('wasm_clear_server_freshly_ready', null, [], []);
              console.log('WARM_DBG: server freshly-ready gate cleared');
          } catch(e) { console.warn('server freshly-ready clear failed:', e); }
          Module.__snapRestoredBeforeMain = true;
          globalThis.__wasmSnapshotRestored = true;
          // Recreate VFS directories that the restored LO Core expects.
          // Visit 1's init created these; Visit 2's fresh VFS doesn't
          // have them. registrymodifications.xcu is required by configmgr.
          try {
            var _fs = Module.FS || FS;
            ['/instdir/user','/instdir/user/config',
             '/instdir/user/extensions','/instdir/user/extensions/bundled',
             '/instdir/user/extensions/shared','/instdir/user/extensions/tmp',
             '/instdir/user/uno_packages','/instdir/user/uno_packages/cache',
             '/instdir/user/registry','/instdir/user/registry/data',
             '/tmp/user','/tmp/user/docs','/tmp/.config'
            ].forEach(function(d) { try { _fs.mkdir(d); } catch(e) {} });
            try { _fs.writeFile('/instdir/user/registrymodifications.xcu',
              '<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n</oor:items>\n');
            } catch(e) {}
            try {
              var _tmpDir = Module.ccall('get_temp_dir_path', 'string', [], []);
              if (_tmpDir) {
                var _parts = _tmpDir.split('/').filter(Boolean);
                var _cur = '';
                for (var _i = 0; _i < _parts.length; _i++) {
                  _cur += '/' + _parts[_i];
                  try { _fs.mkdir(_cur); } catch(e) {}
                }
              }
            } catch(e) {}
          } catch(e) {}
          console.log('[snapshot] Full restore: ' + _snapSrc.length + ' bytes');
        }
      } catch(ex) {
        console.error('[snapshot] Restore error:', ex);
      }
      globalThis.__wasmSnapshotData = null;
    }
    // ── END snapshot-inject ──
