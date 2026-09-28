// Aggregates token usage from local transcripts (Claude Code's
// <config>/projects/**/*.jsonl by default; other tools plug in their own
// parser). Parsed files are cached by size+mtime so only files that changed
// since the last scan are read again.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const ATTRS = 'standard::name,standard::type,standard::size,time::modified,time::modified-usec';
const MAX_DEPTH = 4;

function emptyTotals() {
    return {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0, models: {}};
}

function addRecord(t, r) {
    t.input += r.input;
    t.output += r.output;
    t.cacheWrite += r.cacheWrite;
    t.cacheRead += r.cacheRead;
    const sum = r.input + r.output + r.cacheWrite + r.cacheRead;
    t.total += sum;
    t.messages++;
    const m = (t.models[r.model] ??= {total: 0, input: 0, output: 0, messages: 0});
    m.total += sum;
    m.input += r.input + r.cacheWrite + r.cacheRead;
    m.output += r.output;
    m.messages++;
}

// Claude Code: one line per content block; assistant lines carry message.usage.
export function parseClaudeTranscript(text, path) {
    const records = [];
    let lineNo = 0;
    for (const line of text.split('\n')) {
        lineNo++;
        if (!line.includes('"usage"'))
            continue;
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        const msg = d?.message;
        const u = msg?.usage;
        if (d.type !== 'assistant' || !u || !msg.model || msg.model === '<synthetic>')
            continue;
        const ts = Date.parse(d.timestamp);
        if (Number.isNaN(ts))
            continue;
        records.push({
            key: msg.id ? `${msg.id}:${d.requestId ?? ''}` : `${path}:${lineNo}`,
            ts,
            model: msg.model,
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
        });
    }
    return records;
}

export class LocalStats {
    /**
     * @param {object} [options]
     * @param {function(string, string): object[]} [options.parse] transcript text, path -> records
     * @param {function(string, string): boolean} [options.accept] (name, path) filter
     */
    constructor({parse = parseClaudeTranscript, accept = name => name.endsWith('.jsonl')} = {}) {
        this._parseText = parse;
        this._accept = accept;
        this._cache = new Map(); // path -> {stamp, records}
        this._cancellable = new Gio.Cancellable();
        this._idleIds = new Set();
    }

    async scan(rootPath) {
        const root = Gio.File.new_for_path(rootPath);
        const files = [];
        await this._walk(root, files, 0);

        const present = new Set();
        for (const {file, stamp} of files) {
            const path = file.get_path();
            present.add(path);
            if (this._cache.get(path)?.stamp === stamp)
                continue;
            try {
                const [bytes] = await file.load_contents_async(this._cancellable);
                this._cache.set(path, {stamp, records: this._parseText(new TextDecoder().decode(bytes), path)});
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            }
            // Give the compositor a frame between files on a cold scan.
            await this._yield();
        }
        for (const path of [...this._cache.keys()]) {
            if (!present.has(path))
                this._cache.delete(path);
        }
        return files.length;
    }

    /**
     * @param {Object<string, number>} windows name -> start timestamp (ms)
     * @returns {Object<string, object>} name -> totals
     */
    summarize(windows) {
        // Claude Code writes one line per content block, all carrying the same
        // message id and usage; keep a single (the most complete) copy.
        const merged = new Map();
        for (const {records} of this._cache.values()) {
            for (const r of records) {
                const prev = merged.get(r.key);
                if (!prev || r.output >= prev.output)
                    merged.set(r.key, r);
            }
        }

        const result = {};
        for (const name of Object.keys(windows))
            result[name] = emptyTotals();
        for (const r of merged.values()) {
            for (const [name, since] of Object.entries(windows)) {
                if (r.ts >= since)
                    addRecord(result[name], r);
            }
        }
        return result;
    }

    async _walk(dir, out, depth) {
        let enumerator;
        try {
            enumerator = await dir.enumerate_children_async(ATTRS, Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW, this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            return;
        }
        try {
            for (;;) {
                const infos = await enumerator.next_files_async(200, GLib.PRIORITY_LOW, this._cancellable);
                if (infos.length === 0)
                    break;
                for (const info of infos) {
                    const name = info.get_name();
                    const child = dir.get_child(name);
                    const type = info.get_file_type();
                    if (type === Gio.FileType.DIRECTORY && depth < MAX_DEPTH) {
                        await this._walk(child, out, depth + 1);
                    } else if (type === Gio.FileType.REGULAR && this._accept(name, child.get_path())) {
                        const stamp = `${info.get_size()}:${info.get_attribute_uint64('time::modified')}` +
                            `.${info.get_attribute_uint32('time::modified-usec')}`;
                        out.push({file: child, stamp});
                    }
                }
            }
        } finally {
            enumerator.close(null);
        }
    }

    _yield() {
        return new Promise(resolve => {
            const id = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._idleIds.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._idleIds.add(id);
        });
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._idleIds)
            GLib.source_remove(id);
        this._idleIds.clear();
        this._cache.clear();
    }
}
