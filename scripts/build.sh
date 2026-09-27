#!/bin/sh
# Package addon/ into build/opendata-cite-<version>.xpi
set -e
cd "$(dirname "$0")/.."
version=$(node -p "require('./addon/manifest.json').version")
mkdir -p build
out="build/opendata-cite-$version.xpi"
rm -f "$out"
(cd addon && zip -qr -X "../$out" . -x '.*')
echo "$out"
