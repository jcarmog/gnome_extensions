// Gemini CLI ("Login with Google"): per-model quota from the Code Assist API
// and token totals from local chat recordings (~/.gemini/tmp/*/chats).
//
// The CLI's credentials file is only read. When its access token has expired,
// a fresh one is obtained with the stored refresh token and kept in memory;
// the file is never rewritten.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal';
const PROJECT_TTL = 3600 * 1000;

export class GeminiCliError extends Error {
    constructor(message, kind = 'error') {
        super(message);
        this.kind = kind;
    }
}

// Chat recordings are JSONL: a metadata line, then MessageRecords that are
// re-appended whenever they change (keep the last per id). Legacy .json files
// hold a single ConversationRecord with a messages array.
export function parseGeminiChat(text, path) {
    let messages = [];
    const trimmed = text.trimStart();
    if (path.endsWith('.json') && trimmed.startsWith('{')) {
        try {
            messages = JSON.parse(trimmed).messages ?? [];
        } catch {
            return [];
        }
    } else {
        for (const line of text.split('\n')) {
            if (!line.includes('"tokens"'))
                continue;
            try {
                messages.push(JSON.parse(line));
            } catch {}
        }
    }

    const byId = new Map();
    for (const m of messages) {
        if (m?.type === 'gemini' && m.tokens && m.id)
            byId.set(m.id, m);
    }
    const records = [];
    for (const m of byId.values()) {
        const ts = Date.parse(m.timestamp);
        if (Number.isNaN(ts))
            continue;
        const t = m.tokens;
        const cached = t.cached ?? 0;
        records.push({
            key: `${path}:${m.id}`,
            ts,
            model: m.model ?? 'gemini',
            // promptTokenCount includes cached tokens; split them out.
            input: Math.max(0, (t.input ?? 0) - cached) + (t.tool ?? 0),
            output: (t.output ?? 0) + (t.thoughts ?? 0),
            cacheWrite: 0,
            cacheRead: cached,
        });
    }
    return records;
}

export class GeminiCliClient {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 20, user_agent: 'ai-metrics-gnome-extension/1'});
        this._token = null; // {access, expires, refresh}
        this._project = null; // {id, tier, fetched}
    }

    // oauth: {clientId, clientSecret} of the Gemini CLI's "installed app" OAuth
    // client, only needed to refresh an expired access token.
    async fetchQuota(configDir, oauth = {}) {
        const token = await this._accessToken(configDir, oauth);
        if (!this._project || Date.now() - this._project.fetched > PROJECT_TTL)
            this._project = await this._loadProject(token);

        const res = await this._post('retrieveUserQuota', token, {project: this._project.id});
        const buckets = (res.buckets ?? []).filter(b => b.modelId && typeof b.remainingFraction === 'number');
        const dupes = new Set(buckets.map(b => b.modelId).filter((id, i, a) => a.indexOf(id) !== i));
        return {
            plan: this._project.tier,
            buckets: buckets
                .map(b => ({
                    label: dupes.has(b.modelId) && b.tokenType
                        ? `${b.modelId} (${b.tokenType.toLowerCase()})` : b.modelId,
                    percent: (1 - b.remainingFraction) * 100,
                    resetsAt: b.resetTime ?? null,
                }))
                .sort((a, b) => a.label.localeCompare(b.label)),
        };
    }

    async _accessToken(configDir, {clientId, clientSecret}) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([configDir, 'oauth_creds.json']));
        let creds;
        try {
            const [bytes] = await file.load_contents_async(this._cancellable);
            creds = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw new GeminiCliError('Gemini CLI not logged in (run `gemini` and choose “Login with Google”).', 'offline');
            throw e;
        }

        const soon = Date.now() + 60000;
        if (creds.access_token && (creds.expiry_date ?? 0) > soon)
            return creds.access_token;
        if (this._token && this._token.refresh === creds.refresh_token && this._token.expires > soon)
            return this._token.access;
        if (!creds.refresh_token)
            throw new GeminiCliError('Gemini CLI login has no refresh token. Log in again with `gemini`.', 'auth');
        if (!clientId || !clientSecret)
            throw new GeminiCliError('Gemini CLI token expired and no OAuth client is configured. Set it in Settings or via GEMINI_OAUTH_CLIENT_ID/GEMINI_OAUTH_CLIENT_SECRET, or run `gemini` to refresh the login.', 'auth');

        const msg = Soup.Message.new('POST', TOKEN_URL);
        const form = Object.entries({
            grant_type: 'refresh_token',
            refresh_token: creds.refresh_token,
            client_id: clientId,
            client_secret: clientSecret,
        }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        msg.set_request_body_from_bytes('application/x-www-form-urlencoded',
            new GLib.Bytes(new TextEncoder().encode(form)));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.get_status() !== 200)
            throw new GeminiCliError('Gemini CLI login expired. Run `gemini` to log in again.', 'auth');
        const r = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        this._token = {access: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000, refresh: creds.refresh_token};
        return this._token.access;
    }

    async _loadProject(token) {
        const envProject = GLib.getenv('GOOGLE_CLOUD_PROJECT') || GLib.getenv('GOOGLE_CLOUD_PROJECT_ID') || undefined;
        const res = await this._post('loadCodeAssist', token, {
            cloudaicompanionProject: envProject,
            metadata: {ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', duetProject: envProject},
        });
        const id = res.cloudaicompanionProject ?? envProject;
        if (!res.currentTier || !id)
            throw new GeminiCliError('Gemini CLI account is not set up yet. Run `gemini` once.', 'offline');
        const tier = res.paidTier?.name ?? res.currentTier.name ?? null;
        return {id, tier, fetched: Date.now()};
    }

    async _post(method, token, body) {
        const msg = Soup.Message.new('POST', `${CODE_ASSIST}:${method}`);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        const status = msg.get_status();
        if (status === 401 || status === 403) {
            this._token = null;
            throw new GeminiCliError('Gemini CLI login rejected. Run `gemini` to log in again.', 'auth');
        }
        if (status !== 200)
            throw new GeminiCliError(`Gemini API ${method} returned HTTP ${status}.`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
    }
}
