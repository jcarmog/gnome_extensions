#!/usr/bin/env bash
# Lets the extension connect the VPN without asking for a password.
#
#   sudo ./setup-nopasswd.sh [vpn-directory] [config-file]    # install (re-run after changing the config)
#   sudo ./setup-nopasswd.sh --uninstall
#
# The config is copied to a root-owned directory, and a polkit rule lets only you run
# a fixed helper through pkexec without authenticating. The original config lives on a
# world-writable disk, and its up/down scripts run as root, so running it directly
# without a password would hand root to anything that can edit that file.
set -euo pipefail

HELPER=/usr/local/sbin/search-dev-env-vpn
CONF_DIR=/etc/openvpn/search-dev-env
RULE=/etc/polkit-1/rules.d/50-search-dev-env-vpn.rules

[[ $EUID -eq 0 ]] || { echo "Run with sudo" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
    rm -f "$HELPER" "$RULE"
    rm -rf "$CONF_DIR"
    echo "Removed. The extension asks for your password again."
    exit 0
fi

USER_NAME="${SUDO_USER:?Run with sudo from your own account}"
SRC_DIR="${1:-/media/jose/arquivos/Projetos/Search/VPN/sophos}"
CONFIG="${2:-search-vpn1.ovpn}"
[[ "$CONFIG" != */* ]] || { echo "Config must be a file name inside the directory" >&2; exit 1; }
[[ -f "$SRC_DIR/$CONFIG" ]] || { echo "Not found: $SRC_DIR/$CONFIG" >&2; exit 1; }

install -d -m 700 -o root -g root "$CONF_DIR"
install -m 600 -o root -g root "$SRC_DIR/$CONFIG" "$CONF_DIR/$CONFIG"
# Credentials file referenced by the config, e.g. "auth-user-pass search-vpn.user".
AUTH_FILE=$(sed -nE 's/^[[:space:]]*auth-user-pass[[:space:]]+"?([^"[:space:]]+)"?.*/\1/p' "$SRC_DIR/$CONFIG" | head -n1)
if [[ -n "$AUTH_FILE" && "$AUTH_FILE" != /* ]]; then
    install -m 600 -o root -g root "$SRC_DIR/$AUTH_FILE" "$CONF_DIR/$AUTH_FILE"
fi

cat >"$HELPER" <<EOF
#!/usr/bin/env bash
# Installed by search-dev-env@josecarmo/setup-nopasswd.sh. Runs as root through pkexec
# without a password (see $RULE), so it takes no paths from the caller.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
uid="\${PKEXEC_UID:?run through pkexec}"
user=\$(id -nu "\$uid")
home=\$(getent passwd "\$uid" | cut -d: -f6)

case "\${1:-}" in
start)
    exec systemd-run --scope --collect --quiet --unit search-dev-env-vpn \\
        openvpn --cd $CONF_DIR --config $CONFIG \\
        --management "\$home/.cache/search-dev-env/vpn.sock" unix \\
        --management-client-user "\$user"
    ;;
remove-dco)
    # Only orphaned OpenVPN kernel tunnels may be deleted.
    ifname="\${2:-}"
    [[ "\$ifname" =~ ^[A-Za-z0-9_-]{1,15}\$ ]] || exit 2
    ip -o link show type ovpn-dco | grep -q "^[0-9]*: \$ifname[:@]" || exit 3
    exec ip link delete "\$ifname"
    ;;
*)
    echo "usage: \$0 start | remove-dco IFNAME" >&2
    exit 2
    ;;
esac
EOF
chown root:root "$HELPER"
chmod 755 "$HELPER"

cat >"$RULE" <<EOF
// Installed by search-dev-env@josecarmo/setup-nopasswd.sh
polkit.addRule(function (action, subject) {
    if (action.id == "org.freedesktop.policykit.exec" &&
        action.lookup("program") == "$HELPER" &&
        subject.user == "$USER_NAME" && subject.local && subject.active)
        return polkit.Result.YES;
});
EOF
chmod 644 "$RULE"

echo "Installed: $HELPER, $RULE, $CONF_DIR/$CONFIG"
echo "The extension now connects without a password. Re-run this after editing the VPN config."
