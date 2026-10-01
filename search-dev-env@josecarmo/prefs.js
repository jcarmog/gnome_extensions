import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SearchDevEnvPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const vpn = new Adw.PreferencesGroup({
            title: 'VPN',
            description: 'Runs “openvpn --cd &lt;directory&gt; --config &lt;file&gt;” through pkexec, so you are asked for your password when connecting. After running setup-nopasswd.sh, no password is asked and these two paths are ignored (it uses its own copy of the config).',
        });
        page.add(vpn);
        vpn.add(this._entryRow(settings, 'vpn-directory', 'Directory'));
        vpn.add(this._entryRow(settings, 'vpn-config', 'Config file'));
        vpn.add(this._entryRow(settings, 'vpn-check-url', 'Connectivity check URL'));

        const kube = new Adw.PreferencesGroup({
            title: 'Kube Monitor',
            description: 'The start command runs with “bash -lc” inside the project directory. Stopping sends SIGTERM to whatever listens on the port.',
        });
        page.add(kube);
        kube.add(this._entryRow(settings, 'kube-directory', 'Project directory'));
        kube.add(this._entryRow(settings, 'kube-start-command', 'Start command'));
        kube.add(this._spinRow(settings, 'kube-port', 'Port', 1, 65535, 1));
        kube.add(this._entryRow(settings, 'kube-app-id', 'App ID (empty: auto-detect PWA)'));

        const general = new Adw.PreferencesGroup({title: 'Status'});
        page.add(general);
        general.add(this._spinRow(settings, 'refresh-interval', 'Refresh interval (seconds)', 1, 300, 1));
    }

    _entryRow(settings, key, title) {
        const row = new Adw.EntryRow({title});
        settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow(settings, key, title, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
