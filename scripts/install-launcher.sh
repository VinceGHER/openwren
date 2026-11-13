#!/bin/sh
# Add OpenWren, with its logo, to the applications menu and dock of the current
# user. It starts the release build in this folder (`pnpm tauri build` first).
# Installing the .deb package does the same for all users; this needs no sudo.
# Run with "remove" to undo.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
data="${XDG_DATA_HOME:-$HOME/.local/share}"
entry="$data/applications/openwren.desktop"

if [ "$1" = "remove" ]; then
  rm -f "$entry" "$data"/icons/hicolor/*/apps/openwren.png
  echo "Launcher removed."
  exit 0
fi

binary="$root/src-tauri/target/release/openwren"
[ -x "$binary" ] || { echo "Build the app first: pnpm tauri build --bundles deb" >&2; exit 1; }

install -Dm644 "$root/src-tauri/icons/32x32.png" "$data/icons/hicolor/32x32/apps/openwren.png"
install -Dm644 "$root/src-tauri/icons/128x128.png" "$data/icons/hicolor/128x128/apps/openwren.png"
install -Dm644 "$root/src-tauri/icons/128x128@2x.png" "$data/icons/hicolor/256x256/apps/openwren.png"
install -Dm644 "$root/src-tauri/icons/icon.png" "$data/icons/hicolor/512x512/apps/openwren.png"

mkdir -p "$data/applications"
cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=OpenWren
Comment=An open-source desktop mail client
Exec=$binary
Icon=openwren
StartupWMClass=openwren
Categories=Office;Network;Email;
Terminal=false
EOF
update-desktop-database "$data/applications" 2>/dev/null || true
gtk-update-icon-cache -q -t "$data/icons/hicolor" 2>/dev/null || true
echo "OpenWren is now in your applications menu."
