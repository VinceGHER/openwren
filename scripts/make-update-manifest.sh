#!/usr/bin/env bash
# Write latest.json: the small public file every OpenWren downloads to learn
# whether a newer version exists (src-tauri/src/updates.rs), and that the in-app
# updater reads to find the signed update for its system.
#
#   scripts/make-update-manifest.sh <version> <dir-with-release-files> <output-file>
#
# The directory must hold the AppImage, the Windows setup .exe and the macOS
# .app.tar.gz, each with its <file>.sig next to it (made by `tauri signer sign`).
# Needs: jq.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: $0 <version> <dir-with-release-files> <output-file>" >&2
  exit 2
fi
version=$1
dir=$(cd "$2" && pwd)
out=$3
base="https://packages.openwren.app/releases/$version"
root=$(cd "$(dirname "$0")/.." && pwd)

one() { # the single file matching a pattern, with its signature
  local pattern=$1 found
  shopt -s nullglob
  found=("$dir"/$pattern)
  [ ${#found[@]} -eq 1 ] || { echo "$0: expected exactly one $pattern in $dir, found ${#found[@]}" >&2; exit 1; }
  [ -s "${found[0]}.sig" ] || { echo "$0: ${found[0]} has no signature" >&2; exit 1; }
  basename "${found[0]}"
}
appimage=$(one '*.AppImage')
windows=$(one '*-setup.exe')
macos=$(one '*.app.tar.gz')

# One line about the release: the bullet points of its CHANGELOG section.
notes=$(awk -v v="## $version" '$0 == v {on = 1; next} /^## / {on = 0} on && /^- / {sub(/^- /, ""); printf "%s ", $0}' "$root/CHANGELOG.md" | sed 's/`//g; s/ *$//' | cut -c1-280)

jq -n \
  --arg version "$version" \
  --arg notes "$notes" \
  --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg base "$base" \
  --arg appimage "$appimage" --arg appimage_sig "$(cat "$dir/$appimage.sig")" \
  --arg windows "$windows" --arg windows_sig "$(cat "$dir/$windows.sig")" \
  --arg macos "$macos" --arg macos_sig "$(cat "$dir/$macos.sig")" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $date,
    platforms: {
      "linux-x86_64":   { url: "\($base)/\($appimage)", signature: $appimage_sig },
      "windows-x86_64": { url: "\($base)/\($windows)",  signature: $windows_sig },
      "darwin-aarch64": { url: "\($base)/\($macos)",    signature: $macos_sig },
      "darwin-x86_64":  { url: "\($base)/\($macos)",    signature: $macos_sig }
    }
  }' > "$out"
echo "wrote $out for version $version"
