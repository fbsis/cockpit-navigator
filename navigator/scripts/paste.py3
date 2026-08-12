#!/usr/bin/env python3

"""Copy or safely move Navigator selections with rsync and JSON-line progress."""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from optparse import OptionParser


PROGRESS_RE = re.compile(
    r"^\s*([\d,]+)\s+(\d+)%\s+([^\s]+)\s+([0-9:]+)(?:\s+\(xfr#\d+,.*\))?"
)


def emit(event, **values):
    print(json.dumps({"event": event, **values}), flush=True)


def receive():
    line = sys.stdin.readline()
    if not line:
        return {}
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return {}


def relative_path(path, root):
    return os.path.relpath(os.path.normpath(path), os.path.normpath(root))


def destination_path(source, root, destination):
    return os.path.normpath(os.path.join(destination, relative_path(source, root)))


def walk_sources(sources):
    nodes = []
    for source in sources:
        source = os.path.normpath(source)
        nodes.append(source)
        if os.path.isdir(source) and not os.path.islink(source):
            for parent, directories, files in os.walk(source, followlinks=False):
                for name in directories + files:
                    nodes.append(os.path.join(parent, name))
    return list(dict.fromkeys(nodes))


def remove_path(path):
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)


class Transfer:
    def __init__(self, source_root, sources, destination, move=False):
        self.source_root = os.path.normpath(source_root)
        self.sources = [os.path.normpath(path) for path in sources]
        self.destination = os.path.normpath(destination)
        self.move = move
        self.nodes = walk_sources(self.sources)
        self.existing = {
            destination_path(node, self.source_root, self.destination)
            for node in self.nodes
            if os.path.lexists(destination_path(node, self.source_root, self.destination))
        }
        self.conflicts = [
            (node, destination_path(node, self.source_root, self.destination))
            for node in self.nodes
            if not os.path.isdir(node) and destination_path(node, self.source_root, self.destination) in self.existing
        ]
        self.policy = "replace"
        self.cancel_requested = threading.Event()
        self.cleanup_requested = False
        self.child = None
        self.current_file = ""
        self.backup_dir = tempfile.mkdtemp(prefix="navigator-transfer-")

    def validate(self):
        if not self.sources:
            raise ValueError("No source files were provided.")
        if not os.path.isdir(self.destination):
            raise ValueError("Destination is not a directory.")
        for source in self.sources:
            if not os.path.lexists(source):
                raise ValueError("Source no longer exists: " + source)
            target = destination_path(source, self.source_root, self.destination)
            if os.path.normpath(source) == target:
                raise ValueError("Source and destination are the same: " + source)
            if os.path.isdir(source) and os.path.commonpath([source, target]) == source:
                raise ValueError("A directory cannot be copied inside itself: " + source)

    def ask_conflicts(self):
        if not self.conflicts:
            return True
        emit("conflicts", count=len(self.conflicts), samples=[target for _, target in self.conflicts[:5]])
        response = receive()
        self.policy = response.get("policy", "cancel")
        if self.policy == "cancel":
            emit("cancelled", cleanup=False)
            return False
        return True

    def listen_for_cancel(self):
        while not self.cancel_requested.is_set():
            response = receive()
            if not response:
                return
            if response.get("action") == "cancel":
                self.cleanup_requested = bool(response.get("cleanup"))
                self.cancel_requested.set()
                child = self.child
                if child and child.poll() is None:
                    child.terminate()
                return

    def rsync_args(self):
        sources = ["./" + relative_path(path, self.source_root) for path in self.sources]
        args = [
            "rsync", "-aI", "--relative", "--out-format=FILE:%n",
            "--backup", "--backup-dir=" + self.backup_dir,
        ]
        supports_progress2 = subprocess.run(
            ["rsync", "--info=progress2", "--version"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ).returncode == 0
        if supports_progress2:
            args.extend(["--no-inc-recursive", "--info=progress2"])
        else:
            args.append("--progress")
        if self.policy == "skip":
            args.append("--ignore-existing")
        return [*args, *sources, self.destination]

    def run_rsync(self):
        environment = os.environ.copy()
        environment["LC_ALL"] = "C"
        self.child = subprocess.Popen(
            self.rsync_args(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=0, env=environment, cwd=self.source_root,
        )
        listener = threading.Thread(target=self.listen_for_cancel, daemon=True)
        listener.start()
        pending = ""
        while True:
            character = self.child.stdout.read(1)
            if not character:
                if pending:
                    self.parse_output(pending)
                break
            if character in "\r\n":
                if pending:
                    self.parse_output(pending)
                    pending = ""
            else:
                pending += character
        return self.child.wait()

    def parse_output(self, line):
        if line.startswith("FILE:"):
            self.current_file = line[5:].strip()
            return
        match = PROGRESS_RE.match(line)
        if not match:
            return
        emit(
            "progress", file=self.current_file,
            bytes=int(match.group(1).replace(",", "")),
            percent=int(match.group(2)), speed=match.group(3), eta=match.group(4),
        )

    def rollback(self):
        failures = []
        new_destinations = sorted(
            (destination_path(node, self.source_root, self.destination) for node in self.nodes
             if destination_path(node, self.source_root, self.destination) not in self.existing),
            key=lambda path: path.count(os.sep), reverse=True,
        )
        for path in new_destinations:
            try:
                if os.path.lexists(path):
                    remove_path(path)
            except OSError as error:
                failures.append(f"{path}: {error}")
        try:
            subprocess.run(
                ["rsync", "-a", self.backup_dir.rstrip("/") + "/", self.destination.rstrip("/") + "/"],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
        except subprocess.CalledProcessError as error:
            failures.append(error.stderr.strip() or "Could not restore replaced files.")
        return failures

    def remove_sources(self):
        candidates = self.nodes
        if self.policy == "skip":
            candidates = [
                node for node in self.nodes
                if os.path.isdir(node) or destination_path(node, self.source_root, self.destination) not in self.existing
            ]
        failures = []
        for path in sorted(candidates, key=lambda item: item.count(os.sep), reverse=True):
            try:
                if os.path.islink(path) or os.path.isfile(path):
                    os.unlink(path)
                elif os.path.isdir(path):
                    os.rmdir(path)
            except OSError as error:
                if not (os.path.isdir(path) and error.errno in (39, 66)):
                    failures.append(f"{path}: {error}")
        return failures

    def execute(self):
        try:
            self.validate()
            if not self.ask_conflicts():
                return 0
            result = self.run_rsync()
            if self.cancel_requested.is_set():
                failures = self.rollback() if self.cleanup_requested else []
                if failures:
                    emit("error", message="Partial copy could not be completely removed.", details="\n".join(failures))
                    return 1
                emit("cancelled", cleanup=self.cleanup_requested)
                return 0
            if result:
                failures = self.rollback()
                emit("error", message="rsync failed; destination rollback attempted.", details="\n".join(failures))
                return result
            if self.move:
                failures = self.remove_sources()
                if failures:
                    emit("error", message="Files were copied but some source paths could not be removed.", details="\n".join(failures))
                    return 1
            emit("completed", moved=self.move)
            return 0
        except Exception as error:
            emit("error", message=str(error))
            return 1
        finally:
            shutil.rmtree(self.backup_dir, ignore_errors=True)


def main():
    parser = OptionParser()
    parser.add_option("-m", "--move", action="store_true", dest="move", default=False)
    options, args = parser.parse_args()
    if len(args) < 3:
        emit("error", message="Expected a source root, at least one source, and a destination.")
        return 2
    return Transfer(args[0], args[1:-1], args[-1], options.move).execute()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: None)
    sys.exit(main())
