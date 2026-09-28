// Reads the Claude Code OAuth login and queries the plan usage endpoint
// (the same data Claude Code's /usage command shows).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export class UsageError extends Error {
    constructor(message, kind = 'error') {
        super(message);
        this.kind = kind;
    }
}

export class UsageClient {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({
            timeout: 20,
            user_agent: 'ai-metrics-gnome-extension/1',
        });
    }

    async readCredentials(configDir) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([configDir, '.credentials.json']));
        let bytes;
        try {
            [bytes] = await file.load_contents_async(this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw new UsageError('Not logged in to Claude Code. Run `claude` and log in.', 'auth');
            throw e;
        }
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return data.claudeAiOauth ?? null;
    }

    async fetchUsage(configDir) {
        const creds = await this.readCredentials(configDir);
        if (!creds?.accessToken)
            throw new UsageError('No Claude subscription login found. Run `claude` and log in.', 'auth');
        // The extension never refreshes or writes the token itself (that would race with
        // Claude Code); running any Claude Code command refreshes it.
        if (creds.expiresAt && creds.expiresAt < Date.now())
            throw new UsageError('Login token expired. Run any `claude` command to refresh it.', 'expired');

        const msg = Soup.Message.new('GET', USAGE_URL);
        msg.request_headers.append('Authorization', `Bearer ${creds.accessToken}`);
        msg.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
        msg.request_headers.append('Accept', 'application/json');

        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        const status = msg.get_status();
        const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());

        if (status === 401 || status === 403)
            throw new UsageError('Login rejected. Run `claude` to log in again.', 'auth');
        if (status === 429)
            throw new UsageError('Rate limited by the usage API, will retry.', 'rate');
        if (status !== 200)
            throw new UsageError(`Usage API returned HTTP ${status}.`);

        return {
            usage: JSON.parse(text),
            subscription: creds.subscriptionType ?? null,
            tier: creds.rateLimitTier ?? null,
        };
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
    }
}
