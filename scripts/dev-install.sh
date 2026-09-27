#!/bin/sh
# Point a Zotero profile at this checkout (a "proxy file") so edits load on restart
# without rebuilding the .xpi. Quit Zotero before running.
#   sh scripts/dev-install.sh [path/to/profile]
set -e
cd "$(dirname "$0")/.."
ID=$(node -p "require('./addon/manifest.json').applications.zotero.id")
PROFILE=${1:-$(ls -d "$HOME/Library/Application Support/Zotero/Profiles/"*.default* 2>/dev/null | head -1)}
if [ -z "$PROFILE" ] || [ ! -d "$PROFILE" ]; then
	echo "Zotero profile not found; pass its path as the first argument" >&2
	exit 1
fi
if pgrep -xq zotero; then
	echo "Quit Zotero first" >&2
	exit 1
fi
mkdir -p "$PROFILE/extensions"
rm -f "$PROFILE/extensions/$ID.xpi"
printf '%s' "$PWD/addon" > "$PROFILE/extensions/$ID"
# Force Zotero to rescan extensions on next start
sed -i '' '/extensions\.lastAppBuildId/d; /extensions\.lastAppVersion/d' "$PROFILE/prefs.js"
echo "Linked $ID -> $PWD/addon in $PROFILE"
