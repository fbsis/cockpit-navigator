#!/usr/bin/env python3

"""
Cockpit Navigator - A File System Browser for Cockpit.
Copyright (C) 2021 Josh Boudreau <jboudreau@45drives.com>

This file is part of Cockpit Navigator and is distributed under the terms of
the GNU General Public License, version 3 or later.

Atomically write a file from newline-delimited base64 chunks.
"""

import base64
import json
import os
import signal
import sys
import tempfile
import time


temporary_path = None
file_descriptor = None


def emit(event, **values):
    print(json.dumps({"event": event, **values}), flush=True)


def cleanup():
    global file_descriptor, temporary_path
    if file_descriptor is not None:
        try:
            os.close(file_descriptor)
        except OSError:
            pass
        file_descriptor = None
    if temporary_path:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        temporary_path = None


def terminate(_signum, _frame):
    cleanup()
    sys.exit(130)


def create_parent(path):
    parent = os.path.dirname(path)
    if os.path.exists(parent) and not os.path.isdir(parent):
        raise NotADirectoryError(f"{parent}: exists and is not a directory")
    os.makedirs(parent, exist_ok=True)
    return parent


def write_all(fd, data):
    written = 0
    while written < len(data):
        written += os.write(fd, data[written:])


def main():
    global file_descriptor, temporary_path
    if len(sys.argv) != 4 or sys.argv[3] not in ("replace", "no-replace"):
        emit("error", message="Usage: write-chunks.py3 DESTINATION EXPECTED_SIZE replace|no-replace")
        return 2

    destination = os.path.abspath(sys.argv[1])
    expected_size = int(sys.argv[2])
    replace_existing = sys.argv[3] == "replace"
    if expected_size < 0:
        raise ValueError("Expected size cannot be negative")
    parent = create_parent(destination)
    existing = None
    if os.path.lexists(destination):
        if not replace_existing:
            raise FileExistsError(f"{destination}: already exists")
        if os.path.isdir(destination) and not os.path.islink(destination):
            raise IsADirectoryError(f"{destination}: is a directory")
        existing = os.stat(destination, follow_symlinks=False)

    file_descriptor, temporary_path = tempfile.mkstemp(prefix=".navigator-upload-", dir=parent)
    if existing:
        os.fchmod(file_descriptor, existing.st_mode & 0o7777)
        try:
            os.fchown(file_descriptor, existing.st_uid, existing.st_gid)
        except PermissionError:
            pass
    emit("started", path=destination)

    received = 0
    last_progress = 0.0
    for raw_line in sys.stdin:
        if not raw_line.strip():
            continue
        chunk = json.loads(raw_line)
        offset = int(chunk["seek"])
        data = base64.b64decode(chunk["chunk"], validate=True)
        if offset != received:
            raise ValueError(f"Unexpected chunk offset {offset}; expected {received}")
        write_all(file_descriptor, data)
        received += len(data)
        now = time.monotonic()
        if now - last_progress >= 0.1 or received == expected_size:
            emit("progress", path=destination, bytes=received)
            last_progress = now

    if received != expected_size:
        raise ValueError(f"Incomplete upload: received {received} of {expected_size} bytes")
    os.fsync(file_descriptor)
    os.close(file_descriptor)
    file_descriptor = None
    if replace_existing:
        os.replace(temporary_path, destination)
    else:
        os.link(temporary_path, destination)
        os.unlink(temporary_path)
    temporary_path = None
    emit("completed", path=destination, bytes=received)
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        sys.exit(main())
    except Exception as error:
        cleanup()
        emit("error", message=str(error))
        sys.exit(1)
