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
                       ├──> agent-usage (orchestrator)
  extension timer ─────┘         │  runs each provider concurrently,
  extension Refresh ─────────────┘  each in its own process with a timeout
                                     │
                            providers/codex, providers/claude
                                     │  one JSON record each
                                     ▼
                    ~/.local/state/agent-usage/usage.json
                                     │  watched by Gio.FileMonitor
                                     ▼
                        GNOME Shell extension (render only)
```

The Shell never talks to a provider. It reads a cached JSON snapshot and
spawns the collector asynchronously, so no network or CLI call can ever stall
the compositor.

## Where the numbers come from

| Provider | Mechanism | Documented? |
|---|---|---|
| Codex | `codex -s read-only -a untrusted app-server`, JSON-RPC `account/read` + `account/rateLimits/read` | No — see `NOTICE.md` |
| Claude Code | `GET https://api.anthropic.com/api/oauth/usage` with the access token from `~/.claude/.credentials.json` | No — see `NOTICE.md` |

Both undocumented mechanisms are isolated in a single function per provider
(`fetch_rate_limits` and `probe_usage`) so they can be replaced without
touching anything else.

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

Drop an executable in `collector/providers/` that prints one JSON record:

```json
{"schemaVersion":1,"id":"gemini","name":"Gemini","available":true,
 "status":"ok","plan":"Pro","message":"",
 "limits":[{"key":"session","label":"5-hour limit","percent":31.0,
            "resetsAt":"2026-08-21T20:00:00+00:00","group":"primary"}],
 "balance":null,"updatedAt":"2026-08-21T19:30:00+03:00"}
```

`status` is one of `ok`, `not_configured`, `auth`, `error`. `group` is
`primary` for account-wide windows or `scoped` for per-model allowances.
Nothing else needs to change — the orchestrator discovers providers by
listing the directory, and the extension renders whatever it finds.

## Debugging

```bash
# Collector, by hand
~/.local/share/agent-usage/agent-usage --force --print
~/.local/share/agent-usage/providers/codex | jq .

# Timer
systemctl --user status agent-usage.timer
journalctl --user -u agent-usage.service -f

# Extension
journalctl --user -f -o cat /usr/bin/gnome-shell | grep ai-agent-usage
gnome-extensions info ai-agent-usage@local
```

## Known limitations

* Both provider mechanisms are undocumented and can break without notice.
* `codex app-server` writes inside `$HOME` while it runs, so the systemd unit
  cannot set `ProtectHome=`.
* Fireworks is not included.
* Under Wayland, GNOME Shell cannot load a newly installed extension without a
  new session; log out and back in after the first install.

See `NOTICE.md` for attribution.
