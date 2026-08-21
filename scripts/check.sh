#!/usr/bin/env bash
#
# Verify the extension without running a compositor.
#
# Testing a Shell extension by launching a nested gnome-shell is not safe on a
# normal desktop: even --headless it claims the DRM devices, starts its own
# Xwayland, and registers with GDM, which can take the real session down. These
# checks catch the failures that actually happen -- syntax errors, calls to
# methods that do not exist, a schema that will not compile -- from static
# analysis alone.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
fails=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; fails=$((fails + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "JavaScript syntax"
if command -v node >/dev/null; then
  for file in extension.js prefs.js collector.js; do
    tmp=$(mktemp --suffix=.mjs)
    cp "$EXT/$file" "$tmp"
    if err=$(node --check "$tmp" 2>&1); then ok "$file parses"; else bad "$file: $err"; fi
    rm -f "$tmp"
  done
else
  bad "node not found; cannot syntax-check the JavaScript"
fi

head_ "Method references"
python3 - "$EXT/extension.js" "$EXT/prefs.js" <<'PY'
import re, sys

status = 0
for path in sys.argv[1:]:
    source = open(path, encoding="utf-8").read()
    # Class methods are declared at four-space indent; that is the whole
    # convention in this file, so it is enough to find them.
    defined = set(re.findall(r"^    (?:async )?([A-Za-z_]\w*)\s*\(", source, re.M))
    defined |= set(re.findall(r"^    (?:get|set) ([A-Za-z_]\w*)", source, re.M))
    # Only our own underscore-prefixed calls are checked: anything else may be
    # inherited from St, Clutter, or PanelMenu.Button.
    used = set(re.findall(r"this\.(_[A-Za-z]\w*)\s*\(", source))
    missing = sorted(used - defined)
    name = path.split("/")[-1]
    if missing:
        for method in missing:
            print(f"  \033[31m✗\033[0m {name}: this.{method}() is called but never defined")
        status = 1
    else:
        print(f"  \033[32m✓\033[0m {name}: all {len(used)} internal method calls resolve")
sys.exit(status)
PY
[ $? -ne 0 ] && fails=$((fails + 1))

head_ "Settings keys"
python3 - "$EXT" <<'PY'
import re, sys, xml.etree.ElementTree as ET
from pathlib import Path

ext = Path(sys.argv[1])
schema = next(ext.glob("schemas/*.gschema.xml"))
keys = {k.get("name") for k in ET.parse(schema).getroot().iter("key")}
used = set()
for name in ("extension.js", "prefs.js"):
    text = (ext / name).read_text(encoding="utf-8")
    used |= set(re.findall(r"get_(?:boolean|int|string|strv)\(['\"]([\w-]+)['\"]", text))
    used |= set(re.findall(r"set_(?:boolean|int|string|strv)\(['\"]([\w-]+)['\"]", text))
    used |= set(re.findall(r"changed::([\w-]+)", text))
    used |= set(re.findall(r"settings\.bind\(['\"]([\w-]+)['\"]", text))
    used |= set(re.findall(r"addKeybinding\(\s*['\"]([\w-]+)['\"]", text))
    used |= set(re.findall(r"removeKeybinding\(['\"]([\w-]+)['\"]", text))

unknown = sorted(used - keys)
if unknown:
    for key in unknown:
        print(f"  \033[31m✗\033[0m '{key}' is used in code but missing from the schema")
    sys.exit(1)
print(f"  \033[32m✓\033[0m all {len(used)} settings keys exist in the schema")
PY
[ $? -ne 0 ] && fails=$((fails + 1))

head_ "Schema compiles"
if out=$(glib-compile-schemas --strict --dry-run "$EXT/schemas" 2>&1); then
  ok "gschema is valid"
else
  bad "gschema: $out"
fi

head_ "Metadata"
python3 - "$EXT/metadata.json" <<'PY'
import json, sys
from pathlib import Path
meta = json.loads(Path(sys.argv[1]).read_text())
problems = []
for field in ("uuid", "name", "description", "shell-version"):
    if not meta.get(field):
        problems.append(f"missing '{field}'")
if "@" not in meta.get("uuid", ""):
    problems.append("uuid must contain '@'")
if problems:
    for p in problems:
        print(f"  \033[31m✗\033[0m metadata.json: {p}")
    sys.exit(1)
print(f"  \033[32m✓\033[0m metadata.json valid, uuid {meta['uuid']}, shell {meta['shell-version']}")
PY
[ $? -ne 0 ] && fails=$((fails + 1))

head_ "Collector"
tmp=$(mktemp --suffix=.mjs); cp "$EXT/collector.js" "$tmp"
if err=$(node --check "$tmp" 2>&1); then ok "collector.js parses"; else bad "collector.js: $err"; fi
rm -f "$tmp"

if record=$(gjs -m "$EXT/collector.js" --force --print 2>/dev/null); then
  echo "$record" | python3 -c "
import json,sys
snap = json.load(sys.stdin)
for pid, p in snap['providers'].items():
    mark = '\033[32m✓\033[0m' if p['status'] == 'ok' else '\033[33m!\033[0m'
    print(f\"  {mark} {pid}: {p['status']}, {len(p['limits'])} limit(s)\")
" || bad "collector printed unusable JSON"
else
  bad "collector failed to run"
fi

head_ "Result"
if [ "$fails" -eq 0 ]; then
  printf '  \033[32mAll checks passed.\033[0m A Shell restart (log out and back in) is\n'
  printf '  still required for GNOME to re-import a changed extension module.\n\n'
else
  printf '  \033[31m%d check(s) failed.\033[0m Do not restart the Shell yet.\n\n' "$fails"
  exit 1
fi
