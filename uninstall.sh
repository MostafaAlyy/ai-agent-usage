#!/usr/bin/env bash
# Remove everything install.sh created. Leaves no system state behind.
set -euo pipefail

UUID="ai-agent-usage@mostafaalyy.github.io"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

command -v gnome-extensions >/dev/null && gnome-extensions disable "$UUID" 2>/dev/null || true
systemctl --user disable --now agent-usage.timer 2>/dev/null || true
rm -f "$CONFIG_HOME/systemd/user/agent-usage.service" "$CONFIG_HOME/systemd/user/agent-usage.timer"
systemctl --user daemon-reload 2>/dev/null || true
rm -rf "$DATA_HOME/gnome-shell/extensions/$UUID" "$DATA_HOME/agent-usage" \
       "$STATE_HOME/agent-usage" "$CACHE_HOME/agent-usage"
echo "Removed. Settings remain in dconf; clear them with:"
echo "  dconf reset -f /org/gnome/shell/extensions/ai-agent-usage/"
