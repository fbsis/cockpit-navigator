#!/usr/bin/env python3

"""Emit incremental apparent sizes for directories, bounded by a hard deadline."""

import concurrent.futures
import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time


DEFAULT_DEADLINE_SECONDS = 10.0
MAX_DEADLINE_SECONDS = 300.0
MAX_WORKERS = 4
print_lock = threading.Lock()
stop_event = threading.Event()
child_processes = set()
child_processes_lock = threading.Lock()


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


def calculate_with_du(path, deadline):
    process = None
    try:
        process = subprocess.Popen(
            ["du", "--summarize", "--block-size=1", "--apparent-size", "--", path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        with child_processes_lock:
            child_processes.add(process)
        while process.poll() is None and not stop_event.is_set():
            if time.monotonic() >= deadline:
                terminate_child(process)
                emit({"event": "timeout", "path": path, "bytes": 0})
                return
            time.sleep(0.1)
        if stop_event.is_set():
            terminate_child(process)
            return
        stdout, stderr = process.communicate()
        if process.returncode != 0:
            raise RuntimeError(stderr.strip() or f"du exited with status {process.returncode}")
        total = int(stdout.split(None, 1)[0])
        emit({"event": "complete", "path": path, "bytes": total})
    except Exception as error:
        emit({"event": "error", "path": path, "message": str(error), "bytes": 0})
    finally:
        if process is not None:
            with child_processes_lock:
                child_processes.discard(process)


def terminate_child(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=1)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def stop_all(*_args):
    stop_event.set()
    with child_processes_lock:
        processes = list(child_processes)
    for process in processes:
        terminate_child(process)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=float, default=DEFAULT_DEADLINE_SECONDS)
    parser.add_argument("--method", choices=("incremental", "du"), default="incremental")
    parser.add_argument("paths", nargs="*")
    arguments = parser.parse_args()
    timeout = min(MAX_DEADLINE_SECONDS, max(1.0, arguments.timeout))
    paths = list(dict.fromkeys(arguments.paths))
    if not paths:
        return 0
    deadline = time.monotonic() + timeout
    signal.signal(signal.SIGTERM, stop_all)
    signal.signal(signal.SIGINT, stop_all)
    calculator = calculate_with_du if arguments.method == "du" else calculate
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(paths))) as executor:
        futures = [executor.submit(calculator, path, deadline) for path in paths]
        concurrent.futures.wait(futures, timeout=timeout + 0.5)
        stop_event.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
