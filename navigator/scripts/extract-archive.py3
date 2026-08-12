#!/usr/bin/env python3

"""Safely extract ZIP and TAR-family archives into an existing directory."""

import os
from pathlib import Path
import sys
import tarfile
import zipfile


def safe_target(destination, member):
    target = os.path.realpath(os.path.join(destination, member))
    return os.path.commonpath([destination, target]) == destination


def main():
    if len(sys.argv) != 3:
        print("Usage: extract-archive.py3 ARCHIVE DESTINATION", file=sys.stderr)
        return 2
    archive_path = os.path.realpath(sys.argv[1])
    destination = os.path.realpath(sys.argv[2])
    if not os.path.isdir(destination):
        print("Extraction destination is not a directory.", file=sys.stderr)
        return 1
    try:
        if zipfile.is_zipfile(archive_path):
            with zipfile.ZipFile(archive_path) as archive:
                for member in archive.infolist():
                    if not safe_target(destination, member.filename):
                        raise ValueError(f"Unsafe archive path: {member.filename}")
                archive.extractall(destination)
        elif tarfile.is_tarfile(archive_path):
            with tarfile.open(archive_path, "r:*") as archive:
                members = archive.getmembers()
                for member in members:
                    if not safe_target(destination, member.name):
                        raise ValueError(f"Unsafe archive path: {member.name}")
                    if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                        raise ValueError(f"Unsupported special archive entry: {member.name}")
                archive.extractall(destination, members=members)
        else:
            print("Unsupported or invalid archive.", file=sys.stderr)
            return 1
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
