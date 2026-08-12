#!/usr/bin/env python3

"""Inspect and restore individual paths from OpenZFS snapshots."""

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import time


def run(command):
    return subprocess.run(command, check=True, text=True, capture_output=True).stdout


def normalize_entry_path(path):
    path = os.path.abspath(path)
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))


def filesystem_for(path):
    path = normalize_entry_path(path)
    output = run(["findmnt", "--json", "--target", path, "--output", "FSTYPE,SOURCE,TARGET"])
    filesystems = json.loads(output).get("filesystems", [])
    if not filesystems:
        return {"supported": False, "mountpoint": "/", "filesystem": "unknown"}
    filesystem = filesystems[0]
    fs_type = filesystem.get("fstype", "")
    mountpoint = os.path.abspath(filesystem.get("target") or "/")
    result = {"supported": fs_type == "zfs", "filesystem": fs_type, "mountpoint": mountpoint}
    if result["supported"]:
        result["dataset"] = filesystem.get("source", "")
    return result


def snapshot_path(info, snapshot, target):
    dataset = info.get("dataset", "")
    prefix = dataset + "@"
    if not snapshot.startswith(prefix):
        raise ValueError("Snapshot does not belong to the target dataset.")
    snapshot_name = snapshot[len(prefix):]
    if not snapshot_name or "/" in snapshot_name or snapshot_name in (".", ".."):
        raise ValueError("Invalid snapshot name.")
    target = normalize_entry_path(target)
    mountpoint = info["mountpoint"]
    relative = os.path.relpath(target, mountpoint)
    if relative == ".." or relative.startswith("../"):
        raise ValueError("Target is outside the dataset mountpoint.")
    return os.path.join(mountpoint, ".zfs", "snapshot", snapshot_name, relative)


def list_snapshots(path):
    info = filesystem_for(path)
    if not info["supported"]:
        return {**info, "snapshots": []}
    dataset = info["dataset"]
    output = run(["zfs", "list", "-H", "-p", "-t", "snapshot", "-o", "name,creation", "-s", "creation", "-r", dataset])
    snapshots = []
    for line in output.splitlines():
        fields = line.split("\t")
        if len(fields) != 2 or not fields[0].startswith(dataset + "@"):
            continue
        name, created_raw = fields
        source = snapshot_path(info, name, path)
        if not os.path.lexists(source):
            continue
        stats = os.lstat(source)
        created = int(created_raw)
        snapshots.append({
            "name": name,
            "shortName": name.split("@", 1)[1],
            "created": created,
            "createdText": datetime.datetime.fromtimestamp(created).astimezone().isoformat(timespec="seconds"),
            "size": stats.st_size,
            "modified": int(stats.st_mtime),
            "type": "directory" if os.path.isdir(source) and not os.path.islink(source) else "file",
        })
    return {**info, "snapshots": snapshots}


def restore(path, snapshot):
    info = filesystem_for(path)
    if not info["supported"]:
        raise ValueError("The target is not stored on ZFS.")
    path = normalize_entry_path(path)
    if path == info["mountpoint"]:
        raise ValueError("Restoring an entire dataset mountpoint is not allowed here.")
    source = snapshot_path(info, snapshot, path)
    if not os.path.lexists(source):
        raise FileNotFoundError("This path does not exist in the selected snapshot.")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(os.path.dirname(path), f".navigator-before-snapshot-{os.path.basename(path)}-{stamp}")
    if os.path.isdir(source) and not os.path.islink(source):
        os.makedirs(path, exist_ok=True)
        os.makedirs(backup, exist_ok=False)
        command = [
            "rsync", "-aHAX", "--numeric-ids", "--backup", f"--backup-dir={backup}",
            source.rstrip("/") + "/", path.rstrip("/") + "/",
        ]
        subprocess.run(command, check=True)
        if not any(os.scandir(backup)):
            os.rmdir(backup)
            backup = None
    else:
        if os.path.lexists(path):
            if os.path.isdir(path) and not os.path.islink(path):
                raise ValueError("The current path is a directory but the snapshot path is not.")
            shutil.copy2(path, backup, follow_symlinks=False)
            os.unlink(path)
        else:
            backup = None
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if os.path.islink(source):
            os.symlink(os.readlink(source), path)
        else:
            shutil.copy2(source, path, follow_symlinks=False)
    return {"restored": path, "snapshot": snapshot, "backup": backup}


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)
    for action in ("detect", "list"):
        command = subparsers.add_parser(action)
        command.add_argument("path")
    restore_command = subparsers.add_parser("restore")
    restore_command.add_argument("path")
    restore_command.add_argument("snapshot")
    arguments = parser.parse_args()
    try:
        if arguments.action == "detect":
            result = filesystem_for(arguments.path)
        elif arguments.action == "list":
            result = list_snapshots(arguments.path)
        else:
            result = restore(arguments.path, arguments.snapshot)
        print(json.dumps({"ok": True, **result}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
