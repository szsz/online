#!/bin/bash
# Hash-deploy: rename static files with content hashes for cache busting.
# Usage: bash wasm/hash-deploy.sh /tmp/static-deploy/public/browser
#
# Renames: bundle.js → bundle.a1b2c3d4.js
# Updates: cool.html references to use hashed filenames

DIR="${1:-/tmp/static-deploy/public/browser}"
cd "$DIR" || exit 1

# Files to hash-rename (large cached files)
FILES_TO_HASH="online.wasm online.js bundle.js bundle.css global.js relay-adapter.js font-loader.js emscripten-module.js wasm-loader.js soffice.data soffice.data.js.metadata"

echo "=== Content-hash deploy ==="
MANIFEST=""

for f in $FILES_TO_HASH; do
    [ ! -f "$f" ] && continue
    
    # Compute 8-char content hash
    HASH=$(sha256sum "$f" | cut -c1-8)
    EXT="${f##*.}"
    BASE="${f%.*}"
    
    # Handle double extensions like soffice.data.js.metadata
    if echo "$f" | grep -q '\.data\.js\.'; then
        HASHED="${f%.data.js.metadata}.${HASH}.data.js.metadata"
    else
        HASHED="${BASE}.${HASH}.${EXT}"
    fi
    
    # Copy with hashed name (keep original for backward compat)
    cp "$f" "$HASHED"
    [ -f "${f}.br" ] && cp "${f}.br" "${HASHED}.br"
    
    MANIFEST="${MANIFEST}${f}|${HASHED}\n"
    echo "  $f → $HASHED"
done

# Update cool.html with hashed filenames
echo ""
echo "Updating cool.html..."
cp cool.html cool.html.bak

# Replace references in cool.html
echo -e "$MANIFEST" | while IFS='|' read -r orig hashed; do
    [ -z "$orig" ] && continue
    # Escape dots for sed
    ORIG_ESC=$(echo "$orig" | sed 's/\./\\./g')
    sed -i "s|${ORIG_ESC}|${hashed}|g" cool.html
done

echo ""
echo "Updating editor.html..."
# Also update editor.html preload URLs
EDITOR="../editor.html"
if [ -f "$EDITOR" ]; then
    cp "$EDITOR" "${EDITOR}.bak"
    echo -e "$MANIFEST" | while IFS='|' read -r orig hashed; do
        [ -z "$orig" ] && continue
        ORIG_ESC=$(echo "$orig" | sed 's/\./\\./g')
        sed -i "s|${ORIG_ESC}|${hashed}|g" "$EDITOR"
    done
fi

# Write manifest file for the server
echo -e "$MANIFEST" | grep -v '^$' > asset-manifest.txt
echo ""
echo "=== Deploy complete ==="
echo "Manifest written to asset-manifest.txt"
cat asset-manifest.txt
