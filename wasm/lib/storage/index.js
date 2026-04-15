// Storage backend selector for the viewer / file-storage server.
//
// Choose backend with STORAGE_BACKEND=local|azure (default: local).
//   local  → wasm/lib/storage/local.js  (LOCAL_STORAGE_DIR or ./storage)
//   azure  → wasm/lib/storage/azure.js  (DOC_STORAGE_ACCOUNT / DOC_STORAGE_KEY)

const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

let impl;
if (backend === 'local')      impl = require('./local');
else if (backend === 'azure') impl = require('./azure');
else throw new Error(`Unknown STORAGE_BACKEND "${backend}" (use "local" or "azure")`);

module.exports = impl;
module.exports.backend = backend;
