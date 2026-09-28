# Search Dev Environment — GNOME Shell extension

A top-bar toggle for the Search development environment (GNOME Shell 45–49):

- **VPN (Sophos)**: `openvpn --cd /media/jose/arquivos/Projetos/Search/VPN/sophos --config search-vpn1.ovpn`,
  run through `pkexec` (you get the normal GNOME password dialog instead of `sudo`).
- **Kube Monitor**: runs `./run.sh` in `~/Projetos/kube-monitor` (builds and starts it on port 8900).

The main switch turns both on, but turning it off only disconnects the VPN and leaves
Kube Monitor running. Each one also has its own switch (use Kube Monitor's to stop it). The icon turns
yellow when only part of the environment is up and green when everything is running.

## How it works

- OpenVPN runs as root in its own systemd scope (`pkexec systemd-run --scope … openvpn`),
  so logging out or restarting GNOME Shell does not kill it. It opens a management socket at
  `~/.cache/search-dev-env/vpn.sock` that only your user may connect to. Status comes from its
  `state` command and disconnecting sends `signal SIGTERM`, so you only need your password to connect.
- If openvpn died without cleaning up, its kernel (DCO) tunnel can keep carrying traffic.
  The VPN then shows "unmanaged", and switching it off deletes the interface
  (`pkexec ip link delete tun0`).
- While the tunnel is up, a HEAD request to `https://deploy.searchtecnologia.com.br` checks
  that the network behind it is actually reachable (any HTTP status counts, even 403).
  If it fails, the VPN shows "no access" in yellow and the icon stays yellow.
- Kube Monitor counts as running while something listens on the port. Stopping sends
  SIGTERM to that process (`fuser -k -TERM 8900/tcp`).
- Logs: OpenVPN output goes to `~/.cache/search-dev-env/openvpn.log`, the `run.sh` build
  output to `~/.cache/search-dev-env/kube-monitor-start.log`, and the app itself keeps
  writing `app.log` in the project directory.
- Disabling the extension or logging out does not stop the VPN or Kube Monitor.

Paths, the start command, the port and the refresh interval can be changed in Settings.

## Install

```bash
./install.sh            # symlinks into ~/.local/share/gnome-shell/extensions and compiles the schema
# log out and back in (Wayland), then:
gnome-extensions enable search-dev-env@josecarmo
```
