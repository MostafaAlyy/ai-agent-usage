# AI Agent Usage

A GNOME Shell top-bar indicator showing OpenAI Codex and Claude Code usage
limits, built for Fedora + GNOME + Wayland.

```
🤖                              ← top bar (optionally "🤖 87%")

AI Agents
──────────────────────────────
Codex                     Pro
Weekly limit             87%
██████████████████░░░
Resets in 5d 12h · Thu 08:51
...
──────────────────────────────
Last updated: 20:19    ↻ Refresh  ⚙
```

## Architecture

```
  systemd user timer ──┐
  extension timer ─────┼──> gjs -m collector.js   (its own process)
  extension Refresh ───┘         │  Codex via JSON-RPC over stdio,
  Super+Shift+U ─────────────────┘  Claude via one HTTPS request
                                     │
                    ~/.local/state/agent-usage/usage.json
                                     │  watched by Gio.FileMonitor
                                     ▼
                        GNOME Shell extension (render only)
```

The collector ships inside the extension and runs as a separate `gjs` process,
so the extension is self-contained but the Shell still never does the gathering
itself.

The Shell never talks to a provider. It reads a cached JSON snapshot and
spawns the collector asynchronously, so no network or CLI call can ever stall
the compositor.

## Where the numbers come from

| Provider | Mechanism | Documented? |
|---|---|---|
| Codex | `codex -s read-only -a untrusted app-server`, JSON-RPC `account/read` + `account/rateLimits/read` | No — see `NOTICE.md` |
| Claude Code | `GET https://api.anthropic.com/api/oauth/usage` with the access token from `~/.claude/.credentials.json` | No — see `NOTICE.md` |

Both undocumented mechanisms are isolated in a single function per provider
(`collectCodex` and `probeClaudeUsage` in `extension/collector.js`) so they can
be replaced without touching anything else.

## Security

* Only the Claude access token is read; the refresh token is never touched, so
  this project cannot mint or rotate a credential.
* The token is sent to exactly one place: the `Authorization` header of the
  request to `api.anthropic.com`.
* Nothing is logged, cached, or written into the snapshot except percentages,
  reset times, and a plan label.
* Codex needs no credential at all — the CLI is already authenticated and the
  RPC never hands one back.
* An expired sign-in is reported as a status, never worked around. Running
  Claude Code refreshes it.

## Install

```bash
./install.sh          # collector + extension + user timer, all under $HOME
./uninstall.sh        # removes everything it created
```

Nothing outside `$HOME` is touched: no system files, no SELinux changes, no
root, no Arch tooling.

## Adding a provider

Add an entry to `PROVIDERS` in `extension/collector.js` returning one record:

```json
{"schemaVersion":1,"id":"gemini","name":"Gemini","available":true,
 "status":"ok","plan":"Pro","message":"",
 "limits":[{"key":"session","label":"5-hour limit","percent":31.0,
            "resetsAt":"2026-08-21T20:00:00+00:00","group":"primary"}],
 "balance":null,"updatedAt":"2026-08-21T19:30:00+03:00"}
```

`status` is one of `ok`, `not_configured`, `auth`, `error`. `group` is
`primary` for account-wide windows or `scoped` for per-model allowances.
Nothing else needs to change — the extension renders whatever it finds.

## Debugging

```bash
# Collector, by hand
gjs -m ~/.local/share/gnome-shell/extensions/ai-agent-usage@mostafaalyy.github.io/collector.js --force --print

# Timer
systemctl --user status agent-usage.timer
journalctl --user -u agent-usage.service -f

# Extension
journalctl --user -f -o cat /usr/bin/gnome-shell | grep ai-agent-usage
gnome-extensions info ai-agent-usage@mostafaalyy.github.io
```

## Testing

```bash
./scripts/check.sh
```

Static checks only: JavaScript syntax, every `this._method()` call resolving to
a real definition, every settings key existing in the schema, the schema
compiling, metadata validity, and a live collector run.

**Do not test by launching a nested `gnome-shell`.** Even with `--headless` it
claims the DRM devices, starts its own Xwayland, and registers with GDM, which
can black-screen or log out the real session. The checks above catch the
failure modes that actually occur; the rest needs a real login.

GNOME Shell caches extension modules, so `disable`/`enable` re-runs the *old*
code after an edit. Picking up a changed `extension.js` needs a Shell restart —
under Wayland, a log out and back in.

## Known limitations

* Both provider mechanisms are undocumented and can break without notice.
* `codex app-server` writes inside `$HOME` while it runs, so the systemd unit
  cannot set `ProtectHome=`.
* Fireworks is not included.
* Under Wayland, GNOME Shell cannot load a newly installed extension without a
  new session; log out and back in after the first install.

See `NOTICE.md` for attribution.
