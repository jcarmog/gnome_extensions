import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {AntigravityClient} from './lib/antigravity.js';
import {UsageClient} from './lib/api.js';
import {GeminiCliClient, parseGeminiChat} from './lib/geminiCli.js';
import {LocalStats} from './lib/localStats.js';

const BAR_WIDTH = 280;
const HOUR = 3600 * 1000;
const USAGE_PAGE = 'https://claude.ai/settings/usage';

const LIMIT_LABELS = {
    session: 'Current session (5h)',
    five_hour: 'Current session (5h)',
    weekly_all: 'Weekly · all models',
    seven_day: 'Weekly · all models',
    weekly_opus: 'Weekly · Opus',
    seven_day_opus: 'Weekly · Opus',
    weekly_sonnet: 'Weekly · Sonnet',
    seven_day_sonnet: 'Weekly · Sonnet',
    seven_day_oauth_apps: 'Weekly · OAuth apps',
};

// ---------- formatting helpers ----------

function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    // St.BoxLayout gained `orientation` in GNOME 48 and deprecated `vertical`.
    if (box.orientation !== undefined)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function fmtTokens(n) {
    if (n >= 1e9)
        return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
    if (n >= 1e3)
        return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
    return `${n}`;
}

function fmtDuration(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = min % 60;
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}

function fmtLocal(ms, format) {
    return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format(format);
}

function fmtReset(resetsAt) {
    if (!resetsAt)
        return 'Starts with your next message';
    const t = Date.parse(resetsAt);
    const left = t - Date.now();
    if (left <= 0)
        return 'Resetting now';
    const when = left < 20 * HOUR ? fmtLocal(t, '%H:%M') : fmtLocal(t, '%a %d %b, %H:%M');
    return `Resets in ${fmtDuration(left)} · ${when}`;
}

function prettyModel(model) {
    return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function prettyPlan(subscription, tier) {
    const names = {pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free'};
    let plan = names[subscription] ?? subscription ?? 'Claude';
    const mult = /(\d+)x/.exec(tier ?? '');
    if (mult)
        plan += ` ${mult[1]}×`;
    return plan;
}

// Normalises the usage response into [{key, label, percent, resetsAt}].
function extractLimits(usage) {
    const out = [];
    if (Array.isArray(usage?.limits) && usage.limits.length > 0) {
        for (const l of usage.limits) {
            if (typeof l?.percent !== 'number')
                continue;
            const label = LIMIT_LABELS[l.kind] ??
                `${l.group === 'weekly' ? 'Weekly' : 'Limit'} · ${String(l.kind).replace(/^weekly_/, '').replace(/_/g, ' ')}`;
            out.push({key: l.kind, label, percent: l.percent, resetsAt: l.resets_at ?? null});
        }
        return out;
    }
    for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps']) {
        const w = usage?.[key];
        if (w && typeof w.utilization === 'number')
            out.push({key, label: LIMIT_LABELS[key], percent: w.utilization, resetsAt: w.resets_at ?? null});
    }
    return out;
}

// ---------- indicator ----------

const AiMetricsIndicator = GObject.registerClass(
class AiMetricsIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'AI Metrics');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._api = new UsageClient();
        this._local = new LocalStats();
        this._antigravity = new AntigravityClient();
        this._geminiCli = new GeminiCliClient();
        this._geminiLocal = new LocalStats({
            parse: parseGeminiChat,
            accept: (name, path) => path.includes('/chats/') && /\.jsonl?$/.test(name),
        });
        this._state = {
            remote: null, error: null, localError: null, updated: null,
            antigravity: null, antigravityError: null,
            geminiCli: null, geminiCliError: null, geminiLocalError: null,
        };
        this._notified = new Map();
        this._refreshing = false;
        this._timerId = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/ai-metrics-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-metrics-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this.menu.box.add_style_class_name('ai-metrics-menu');
        this._buildMenu();

        this._settingsIds = [
            this._settings.connect('changed::refresh-interval', () => this._restartTimer()),
            this._settings.connect('changed::panel-display', () => this._render()),
            this._settings.connect('changed::warning-threshold', () => this._render()),
            this._settings.connect('changed::critical-threshold', () => this._render()),
            this._settings.connect('changed::show-local-stats', () => this._refresh()),
            this._settings.connect('changed::claude-config-dir', () => this._refresh()),
            this._settings.connect('changed::gemini-antigravity', () => this._refresh()),
            this._settings.connect('changed::gemini-cli', () => this._refresh()),
            this._settings.connect('changed::gemini-config-dir', () => this._refresh()),
            this._settings.connect('changed::gemini-oauth-client-id', () => this._refresh()),
            this._settings.connect('changed::gemini-oauth-client-secret', () => this._refresh()),
            this._settings.connect('changed::panel-gemini', () => this._render()),
        ];
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._render();
        });

        this._restartTimer();
        this._refresh();
    }

    _buildMenu() {
        this._headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const header = vbox({x_expand: true});
        this._planLabel = new St.Label({text: 'Claude', style_class: 'ai-metrics-header'});
        this._updatedLabel = new St.Label({text: '', style_class: 'ai-metrics-sub'});
        header.add_child(this._planLabel);
        header.add_child(this._updatedLabel);
        this._headerItem.add_child(header);
        this.menu.addMenuItem(this._headerItem);

        this._limitsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._limitsSection);

        this._localSeparator = new PopupMenu.PopupSeparatorMenuItem('Tokens (Claude Code on this machine)');
        this.menu.addMenuItem(this._localSeparator);
        this._localSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._localSection);
        this._modelsMenu = new PopupMenu.PopupSubMenuMenuItem('By model (this week)');
        this.menu.addMenuItem(this._modelsMenu);

        this._geminiSeparator = new PopupMenu.PopupSeparatorMenuItem('Gemini');
        this.menu.addMenuItem(this._geminiSeparator);
        this._geminiSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._geminiSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._refreshItem = this.menu.addAction('Refresh now', () => this._refresh());
        this.menu.addAction('Open usage page on claude.ai', () => {
            Gio.AppInfo.launch_default_for_uri_async(USAGE_PAGE, null, null, null);
        });
        this.menu.addAction('Settings', () => this._ext.openPreferences());
    }

    get _configDir() {
        const custom = this._settings.get_string('claude-config-dir').trim();
        if (custom)
            return custom.replace(/^~(?=\/|$)/, GLib.get_home_dir());
        return GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    }

    get _geminiDir() {
        const custom = this._settings.get_string('gemini-config-dir').trim();
        if (custom)
            return custom.replace(/^~(?=\/|$)/, GLib.get_home_dir());
        return GLib.build_filenamev([GLib.get_home_dir(), '.gemini']);
    }

    // Settings first, then the session environment. Never hardcoded.
    get _geminiOAuth() {
        const pick = (key, env) => this._settings.get_string(key).trim() || GLib.getenv(env)?.trim() || null;
        return {
            clientId: pick('gemini-oauth-client-id', 'GEMINI_OAUTH_CLIENT_ID'),
            clientSecret: pick('gemini-oauth-client-secret', 'GEMINI_OAUTH_CLIENT_SECRET'),
        };
    }

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const interval = Math.max(30, this._settings.get_int('refresh-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (this._refreshing || this._destroyed)
            return;
        this._refreshing = true;
        this._refreshItem.label.text = 'Refreshing…';
        const dir = this._configDir;
        const wantLocal = this._settings.get_boolean('show-local-stats');

        const gdir = this._geminiDir;
        const wantAntigravity = this._settings.get_boolean('gemini-antigravity');
        const wantGeminiCli = this._settings.get_boolean('gemini-cli');

        const [remote, local, antigravity, geminiCli, geminiLocal] = await Promise.allSettled([
            this._api.fetchUsage(dir),
            wantLocal ? this._local.scan(GLib.build_filenamev([dir, 'projects'])) : Promise.resolve(null),
            wantAntigravity ? this._antigravity.fetchQuota() : Promise.resolve(null),
            wantGeminiCli ? this._geminiCli.fetchQuota(gdir, this._geminiOAuth) : Promise.resolve(null),
            wantGeminiCli ? this._geminiLocal.scan(GLib.build_filenamev([gdir, 'tmp'])) : Promise.resolve(null),
        ]);
        if (this._destroyed)
            return;

        const settle = (result, key) => {
            if (result.status === 'fulfilled') {
                this._state[key] = result.value;
                this._state[`${key}Error`] = null;
            } else {
                // Keep the last good data but show why it is stale.
                this._state[`${key}Error`] = result.reason;
                if (!result.reason?.kind)
                    console.warn(`[ai-metrics] ${key} failed: ${result.reason}`);
            }
        };
        settle(antigravity, 'antigravity');
        settle(geminiCli, 'geminiCli');
        if (antigravity.status === 'rejected' && antigravity.reason?.kind === 'offline')
            this._state.antigravity = null;
        if (geminiCli.status === 'rejected' && geminiCli.reason?.kind === 'offline')
            this._state.geminiCli = null;
        this._state.geminiLocalError = geminiLocal.status === 'rejected' ? geminiLocal.reason : null;

        if (remote.status === 'fulfilled') {
            this._state.remote = remote.value;
            this._state.error = null;
            this._state.updated = Date.now();
        } else {
            this._state.error = remote.reason;
            if (!(remote.reason?.kind))
                console.warn(`[ai-metrics] usage fetch failed: ${remote.reason}`);
        }
        this._state.localError = local.status === 'rejected' ? local.reason : null;
        this._state.localEnabled = wantLocal;

        this._refreshing = false;
        this._refreshItem.label.text = 'Refresh now';
        this._render();
        this._maybeNotify();
    }

    _level(percent) {
        if (percent >= this._settings.get_int('critical-threshold'))
            return 'critical';
        if (percent >= this._settings.get_int('warning-threshold'))
            return 'warning';
        return '';
    }

    _windows(limits) {
        const now = Date.now();
        const d = GLib.DateTime.new_now_local();
        const today = GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0)
            .to_unix() * 1000;
        const startOf = (key, span, fallback) => {
            const l = limits.find(x => x.key === key);
            const t = l?.resetsAt ? Date.parse(l.resetsAt) : NaN;
            return !Number.isNaN(t) && t > now ? t - span : fallback;
        };
        const session = limits.some(l => l.key === 'session')
            ? startOf('session', 5 * HOUR, now - 5 * HOUR)
            : startOf('five_hour', 5 * HOUR, now - 5 * HOUR);
        const week = limits.some(l => l.key === 'weekly_all')
            ? startOf('weekly_all', 168 * HOUR, now - 168 * HOUR)
            : startOf('seven_day', 168 * HOUR, now - 168 * HOUR);
        return {session, today, week, all: 0};
    }

    _render() {
        if (this._destroyed)
            return;
        const {remote, error} = this._state;
        const limits = remote ? extractLimits(remote.usage) : [];

        // Header
        this._planLabel.text = remote ? `Claude ${prettyPlan(remote.subscription, remote.tier)} plan` : 'Claude usage';
        this._updatedLabel.text = this._state.updated
            ? `Updated ${fmtDuration(Date.now() - this._state.updated)} ago`
            : '';
        if (this._state.updated && Date.now() - this._state.updated < 60000)
            this._updatedLabel.text = 'Updated just now';

        // Limits
        this._limitsSection.removeAll();
        if (error)
            this._limitsSection.addMenuItem(this._textItem(error.message ?? String(error), 'ai-metrics-error'));
        for (const l of limits)
            this._limitsSection.addMenuItem(this._limitItem(l));
        const extra = remote?.usage?.extra_usage;
        if (extra?.is_enabled && typeof extra.monthly_limit === 'number') {
            const scale = 10 ** (extra.decimal_places ?? 2);
            const used = (extra.used_credits ?? 0) / scale;
            const limit = extra.monthly_limit / scale;
            this._limitsSection.addMenuItem(this._limitItem({
                label: 'Extra usage (this month)',
                percent: extra.utilization ?? (limit > 0 ? (used / limit) * 100 : 0),
                sub: `${used.toFixed(2)} / ${limit.toFixed(2)} ${extra.currency ?? ''}`.trim(),
            }));
        }
        if (!error && limits.length === 0)
            this._limitsSection.addMenuItem(this._textItem('Loading…', 'ai-metrics-sub'));

        // Local tokens
        const showLocal = this._settings.get_boolean('show-local-stats');
        this._localSeparator.visible = showLocal;
        this._localSection.actor.visible = showLocal;
        this._modelsMenu.visible = showLocal;
        this._localSection.removeAll();
        this._modelsMenu.menu.removeAll();
        let tokensToday = null;
        if (showLocal) {
            const stats = this._local.summarize(this._windows(limits));
            tokensToday = stats.today.total;
            if (this._state.localError)
                this._localSection.addMenuItem(this._textItem(`Could not read transcripts: ${this._state.localError.message}`, 'ai-metrics-error'));
            const rows = [
                ['This session window', stats.session],
                ['Today', stats.today],
                ['This week', stats.week],
                ['All time', stats.all],
            ];
            for (const [label, t] of rows)
                this._localSection.addMenuItem(this._tokenItem(label, t));

            const models = Object.entries(stats.week.models).sort((a, b) => b[1].total - a[1].total);
            if (models.length === 0)
                this._modelsMenu.menu.addMenuItem(this._textItem('No usage this week', 'ai-metrics-sub'));
            for (const [model, m] of models) {
                const share = stats.week.total ? Math.round((m.total / stats.week.total) * 100) : 0;
                this._modelsMenu.menu.addMenuItem(this._pairItem(prettyModel(model),
                    `${fmtTokens(m.total)} · ${share}%`,
                    `${m.messages} requests · in ${fmtTokens(m.input)} · out ${fmtTokens(m.output)}`));
            }
        }

        this._renderGemini();
        this._renderPanel(limits, tokensToday);
    }

    // [{key, label, percent, resetsAt}] across all Gemini sources.
    _geminiLimits() {
        const out = [];
        for (const p of this._state.antigravity?.pools ?? [])
            out.push({key: `ag:${p.label}`, label: `Antigravity · ${p.label}`, percent: p.percent, resetsAt: p.resetsAt});
        for (const b of this._state.geminiCli?.buckets ?? [])
            out.push({key: `gcli:${b.label}`, label: `Gemini CLI · ${b.label}`, percent: b.percent, resetsAt: b.resetsAt});
        return out;
    }

    _renderGemini() {
        const wantAg = this._settings.get_boolean('gemini-antigravity');
        const wantCli = this._settings.get_boolean('gemini-cli');
        this._geminiSeparator.visible = wantAg || wantCli;
        this._geminiSection.removeAll();
        const s = this._state;

        if (wantAg) {
            const ag = s.antigravity;
            if (ag) {
                this._geminiSection.addMenuItem(this._textItem(
                    `Antigravity${ag.plan ? ` · ${ag.plan}` : ''}`, 'ai-metrics-header'));
                for (const p of ag.pools)
                    this._geminiSection.addMenuItem(this._limitItem(p));
                if (ag.pools.length > 0) {
                    const sub = new PopupMenu.PopupSubMenuMenuItem('Antigravity models');
                    for (const p of ag.pools) {
                        for (const m of p.models)
                            sub.menu.addMenuItem(this._pairItem(m, `${Math.round(p.percent)}% used`));
                    }
                    this._geminiSection.addMenuItem(sub);
                }
            }
            if (s.antigravityError)
                this._geminiSection.addMenuItem(this._textItem(`Antigravity: ${s.antigravityError.message}`,
                    s.antigravityError.kind === 'offline' ? 'ai-metrics-sub' : 'ai-metrics-error'));
        }

        if (wantCli) {
            const cli = s.geminiCli;
            if (cli) {
                this._geminiSection.addMenuItem(this._textItem(
                    `Gemini CLI${cli.plan ? ` · ${cli.plan}` : ''}`, 'ai-metrics-header'));
                for (const b of cli.buckets)
                    this._geminiSection.addMenuItem(this._limitItem(b));
            }
            if (s.geminiCliError)
                this._geminiSection.addMenuItem(this._textItem(`Gemini CLI: ${s.geminiCliError.message}`,
                    s.geminiCliError.kind === 'offline' ? 'ai-metrics-sub' : 'ai-metrics-error'));

            const now = Date.now();
            const d = GLib.DateTime.new_now_local();
            const today = GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0)
                .to_unix() * 1000;
            const stats = this._geminiLocal.summarize({today, week: now - 168 * HOUR, all: 0});
            if (stats.all.messages > 0) {
                this._geminiSection.addMenuItem(this._tokenItem('Gemini CLI tokens today', stats.today));
                this._geminiSection.addMenuItem(this._tokenItem('Last 7 days', stats.week));
                this._geminiSection.addMenuItem(this._tokenItem('All time', stats.all));
            }
            if (s.geminiLocalError)
                this._geminiSection.addMenuItem(this._textItem(
                    `Could not read Gemini CLI chats: ${s.geminiLocalError.message}`, 'ai-metrics-error'));
        }
    }

    _renderPanel(limits, tokensToday) {
        const mode = this._settings.get_string('panel-display');
        const session = limits.find(l => l.key === 'session' || l.key === 'five_hour');
        const weekly = limits.find(l => l.key === 'weekly_all' || l.key === 'seven_day');
        const pct = l => (l ? `${Math.round(l.percent)}%` : '–');

        let text;
        let level = '';
        switch (mode) {
        case 'weekly':
            text = pct(weekly);
            level = weekly ? this._level(weekly.percent) : '';
            break;
        case 'both':
            text = `${pct(session)} · ${pct(weekly)}`;
            level = this._level(Math.max(session?.percent ?? 0, weekly?.percent ?? 0));
            break;
        case 'tokens-today':
            text = tokensToday === null ? '–' : fmtTokens(tokensToday);
            level = this._level(Math.max(0, ...limits.map(l => l.percent)));
            break;
        case 'icon':
            text = '';
            level = this._level(Math.max(0, ...limits.map(l => l.percent)));
            break;
        default:
            text = pct(session);
            level = session ? this._level(session.percent) : '';
        }
        if (this._state.error && !this._state.remote)
            text = mode === 'icon' ? '' : '!';

        const gemini = this._geminiLimits();
        if (mode !== 'icon' && this._settings.get_boolean('panel-gemini') && gemini.length > 0) {
            const g = Math.max(...gemini.map(l => l.percent));
            text = `${text} · G ${Math.round(g)}%`;
            if (this._level(g) === 'critical' || (this._level(g) === 'warning' && level === ''))
                level = this._level(g);
        }

        this._label.text = text;
        this._label.visible = text !== '';
        this._label.style_class = `ai-metrics-panel-label ${level}`.trim();
        this._icon.opacity = this._state.error ? 128 : 255;
    }

    _maybeNotify() {
        if (!this._settings.get_boolean('notify'))
            return;
        const all = [
            ...(this._state.remote ? extractLimits(this._state.remote.usage) : []),
            ...this._geminiLimits(),
        ];
        for (const l of all) {
            const level = this._level(l.percent);
            const id = `${l.key}:${l.resetsAt}`;
            const prev = this._notified.get(id) ?? '';
            const rank = {'': 0, warning: 1, critical: 2};
            if (rank[level] > rank[prev]) {
                this._notified.set(id, level);
                const who = l.key.includes(':') ? 'Gemini' : 'Claude';
                Main.notify(`${who}: ${l.label} at ${Math.round(l.percent)}%`, fmtReset(l.resetsAt));
            }
        }
    }

    // ---------- menu item builders ----------

    _textItem(text, styleClass) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const label = new St.Label({text, style_class: styleClass, x_expand: true});
        label.clutter_text.line_wrap = true;
        item.add_child(label);
        return item;
    }

    _pairItem(title, value, sub) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true});
        const row = new St.BoxLayout({x_expand: true});
        row.add_child(new St.Label({text: title, x_expand: true, style_class: 'ai-metrics-row-title'}));
        row.add_child(new St.Label({text: value, style_class: 'ai-metrics-value'}));
        box.add_child(row);
        if (sub)
            box.add_child(new St.Label({text: sub, style_class: 'ai-metrics-sub'}));
        item.add_child(box);
        return item;
    }

    _limitItem({label, percent, resetsAt, sub}) {
        const level = this._level(percent);
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = vbox({x_expand: true});

        const row = new St.BoxLayout({x_expand: true});
        row.add_child(new St.Label({text: label, x_expand: true, style_class: 'ai-metrics-row-title'}));
        row.add_child(new St.Label({text: `${Math.round(percent)}% used`, style_class: `ai-metrics-pct ${level}`.trim()}));
        box.add_child(row);

        const trough = new St.Widget({style_class: 'ai-metrics-bar', layout_manager: new Clutter.BinLayout()});
        const fill = new St.Widget({
            style_class: `ai-metrics-bar-fill ${level}`.trim(),
            x_align: Clutter.ActorAlign.START,
            width: Math.round(BAR_WIDTH * Math.min(100, Math.max(0, percent)) / 100),
        });
        trough.add_child(fill);
        box.add_child(trough);

        box.add_child(new St.Label({text: sub ?? fmtReset(resetsAt), style_class: 'ai-metrics-sub'}));
        item.add_child(box);
        return item;
    }

    _tokenItem(label, t) {
        return this._pairItem(label, `${fmtTokens(t.total)} tokens`,
            `${t.messages} req · in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · ` +
            `cache w ${fmtTokens(t.cacheWrite)} / r ${fmtTokens(t.cacheRead)}`);
    }

    destroy() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._api.destroy();
        this._local.destroy();
        this._antigravity.destroy();
        this._geminiCli.destroy();
        this._geminiLocal.destroy();
        this._settings = null;
        super.destroy();
    }
});

export default class AiMetricsExtension extends Extension {
    enable() {
        this._indicator = new AiMetricsIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
