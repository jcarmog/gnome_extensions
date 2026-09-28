#!/usr/bin/env bash
# Install (symlink) the extension for the current user and compile its settings schema.
set -euo pipefail
UUID="search-dev-env@josecarmo"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"
mkdir -p "$(dirname "$DEST")"
if [[ -e "$DEST" && ! -L "$DEST" ]]; then
    echo "Refusing to replace existing non-symlink $DEST" >&2
    exit 1
fi
ln -sfn "$SRC" "$DEST"
echo "Installed to $DEST"

if [[ "${1:-}" == "--pack" ]]; then
    gnome-extensions pack "$SRC" --force --out-dir "$(dirname "$SRC")"
    echo "Packed $(dirname "$SRC")/$UUID.shell-extension.zip"
fi

cat <<MSG
Next steps:
  1. Log out and back in (Wayland) or press Alt+F2, r, Enter (X11).
  2. gnome-extensions enable $UUID
MSG
