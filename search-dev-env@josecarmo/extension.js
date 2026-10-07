import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const TITLE = 'Search Dev Environment';
const KUBE_START_TIMEOUT = 300 * 1000; // mvn build + Spring Boot startup
const STOP_TIMEOUT = 30 * 1000;
const PKEXEC_CANCELLED = [126, 127];
// Installed by setup-nopasswd.sh; a polkit rule lets it run through pkexec without a password.
const NOPASSWD_HELPER = '/usr/local/sbin/search-dev-env-vpn';

const STATUS_TEXT = {
    off: 'Off',
    starting: 'Starting…',
    on: 'Running',
    stopping: 'Stopping…',
};

// ---------- helpers ----------

function expandHome(path) {
    return path.startsWith('~') ? GLib.get_home_dir() + path.slice(1) : path;
}

function cacheDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'search-dev-env']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

// Terminal emulators in order of preference, with the arguments that precede the command.
const TERMINALS = [
    ['xdg-terminal-exec'],
    ['ptyxis', '--'],
    ['kgx', '--'],
    ['gnome-terminal', '--'],
    ['x-terminal-emulator', '-e'],
];

/** Follows a log file in a terminal window; -F keeps waiting if the file does not exist yet. */
function tailInTerminal(path) {
    const command = ['tail', '-n', '200', '-F', path];
    for (const [program, ...args] of TERMINALS) {
        const exe = GLib.find_program_in_path(program);
        if (exe) {
            spawn([exe, ...args, ...command]);
            return;
        }
    }
    Main.notifyError(TITLE, 'No terminal emulator found to show the log.');
}

/**
 * Sends one command to the OpenVPN management interface and returns the
 * response lines (without the trailing END). Throws if nothing is listening.
 */
async function vpnManagement(socketPath, command) {
    const client = new Gio.SocketClient({timeout: 3});
    const conn = await client.connect_async(new Gio.UnixSocketAddress({path: socketPath}), null);
    try {
        const input = new Gio.DataInputStream({base_stream: conn.get_input_stream()});
        await input.read_line_async(GLib.PRIORITY_DEFAULT, null); // ">INFO:OpenVPN Management Interface…"
        await conn.get_output_stream().write_all_async(
            new TextEncoder().encode(`${command}\n`), GLib.PRIORITY_DEFAULT, null);

        const lines = [];
        for (;;) {
            const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
            if (line === null || line === 'END')
                break;
            if (line.startsWith('>')) // real-time notification, not part of the reply
                continue;
            if (line.startsWith('ERROR:'))
                throw new Error(line);
            lines.push(line);
            if (line.startsWith('SUCCESS:'))
                break;
        }
        return lines;
    } finally {
        conn.close(null);
    }
}

async function isPortOpen(port) {
    const client = new Gio.SocketClient({timeout: 2});
    try {
        const conn = await client.connect_to_host_async('127.0.0.1', port, null);
        conn.close(null);
        return true;
    } catch {
        return false;
    }
}

/** True when the URL answers with any HTTP status (a 403 still proves the network is reachable). */
async function isUrlReachable(session, url) {
    try {
        const stream = await session.send_async(Soup.Message.new('HEAD', url), GLib.PRIORITY_DEFAULT, null);
        stream.close(null);
        return true;
    } catch {
        return false;
    }
}

function spawn(argv, {cwd = null, logPath = null} = {}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: logPath ? Gio.SubprocessFlags.STDERR_MERGE : Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    if (cwd)
        launcher.set_cwd(cwd);
    if (logPath)
        launcher.set_stdout_file_path(logPath);
    return launcher.spawnv(argv);
}

/** Runs a command and returns its stdout, or null if it could not run or failed. */
async function output(argv) {
    try {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return proc.get_successful() ? stdout : null;
    } catch {
        return null;
    }
}

/**
 * OpenVPN data-channel-offload interfaces. With DCO the tunnel lives in the kernel,
 * so it keeps carrying traffic even if the openvpn process was killed without
 * cleaning up; that orphaned tunnel is only visible here.
 */
async function dcoInterfaces() {
    const json = await output(['ip', '-j', 'addr', 'show', 'type', 'ovpn-dco']);
    try {
        // iproute2 prints an empty {} for every interface the type filter excludes.
        return JSON.parse(json ?? '[]').filter(i => i.ifname).map(i => ({
            name: i.ifname,
            address: i.addr_info?.find(a => a.family === 'inet')?.local ?? '',
        }));
    } catch {
        return [];
    }
}

function waitProcess(proc) {
    return new Promise(resolve => {
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {}
            resolve(p.get_if_exited() ? p.get_exit_status() : -1);
        });
    });
}

// ---------- indicator ----------

const DevEnvIndicator = GObject.registerClass(
class DevEnvIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, TITLE);
        this._ext = ext;
        this._settings = ext.getSettings();
        // Not in $XDG_RUNTIME_DIR: that is wiped on logout while the VPN keeps running.
        this._socketPath = GLib.build_filenamev([cacheDir(), 'vpn.sock']);
        this._vpnLog = GLib.build_filenamev([cacheDir(), 'openvpn.log']);
        this._kubeStartLog = GLib.build_filenamev([cacheDir(), 'kube-monitor-start.log']);
        this._http = new Soup.Session({timeout: 5});

        this._vpn = {state: 'off', detail: '', limited: false, proc: null, pending: null, pendingSince: 0, orphan: null};
        this._kube = {state: 'off', detail: '', limited: false, proc: null, pending: null, pendingSince: 0};

        this._icon = new St.Icon({icon_name: 'network-vpn-disabled-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._buildMenu();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

        this._refresh();
    }

    _buildMenu() {
        this._allItem = new PopupMenu.PopupSwitchMenuItem(TITLE, false);
        this._allItem.label.add_style_class_name('sde-header');
        this._allItem.connect('toggled', (_item, on) => this._setAll(on));
        this.menu.addMenuItem(this._allItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        [this._vpnItem, this._vpnLabel] = this._serviceItem('VPN (Sophos)', on => (on ? this._startVpn() : this._stopVpn()));
        [this._kubeItem, this._kubeLabel] = this._serviceItem('Kube Monitor', on => (on ? this._startKube() : this._stopKube()));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._openKubeItem = this.menu.addAction('Open Kube Monitor', () => this._openKube());
        this.menu.addAction('VPN log', () => tailInTerminal(this._vpnLog));
        this.menu.addAction('Kube Monitor log', () => {
            const appLog = GLib.build_filenamev([expandHome(this._settings.get_string('kube-directory')), 'app.log']);
            tailInTerminal(GLib.file_test(appLog, GLib.FileTest.EXISTS) ? appLog : this._kubeStartLog);
        });
        this.menu.addAction('Settings', () => this._ext.openPreferences());
    }

    _serviceItem(title, onToggle) {
        const item = new PopupMenu.PopupSwitchMenuItem(title, false);
        const status = new St.Label({style_class: 'sde-status', y_align: Clutter.ActorAlign.CENTER});
        item.insert_child_above(status, item.label);
        item.connect('toggled', (_item, on) => onToggle(on));
        this.menu.addMenuItem(item);
        return [item, status];
    }

    // ---------- VPN ----------

    _startVpn() {
        if (this._vpn.state !== 'off')
            return;
        const helper = GLib.file_test(NOPASSWD_HELPER, GLib.FileTest.IS_EXECUTABLE);
        const dir = expandHome(this._settings.get_string('vpn-directory'));
        const config = this._settings.get_string('vpn-config');
        const openvpn = GLib.find_program_in_path('openvpn');
        const systemdRun = GLib.find_program_in_path('systemd-run');
        // The helper runs its own root-owned copy of the config.
        if (!helper && (!openvpn || !systemdRun)) {
            this._error(`${openvpn ? 'systemd-run' : 'openvpn'} is not installed`);
            return;
        }
        if (!helper && !GLib.file_test(GLib.build_filenamev([dir, config]), GLib.FileTest.EXISTS)) {
            this._error(`VPN config not found: ${dir}/${config}`);
            return;
        }
        // A stale socket from a crashed openvpn would make the new one fail to bind.
        GLib.unlink(this._socketPath);

        let proc;
        try {
            // systemd-run --scope moves openvpn out of gnome-shell's cgroup, which
            // systemd kills on logout; it still runs in the foreground so we can wait on it.
            proc = spawn(helper ? ['pkexec', NOPASSWD_HELPER, 'start'] : [
                'pkexec', systemdRun, '--scope', '--collect', '--quiet', '--unit', 'search-dev-env-vpn',
                openvpn,
                '--cd', dir,
                '--config', config,
                '--management', this._socketPath, 'unix',
                '--management-client-user', GLib.get_user_name(),
            ], {cwd: helper ? null : dir, logPath: this._vpnLog});
        } catch (e) {
            this._error(`Could not start OpenVPN: ${e.message}`);
            return;
        }
        this._vpn.proc = proc;
        this._setPending(this._vpn, 'starting');
        waitProcess(proc).then(status => {
            if (this._vpn.proc === proc)
                this._vpn.proc = null;
            if (this._vpn.pending === 'starting' || this._vpn.state === 'starting') {
                if (PKEXEC_CANCELLED.includes(status))
                    this._error('VPN not started: authentication was cancelled');
                else if (status !== 0)
                    this._error(`OpenVPN exited with status ${status}. See the VPN log.`);
                this._vpn.pending = null;
            }
            this._refresh();
        });
        this._refresh();
    }

    async _stopVpn() {
        if (this._vpn.state === 'off' || this._vpn.state === 'stopping')
            return;
        this._setPending(this._vpn, 'stopping');
        this._refresh();
        if (this._vpn.orphan) {
            await this._removeOrphan(this._vpn.orphan);
            this._refresh();
            return;
        }
        try {
            await vpnManagement(this._socketPath, 'signal SIGTERM');
        } catch {
            // No management socket yet: pkexec is still asking for the password.
            if (this._vpn.proc)
                this._vpn.proc.force_exit();
            else
                this._error('Could not reach OpenVPN to stop it. Stop it with: sudo pkill openvpn');
        }
        this._refresh();
    }

    // No openvpn is left to tear the tunnel down, so delete the interface (and its routes) directly.
    async _removeOrphan(ifname) {
        let status;
        try {
            const argv = GLib.file_test(NOPASSWD_HELPER, GLib.FileTest.IS_EXECUTABLE)
                ? ['pkexec', NOPASSWD_HELPER, 'remove-dco', ifname]
                : ['pkexec', 'ip', 'link', 'delete', ifname];
            status = await waitProcess(spawn(argv));
        } catch {
            status = -1;
        }
        if (status !== 0) {
            this._vpn.pending = null;
            if (!PKEXEC_CANCELLED.includes(status))
                this._error(`Could not remove ${ifname}. Remove it with: sudo ip link delete ${ifname}`);
        }
    }

    async _vpnStatus() {
        let running = false, connected = false, reachable = true, detail = '';
        this._vpn.orphan = null;
        try {
            const lines = await vpnManagement(this._socketPath, 'state');
            // e.g. "1727550000,CONNECTED,SUCCESS,10.8.0.6,203.0.113.1,443,,"
            const fields = (lines.find(l => /^\d+,/.test(l)) ?? '').split(',');
            running = true;
            connected = fields[1] === 'CONNECTED';
            detail = connected ? fields[3] ?? '' : (fields[1] ?? '').toLowerCase();
        } catch {
            running = this._vpn.proc !== null;
            const [orphan] = running ? [] : await dcoInterfaces();
            if (orphan) {
                this._vpn.orphan = orphan.name;
                running = connected = true;
                detail = [orphan.address, 'unmanaged'].filter(Boolean).join(' · ');
            }
        }
        const checkUrl = this._settings.get_string('vpn-check-url');
        if (connected && checkUrl) {
            reachable = await isUrlReachable(this._http, checkUrl);
            if (!reachable)
                detail = detail ? `${detail} · no access` : 'no access';
        }
        return {running, connected, reachable, detail};
    }

    // ---------- Kube Monitor ----------

    // Prefers the installed PWA; falls back to the browser when it can't be found.
    _openKube() {
        const appSystem = Shell.AppSystem.get_default();
        const appId = this._settings.get_string('kube-app-id');
        const app = appId
            ? appSystem.lookup_app(appId)
            : appSystem.get_installed().filter(info => info.get_name() === 'Kube Monitor')
                .map(info => appSystem.lookup_app(info.get_id())).find(a => a);
        if (app)
            app.activate();
        else
            Gio.AppInfo.launch_default_for_uri_async(`http://localhost:${this._settings.get_int('kube-port')}`, null, null, null);
    }

    _startKube() {
        if (this._kube.state !== 'off')
            return;
        const dir = expandHome(this._settings.get_string('kube-directory'));
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
            this._error(`Kube Monitor directory not found: ${dir}`);
            return;
        }
        let proc;
        try {
            // Login shell so PATH/JAVA_HOME from the profile are available to mvn and java.
            proc = spawn(['bash', '-lc', this._settings.get_string('kube-start-command')],
                {cwd: dir, logPath: this._kubeStartLog});
        } catch (e) {
            this._error(`Could not start Kube Monitor: ${e.message}`);
            return;
        }
        this._kube.proc = proc;
        this._setPending(this._kube, 'starting');
        waitProcess(proc).then(status => {
            if (this._kube.proc === proc)
                this._kube.proc = null;
            if (status !== 0 && this._kube.pending === 'starting') {
                this._error(`Kube Monitor start command failed (status ${status}). See the Kube Monitor log.`);
                this._kube.pending = null;
            }
            this._refresh();
        });
        this._refresh();
    }

    _stopKube() {
        if (this._kube.state === 'off' || this._kube.state === 'stopping')
            return;
        this._kube.proc?.force_exit();
        this._setPending(this._kube, 'stopping');
        try {
            spawn(['fuser', '-k', '-TERM', `${this._settings.get_int('kube-port')}/tcp`]);
        } catch (e) {
            this._error(`Could not stop Kube Monitor: ${e.message}`);
        }
        this._refresh();
    }

    // ---------- state ----------

    _setAll(on) {
        if (on) {
            this._startVpn();
            this._startKube();
        } else {
            // Kube Monitor keeps running; it has its own switch.
            this._stopVpn();
        }
    }

    _setPending(service, pending) {
        service.pending = pending;
        service.pendingSince = Date.now();
    }

    _resolve(service, isOn, isStarting, startTimeout) {
        const age = Date.now() - service.pendingSince;
        if (service.pending === 'stopping') {
            if (!isOn && !isStarting || age > STOP_TIMEOUT)
                service.pending = null;
            else
                return 'stopping';
        }
        if (isOn) {
            if (service.pending === 'starting')
                service.pending = null;
            return 'on';
        }
        if (isStarting)
            return 'starting';
        if (service.pending === 'starting' && age < startTimeout)
            return 'starting';
        service.pending = null;
        return 'off';
    }

    async _refresh() {
        if (this._refreshing) {
            this._refreshAgain = true;
            return;
        }
        this._refreshing = true;
        try {
            const [vpn, kubeUp] = await Promise.all([
                this._vpnStatus(),
                isPortOpen(this._settings.get_int('kube-port')),
            ]);
            if (this._destroyed)
                return;

            this._vpn.state = this._resolve(this._vpn, vpn.connected, vpn.running, 0);
            this._vpn.detail = vpn.detail;
            this._vpn.limited = this._vpn.state === 'on' && !vpn.reachable;
            this._kube.state = this._resolve(this._kube, kubeUp, this._kube.proc !== null, KUBE_START_TIMEOUT);
            this._kube.detail = kubeUp ? `:${this._settings.get_int('kube-port')}` : '';
            this._sync();
        } catch (e) {
            console.error(`[${this._ext.uuid}] refresh failed: ${e}`);
        } finally {
            this._refreshing = false;
        }
        if (this._destroyed)
            return;
        if (this._refreshAgain) {
            this._refreshAgain = false;
            this._refresh();
            return;
        }
        this._schedule();
    }

    _schedule() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        const busy = [this._vpn.state, this._kube.state].some(s => s === 'starting' || s === 'stopping');
        const seconds = busy ? 1 : this._settings.get_int('refresh-interval');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const vpn = this._vpn.state, kube = this._kube.state;

        this._syncItem(this._vpnItem, this._vpnLabel, this._vpn);
        this._syncItem(this._kubeItem, this._kubeLabel, this._kube);
        this._allItem.setToggleState([vpn, kube].every(s => s === 'on' || s === 'starting'));
        this._openKubeItem.visible = kube === 'on';

        this._icon.icon_name = vpn === 'off' ? 'network-vpn-disabled-symbolic' : 'network-vpn-symbolic';
        this._icon.remove_style_class_name('sde-on');
        this._icon.remove_style_class_name('sde-partial');
        if (vpn === 'on' && kube === 'on' && !this._vpn.limited)
            this._icon.add_style_class_name('sde-on');
        else if (vpn !== 'off' || kube !== 'off')
            this._icon.add_style_class_name('sde-partial');
    }

    _syncItem(item, label, service) {
        item.setToggleState(service.state === 'on' || service.state === 'starting');
        let text = STATUS_TEXT[service.state];
        if (service.detail && service.state !== 'off')
            text = service.state === 'on' ? `${text} · ${service.detail}` : `${text} (${service.detail})`;
        label.text = text;
        label.style_class = `sde-status sde-${service.limited ? 'limited' : service.state}`;
    }

    _error(message) {
        console.warn(`[${this._ext.uuid}] ${message}`);
        Main.notify(TITLE, message);
    }

    destroy() {
        this._destroyed = true;
        this._http.abort();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

export default class SearchDevEnvExtension extends Extension {
    enable() {
        this._indicator = new DevEnvIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        // The VPN and Kube Monitor keep running; the indicator picks them up again on enable.
        this._indicator?.destroy();
        this._indicator = null;
    }
}
