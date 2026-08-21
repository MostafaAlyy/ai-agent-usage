# Attribution

The two undocumented provider mechanisms this project relies on were
identified from **Omarchy** (https://github.com/basecamp/omarchy), which is
MIT licensed, Copyright (c) David Heinemeier Hansson:

* `codex -s read-only -a untrusted app-server` speaking JSON-RPC over stdio,
  with the `account/read` and `account/rateLimits/read` methods
  (`bin/omarchy-agent-usage-codex`).
* `GET https://api.anthropic.com/api/oauth/usage` authorized with the access
  token Claude Code stores in `~/.claude/.credentials.json`, sent with the
  `anthropic-beta: oauth-2025-04-20` header
  (`bin/omarchy-agent-usage-claude`).

Two algorithmic ideas were also reused: settling a payload's percentage scale
once for the whole payload rather than guessing per field, and discarding a
cached usage figure once its window has reset (a stale percentage describes a
period that is over).

No Omarchy source is copied. The collector, its normalized schema, the
orchestrator, the GNOME Shell extension, and the packaging here are all
independently written for Fedora + GNOME + Wayland, and this project has no
dependency on Omarchy, Hyprland, Quickshell, or Arch tooling.
