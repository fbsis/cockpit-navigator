#!/usr/bin/env python3

"""Emit incremental apparent sizes for directories, bounded by a hard deadline."""

import concurrent.futures
import json
import os
import sys
import threading
import time


DEADLINE_SECONDS = 10.0
MAX_WORKERS = 4
print_lock = threading.Lock()
stop_event = threading.Event()


def emit(payload):
    with print_lock:
        print(json.dumps(payload), flush=True)


def calculate(path, deadline):
    total = 0
    last_emit = 0.0
    stack = [path]
    try:
        while stack and not stop_event.is_set():
            now = time.monotonic()
            if now >= deadline:
                emit({"event": "timeout", "path": path, "bytes": total})
                return
            current = stack.pop()
            try:
                stats = os.lstat(current)
                total += stats.st_size
                if os.path.isdir(current) and not os.path.islink(current):
                    with os.scandir(current) as entries:
                        stack.extend(entry.path for entry in entries)
            except OSError:
                continue
            if now - last_emit >= 0.1:
                emit({"event": "progress", "path": path, "bytes": total})
                last_emit = now
        if stop_event.is_set() or time.monotonic() >= deadline:
            emit({"event": "timeout", "path": path, "bytes": total})
        else:
            emit({"event": "complete", "path": path, "bytes": total})
    except Exception as error:
        emit({"event": "error", "path": path, "message": str(error), "bytes": total})


def main():
    paths = list(dict.fromkeys(sys.argv[1:]))
    if not paths:
        return 0
    deadline = time.monotonic() + DEADLINE_SECONDS
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(paths))) as executor:
        futures = [executor.submit(calculate, path, deadline) for path in paths]
        concurrent.futures.wait(futures, timeout=DEADLINE_SECONDS + 0.5)
        stop_event.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
