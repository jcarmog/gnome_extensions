// Reads model quotas from a running Antigravity IDE. Antigravity's local
// language server exposes GetUserStatus on a loopback port; the port and CSRF
// token are found through /proc. Nothing leaves the machine. This interface is
// undocumented, so every field is read defensively.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const STATUS_BODY = JSON.stringify({metadata: {ideName: 'antigravity', extensionName: 'antigravity', locale: 'en'}});

export class AntigravityError extends Error {
    constructor(message, kind = 'error') {
        super(message);
        this.kind = kind;
    }
}

async function listDir(path, attrs, cancellable) {
    const dir = Gio.File.new_for_path(path);
    const out = [];
    const en = await dir.enumerate_children_async(attrs, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        GLib.PRIORITY_LOW, cancellable);
    try {
        for (;;) {
            const infos = await en.next_files_async(200, GLib.PRIORITY_LOW, cancellable);
            if (infos.length === 0)
                break;
            out.push(...infos);
        }
    } finally {
        en.close(null);
    }
    return out;
}

async function readText(path, cancellable) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return new TextDecoder().decode(bytes);
}

// Pairs of [label, fraction, resetTime] grouped into the shared quota pools
// the server reports (models in one pool have identical fraction + reset).
function groupPools(configs) {
    const pools = new Map();
    for (const c of configs) {
        const q = c?.quotaInfo;
        if (!q || !c.label)
            continue;
        // proto3 JSON omits zero values, so a missing fraction means exhausted.
        const remaining = typeof q.remainingFraction === 'number' ? q.remainingFraction : 0;
        const key = `${remaining}|${q.resetTime ?? ''}`;
        let pool = pools.get(key);
        if (!pool) {
            pool = {remaining, resetsAt: q.resetTime ?? null, models: [], vendors: new Set()};
            pools.set(key, pool);
        }
        pool.models.push(c.label);
        pool.vendors.add(c.label.split(' ')[0]);
    }
    return [...pools.values()]
        .map(p => ({
            label: [...p.vendors].join(' / '),
            percent: (1 - p.remaining) * 100,
            resetsAt: p.resetsAt,
            models: p.models.sort(),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export class AntigravityClient {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 5});
        this._server = null; // {pid, port, token}
    }

    async fetchQuota() {
        if (this._server) {
            try {
                return await this._query(this._server);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
                this._server = null;
            }
        }
        const candidates = await this._findServers();
        if (candidates.length === 0)
            throw new AntigravityError('Antigravity is not running.', 'offline');
        for (const c of candidates) {
            for (const port of c.ports) {
                const server = {pid: c.pid, port, token: c.token};
                try {
                    const result = await this._query(server);
                    this._server = server;
                    return result;
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        throw e;
                }
            }
        }
        throw new AntigravityError('Could not reach the Antigravity language server.');
    }

    async _query({port, token}) {
        const msg = Soup.Message.new('POST', `http://127.0.0.1:${port}${STATUS_PATH}`);
        msg.request_headers.append('Connect-Protocol-Version', '1');
        msg.request_headers.append('X-Codeium-Csrf-Token', token);
        msg.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(STATUS_BODY)));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.get_status() !== 200)
            throw new AntigravityError(`HTTP ${msg.get_status()}`);
        const status = JSON.parse(new TextDecoder().decode(bytes.get_data()))?.userStatus;
        if (!status)
            throw new AntigravityError('Unexpected response');
        return {
            plan: status.userTier?.name ?? status.planStatus?.planInfo?.planName ?? null,
            pools: groupPools(status.cascadeModelConfigData?.clientModelConfigs ?? []),
        };
    }

    // Finds Antigravity language servers owned by this user, with the loopback
    // ports they listen on.
    async _findServers() {
        const procs = [];
        for (const info of await listDir('/proc', 'standard::name', this._cancellable)) {
            const pid = info.get_name();
            if (!/^\d+$/.test(pid))
                continue;
            let args;
            try {
                args = (await readText(`/proc/${pid}/cmdline`, this._cancellable)).split('\0');
            } catch {
                continue;
            }
            if (!/language_server/.test(args[0] ?? '') || !args.some(a => a.includes('antigravity')))
                continue;
            const i = args.indexOf('--csrf_token');
            if (i >= 0 && args[i + 1])
                procs.push({pid, token: args[i + 1]});
        }
        if (procs.length === 0)
            return [];

        const listening = new Map(); // socket inode -> port
        for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
            let text;
            try {
                text = await readText(table, this._cancellable);
            } catch {
                continue;
            }
            for (const line of text.split('\n').slice(1)) {
                const f = line.trim().split(/\s+/);
                if (f.length < 10 || f[3] !== '0A') // 0A = LISTEN
                    continue;
                const [addr, portHex] = f[1].split(':');
                if (addr !== '0100007F' && addr !== '00000000000000000000000001000000')
                    continue;
                listening.set(f[9], parseInt(portHex, 16));
            }
        }

        for (const p of procs) {
            p.ports = [];
            try {
                const fds = await listDir(`/proc/${p.pid}/fd`, 'standard::name,standard::symlink-target', this._cancellable);
                for (const fd of fds) {
                    const inode = /^socket:\[(\d+)\]$/.exec(fd.get_symlink_target() ?? '')?.[1];
                    if (inode && listening.has(inode))
                        p.ports.push(listening.get(inode));
                }
            } catch {}
        }
        return procs.filter(p => p.ports.length > 0);
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
    }
}
