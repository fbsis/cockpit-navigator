#!/usr/bin/env python3

"""Read and atomically write Cockpit Navigator's per-user configuration."""

import json
import os
from pathlib import Path
import sys
import tempfile


def config_path():
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser()
    return config_home / "cockpit-navigator" / "config.json"


def read_config(path):
    if not path.exists():
        print("{}")
        return

    with path.open("r", encoding="utf-8") as config_file:
        config = json.load(config_file)
    if not isinstance(config, dict):
        raise ValueError("Navigator configuration must be a JSON object.")
    print(json.dumps(config))


def write_config(path):
    config = json.load(sys.stdin)
    if not isinstance(config, dict):
        raise ValueError("Navigator configuration must be a JSON object.")

    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix="config-",
        suffix=".tmp",
        text=True,
    )
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as temporary_file:
            json.dump(config, temporary_file, indent=2, sort_keys=True)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("read", "write"):
        print("Usage: config.py3 read|write", file=sys.stderr)
        return 2

    try:
        path = config_path()
        if sys.argv[1] == "read":
            read_config(path)
        else:
            write_config(path)
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
