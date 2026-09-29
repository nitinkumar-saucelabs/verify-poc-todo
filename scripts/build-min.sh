#!/usr/bin/env bash
# The todo app as a customer ships it (ATT-75): one minified bundle.
#
#   app/min/app.min.js        debug id injected; its map is uploaded to Backtrace
#   app/min-nomap/app.min.js  the same bundle with no debug id and no map anywhere
#   symbols/app.min.js.map    the map, kept OUT of app/ so Pages never serves it —
#                             deobfuscation has to come from the upload, not the page
#
# Both builds are deterministic and the debug id is derived from the content, so
# the committed bundle and the uploaded map always agree. Re-run after any change
# to app/, commit the output, then upload:
#
#   npx @backtrace/javascript-cli@0.3.2 upload symbols --include-sources \
#     -s yolo -t "$(cat ~/.sauce/backtrace-yolo-symbol-token)"
set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD="npx --yes esbuild@0.28.2 app/app.js --bundle --minify --format=esm --log-level=warning"
BTJS="npx --yes @backtrace/javascript-cli@0.3.2"

rm -rf app/min app/min-nomap symbols
$ESBUILD --sourcemap=external --sources-content=true --outfile=app/min/app.min.js
$BTJS process app/min --quiet
mkdir -p symbols && mv app/min/app.min.js.map symbols/
$ESBUILD --outfile=app/min-nomap/app.min.js

grep -o 'debugId=[0-9a-f-]*' app/min/app.min.js
