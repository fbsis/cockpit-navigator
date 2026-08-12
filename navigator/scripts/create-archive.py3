#!/usr/bin/env python3

"""Create ZIP or tar.gz archives without following unsafe output paths."""

import os
from pathlib import Path
import sys
import tarfile
import zipfile


def main():
    if len(sys.argv) < 5:
        print("Usage: create-archive.py3 zip|tar.gz ROOT OUTPUT SOURCE...", file=sys.stderr)
        return 2
    archive_type, root, output, *sources = sys.argv[1:]
    root = os.path.realpath(root)
    output = os.path.abspath(output)
    if archive_type not in ("zip", "tar.gz"):
        print("Unsupported archive format.", file=sys.stderr)
        return 2
    if os.path.lexists(output):
        print("Destination archive already exists.", file=sys.stderr)
        return 1
    sources = [os.path.realpath(source) for source in sources]
    for source in sources:
        if not os.path.lexists(source):
            print(f"Source no longer exists: {source}", file=sys.stderr)
            return 1
    try:
        if archive_type == "zip":
            with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                for source in sources:
                    source_path = Path(source)
                    if source_path.is_dir() and not source_path.is_symlink():
                        for parent, directories, files in os.walk(source, followlinks=False):
                            relative_parent = Path(os.path.relpath(parent, root))
                            if not directories and not files:
                                archive.writestr(str(relative_parent).rstrip("/") + "/", "")
                            for name in files:
                                path = Path(parent) / name
                                archive.write(path, os.path.relpath(path, root))
                    else:
                        archive.write(source_path, os.path.relpath(source_path, root))
        else:
            with tarfile.open(output, "x:gz") as archive:
                for source in sources:
                    archive.add(source, arcname=os.path.relpath(source, root), recursive=True)
    except Exception:
        try:
            os.unlink(output)
        except FileNotFoundError:
            pass
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
