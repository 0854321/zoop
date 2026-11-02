#!/bin/sh
# Builds the web package the hub and the Worker serve (dist/web/noop), then adds what
# `nsh package` has no place for: the push service worker at the site's root (its scope is the
# whole app), a stable icon URL for notifications, and the manifest's colors (the gallery's page).
set -e
cd "$(dirname "$0")"
NSH="${NSH:-$HOME/work/nsh/target/debug/nsh}"
"$NSH" package --target web -o dist/web
OUT="dist/web/noop"
cp web/sw.js "$OUT/sw.js"
cp "$OUT"/icons/192.*.png "$OUT/icons/192.png"
sed -i 's/"background_color": "[^"]*"/"background_color": "#f7f7f4"/; s/"theme_color": "[^"]*"/"theme_color": "#f7f7f4"/' "$OUT/manifest.webmanifest"
echo "✓ added sw.js, icons/192.png, manifest colors"
