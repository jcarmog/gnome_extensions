# AI Metrics — GNOME Shell extension

A top-bar indicator for your Claude and Gemini plan usage (GNOME Shell 45–49).

**What it shows**

- **Plan limits**: current session (5h) and weekly usage (plus per-model weekly limits and
  extra usage credits when your plan has them), with progress bars and reset countdowns.
  This is the same data as `/usage` in Claude Code.
- **Local token totals** from Claude Code transcripts (`~/.claude/projects/**/*.jsonl`):
  current session window, today, this week and all time, broken down into input / output /
  cache write / cache read, plus a per-model breakdown for the week.
- **Gemini**:
  - *Antigravity IDE*: shared quota pools (e.g. Gemini models, Claude/GPT-OSS models) with
    % used and reset time, plus the per-model list. Only available while Antigravity runs.
  - *Gemini CLI*: per-model quota buckets for your "Login with Google" account, and local
    token totals (today / 7 days / all time) from `~/.gemini/tmp/*/chats`.
  - Top bar can append the highest Gemini usage, e.g. `14% · G 3%`.
- Panel text: session %, weekly %, both, tokens today, or icon only. Turns yellow/red at
  configurable thresholds, with optional desktop notifications.

## How it gets the data

- Limits: reads the OAuth token Claude Code stores in `~/.claude/.credentials.json`
  and calls `GET https://api.anthropic.com/api/oauth/usage`. The token is only ever sent to
  that endpoint. The extension never refreshes or rewrites the token; if it expires, run any
  `claude` command and the next refresh will pick up the new one.
- Tokens: parses transcripts locally. Files are cached by size and mtime, so only files
  that changed are read again. Totals cover Claude Code on this machine only, not claude.ai
  chat or other devices.

- Antigravity: finds its `language_server` process in `/proc`, reads the CSRF token from its
  command line and calls `GetUserStatus` on its loopback port. Nothing leaves the machine.
- Gemini CLI: reads `~/.gemini/oauth_creds.json` (never writes it). When the access token
  has expired it gets a new one with the stored refresh token (kept in memory only), then
  calls `loadCodeAssist` and `retrieveUserQuota` on `cloudcode-pa.googleapis.com`.
  Refreshing needs the Gemini CLI's OAuth client ID/secret, which are not shipped with the
  extension: set them in Settings, or export `GEMINI_OAUTH_CLIENT_ID` and
  `GEMINI_OAUTH_CLIENT_SECRET` in your session environment (e.g. a file in
  `~/.config/environment.d/`, then log out and back in). Without them, the extension only
  works while the CLI's own access token is still valid.
  Encrypted/keychain credential storage (`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`) is
  not supported. Set `GOOGLE_CLOUD_PROJECT` in your session environment if your account
  needs it.

All of these endpoints are undocumented and may change. For Claude, the extension also
understands the older `five_hour`/`seven_day` response fields.

## Install

```bash
./install.sh            # symlinks into ~/.local/share/gnome-shell/extensions and compiles the schema
# log out and back in (Wayland), then:
gnome-extensions enable ai-metrics@josecarmo
```

`./install.sh --pack` also builds a `.shell-extension.zip`.

Settings: `gnome-extensions prefs ai-metrics@josecarmo`, or "Settings" in the menu.
Set a custom config directory if you use `CLAUDE_CONFIG_DIR`.

## Debugging

```bash
journalctl -f -o cat /usr/bin/gnome-shell     # extension log output
dbus-run-session -- gnome-shell --nested --wayland   # test without logging out
```
