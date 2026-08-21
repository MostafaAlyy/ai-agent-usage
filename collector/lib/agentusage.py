"""Shared helpers for agent-usage provider collectors.

Every provider prints exactly one JSON record on stdout. This module holds
the record schema, the small amount of formatting the schema needs, and the
atomic-write / cache plumbing the orchestrator reuses.

Security note: nothing in here logs, prints, or persists a credential. The
providers read tokens straight from the official client's own store and put
them in exactly one place -- the Authorization header of that provider's own
endpoint.
"""

import datetime as dt
import json
import os
import sys
import tempfile
from pathlib import Path

SCHEMA_VERSION = 1

STATUS_OK = "ok"
STATUS_NOT_CONFIGURED = "not_configured"
STATUS_AUTH = "auth"
STATUS_ERROR = "error"


def state_dir() -> Path:
    root = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(root) / "agent-usage"


def cache_dir() -> Path:
    root = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(root) / "agent-usage"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def log(message: str) -> None:
    """Diagnostics go to stderr so journald picks them up under the unit."""
    print(f"agent-usage: {message}", file=sys.stderr)


def write_json_atomic(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def iso_or_none(value) -> str | None:
    """Normalize a reset timestamp to a tz-aware ISO string, or None."""
    if value in (None, "", 0):
        return None
    if isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(float(value), dt.timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value)
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.isoformat()


def percent(value, scale_hint=None) -> float | None:
    """Coerce a utilization figure to 0..100.

    Providers disagree on whether utilization is a fraction or a percentage,
    and a single payload always speaks one convention. `scale_hint` is True
    when some value in the same payload exceeded 1, which settles it for the
    whole payload rather than guessing per field (0.0 and 1.0 are ambiguous
    on their own).
    """
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number < 0:
        return None
    if scale_hint is False:
        number *= 100.0
    return round(min(number, 999.0), 1)


def window_label(minutes) -> str:
    """A human window name from a duration in minutes."""
    try:
        mins = int(minutes or 0)
    except (TypeError, ValueError):
        mins = 0
    if mins == 10080:
        return "Weekly limit"
    if mins == 1440:
        return "Daily limit"
    if mins and mins % 60 == 0:
        return f"{mins // 60}-hour limit"
    if mins:
        return f"{mins}-minute limit"
    return "Limit"


def limit(key: str, label: str, pct, resets_at=None, group: str = "primary") -> dict | None:
    """One usage window, or None when there is no number worth showing.

    `pct` is already on a 0..100 scale -- callers settle the scale for their
    whole payload before calling, because a lone 0.0 or 1.0 cannot.
    """
    value = percent(pct)
    if value is None:
        return None
    return {
        "key": key,
        "label": label,
        "percent": value,
        "resetsAt": iso_or_none(resets_at),
        "group": group,
    }


def record(agent_id: str, name: str, **fields) -> dict:
    """The normalized per-provider record every collector prints."""
    base = {
        "schemaVersion": SCHEMA_VERSION,
        "id": agent_id,
        "name": name,
        "available": False,
        "status": STATUS_NOT_CONFIGURED,
        "plan": "",
        "message": "",
        "limits": [],
        "balance": None,
        "updatedAt": now_iso(),
    }
    base.update(fields)
    base["limits"] = [entry for entry in base["limits"] if entry]
    return base


def emit(payload: dict) -> None:
    json.dump(payload, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


def search_path() -> str:
    """PATH plus the install dirs a login shell would have added.

    A systemd user unit starts with a minimal PATH, so a CLI installed by npm,
    bun, or mise is invisible to it. This is also the PATH a located CLI must
    be *run* with: finding `codex` in /usr/local/bin is no use if the child
    process then cannot find the runtime it shells out to.
    """
    home = str(Path.home())
    extra = [
        f"{home}/.local/bin",
        f"{home}/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        f"{home}/.npm-global/bin",
        f"{home}/.bun/bin",
        f"{home}/.local/share/mise/shims",
        f"{home}/.local/share/fnm/aliases/default/bin",
    ]
    seen, parts = set(), []
    for part in os.environ.get("PATH", "").split(os.pathsep) + extra:
        if part and part not in seen:
            seen.add(part)
            parts.append(part)
    return os.pathsep.join(parts)


def runtime_env() -> dict:
    """The environment a provider CLI should be launched with."""
    env = os.environ.copy()
    env["PATH"] = search_path()
    return env


def which(name: str) -> str | None:
    """Locate a CLI, including the install dirs a login shell would add."""
    import shutil

    return shutil.which(name, path=search_path())
