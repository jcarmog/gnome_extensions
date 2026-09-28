import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DISPLAY_MODES = [
    ['session', 'Session usage (5h)'],
    ['weekly', 'Weekly usage'],
    ['both', 'Session and weekly'],
    ['tokens-today', 'Tokens used today'],
    ['icon', 'Icon only'],
];

export default class AiMetricsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // Panel
        const panel = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(panel);

        const display = new Adw.ComboRow({
            title: 'Show next to icon',
            model: Gtk.StringList.new(DISPLAY_MODES.map(([, label]) => label)),
        });
        const current = DISPLAY_MODES.findIndex(([id]) => id === settings.get_string('panel-display'));
        display.selected = Math.max(0, current);
        display.connect('notify::selected', () => {
            settings.set_string('panel-display', DISPLAY_MODES[display.selected][0]);
        });
        panel.add(display);

        panel.add(this._spinRow(settings, 'warning-threshold', 'Warning at (%)', 1, 100, 1));
        panel.add(this._spinRow(settings, 'critical-threshold', 'Critical at (%)', 1, 100, 1));

        const notify = new Adw.SwitchRow({
            title: 'Notify when limits get high',
            subtitle: 'Once per threshold and reset window',
        });
        settings.bind('notify', notify, 'active', Gio.SettingsBindFlags.DEFAULT);
        panel.add(notify);

        // Data
        const data = new Adw.PreferencesGroup({
            title: 'Data',
            description: 'Limits come from your Claude Code login (read-only). Token totals are computed from local Claude Code transcripts.',
        });
        page.add(data);

        data.add(this._spinRow(settings, 'refresh-interval', 'Refresh interval (seconds)', 30, 3600, 30));

        const local = new Adw.SwitchRow({
            title: 'Local token statistics',
            subtitle: 'Parse ~/.claude/projects transcripts',
        });
        settings.bind('show-local-stats', local, 'active', Gio.SettingsBindFlags.DEFAULT);
        data.add(local);

        const dir = new Adw.EntryRow({title: 'Claude config directory (empty = ~/.claude)'});
        settings.bind('claude-config-dir', dir, 'text', Gio.SettingsBindFlags.DEFAULT);
        data.add(dir);

        // Gemini
        const gemini = new Adw.PreferencesGroup({
            title: 'Gemini',
            description: 'Antigravity quotas are read from its local language server while the IDE is running. ' +
                'Gemini CLI quotas use its Google login (~/.gemini/oauth_creds.json, read-only).',
        });
        page.add(gemini);

        const rows = [
            ['gemini-antigravity', 'Antigravity IDE quotas', 'Shared quota pools per model family'],
            ['gemini-cli', 'Gemini CLI', 'Per-model quota and local token totals'],
            ['panel-gemini', 'Show Gemini in the top bar', 'Adds the highest Gemini usage, e.g. “G 12%”'],
        ];
        for (const [key, title, subtitle] of rows) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            gemini.add(row);
        }

        const gdir = new Adw.EntryRow({title: 'Gemini CLI config directory (empty = ~/.gemini)'});
        settings.bind('gemini-config-dir', gdir, 'text', Gio.SettingsBindFlags.DEFAULT);
        gemini.add(gdir);

        const oauth = new Adw.PreferencesGroup({
            title: 'Gemini CLI OAuth client',
            description: 'Only needed to refresh an expired Gemini CLI login. Empty = use ' +
                'GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET from the session environment.',
        });
        page.add(oauth);

        const cid = new Adw.EntryRow({title: 'Client ID'});
        settings.bind('gemini-oauth-client-id', cid, 'text', Gio.SettingsBindFlags.DEFAULT);
        oauth.add(cid);

        const csecret = new Adw.PasswordEntryRow({title: 'Client secret'});
        settings.bind('gemini-oauth-client-secret', csecret, 'text', Gio.SettingsBindFlags.DEFAULT);
        oauth.add(csecret);
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
