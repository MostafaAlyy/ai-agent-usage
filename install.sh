#!/usr/bin/env bash
#
# Install the AI Agent Usage GNOME extension (which bundles its collector)
# into this user's home. Nothing outside $HOME is touched, no system files
# are modified, and nothing here needs root.
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="ai-agent-usage@mostafaalyy.github.io"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

EXTENSION_DIR="$DATA_HOME/gnome-shell/extensions/$UUID"
UNIT_DIR="$CONFIG_HOME/systemd/user"

info() { printf '\033[1;34m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------ requirements

command -v gjs >/dev/null || fail "gjs is required (it ships with GNOME)."
command -v glib-compile-schemas >/dev/null || fail "glib-compile-schemas is required (dnf install glib2-devel)."

if ! command -v gnome-shell >/dev/null; then
  warn "gnome-shell was not found; installing the files anyway."
else
  info "GNOME Shell $(gnome-shell --version | awk '{print $3}') detected."
fi

# --------------------------------------------------------------- extension

# The extension shipped briefly as ai-agent-usage@local. Leaving that copy in
# place would load a second, identical indicator into the panel.
LEGACY_UUID="ai-agent-usage@local"
LEGACY_DIR="$DATA_HOME/gnome-shell/extensions/$LEGACY_UUID"
if [ -d "$LEGACY_DIR" ]; then
  info "Removing the previous $LEGACY_UUID install"
  rm -rf "$LEGACY_DIR"
  python3 - "$LEGACY_UUID" "$UUID" <<'PYMIGRATE'
import ast, subprocess, sys
legacy, current = sys.argv[1], sys.argv[2]
raw = subprocess.run(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'],
                     capture_output=True, text=True).stdout.strip()
try:
    items = ast.literal_eval(raw.replace('@as ', ''))
except (ValueError, SyntaxError):
    sys.exit(0)
updated = [i for i in items if i != legacy]
if current not in updated:
    updated.append(current)
if updated != items:
    value = '[' + ', '.join("'%s'" % i for i in updated) + ']'
    subprocess.run(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', value])
    print('  migrated enabled-extensions to %s' % current)
PYMIGRATE
fi

info "Installing the extension into $EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR/schemas" "$EXTENSION_DIR/icons" "$STATE_HOME/agent-usage"
install -m 0644 "$SOURCE_DIR/extension/metadata.json" "$EXTENSION_DIR/"
install -m 0644 "$SOURCE_DIR/extension/extension.js" "$EXTENSION_DIR/"
install -m 0644 "$SOURCE_DIR/extension/prefs.js" "$EXTENSION_DIR/"
install -m 0644 "$SOURCE_DIR/extension/stylesheet.css" "$EXTENSION_DIR/"
install -m 0644 "$SOURCE_DIR/extension/collector.js" "$EXTENSION_DIR/"
install -m 0644 "$SOURCE_DIR/extension/icons/"*.svg "$EXTENSION_DIR/icons/"
install -m 0644 "$SOURCE_DIR/extension/schemas/"*.gschema.xml "$EXTENSION_DIR/schemas/"
glib-compile-schemas "$EXTENSION_DIR/schemas"

# ------------------------------------------------------------------ timer

info "Installing the user timer into $UNIT_DIR"
mkdir -p "$UNIT_DIR"
install -m 0644 "$SOURCE_DIR/systemd/agent-usage.service" "$UNIT_DIR/"
install -m 0644 "$SOURCE_DIR/systemd/agent-usage.timer" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now agent-usage.timer
info "Timer enabled: $(systemctl --user show -p NextElapseUSecRealtime --value agent-usage.timer)"

# ------------------------------------------------------------- first fetch

info "Running the collector once"
if gjs -m "$EXTENSION_DIR/collector.js" --force; then
  info "Snapshot written to $STATE_HOME/agent-usage/usage.json"
else
  warn "The first collection reported an error. The extension will still load."
fi

# ------------------------------------------------------------------ enable

if command -v gnome-extensions >/dev/null; then
  # A Shell that has not rescanned its extension directory refuses to enable
  # an extension it has not seen yet; under Wayland that needs a new session.
  if gnome-extensions enable "$UUID" 2>/dev/null; then
    info "Extension enabled."
  else
    warn "Could not enable the extension yet -- GNOME Shell has not picked it up."
    warn "Log out and back in, then run: gnome-extensions enable $UUID"
  fi
fi

cat <<EOF

Installed.

  collector   $EXTENSION_DIR/collector.js
  snapshot    $STATE_HOME/agent-usage/usage.json
  extension   $EXTENSION_DIR
  timer       $UNIT_DIR/agent-usage.timer

Next steps
  * On Wayland, GNOME Shell cannot reload extensions in place. If the icon is
    not in the top bar yet, log out and back in.
  * Preferences:  gnome-extensions prefs $UUID
  * Manual run:   gjs -m $EXTENSION_DIR/collector.js --force --print
  * Logs:         journalctl --user -f -o cat /usr/bin/gnome-shell
                  journalctl --user -u agent-usage.service

EOF
