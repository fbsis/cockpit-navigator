#!/usr/bin/env python3

"""Run Navigator backup jobs and maintain their per-user cron entries."""

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys


SCRIPT_PATH = "/usr/share/cockpit/navigator/scripts/backup.py3"
UNIT_DIRECTORY = Path("/etc/systemd/system")


def config_path():
    home = Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser()
    return home / "cockpit-navigator" / "config.json"


def load_config():
    path = config_path()
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as config_file:
        config = json.load(config_file)
    if not isinstance(config, dict):
        raise ValueError("Navigator configuration must be a JSON object.")
    return config


def save_config(config):
    path = config_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as config_file:
        json.dump(config, config_file, indent=2, sort_keys=True)
        config_file.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def jobs_from(config):
    jobs = config.get("backups", {}).get("jobs", [])
    return jobs if isinstance(jobs, list) else []


def on_calendar(job):
    legacy = {"0 */2 * * *": "*-*-* 00/2:00:00", "0 */6 * * *": "*-*-* 00/6:00:00", "0 2 * * *": "*-*-* 02:00:00"}
    value = job.get("onCalendar") or legacy.get(job.get("schedule"))
    if not isinstance(value, str) or not value.strip() or "\n" in value or "\r" in value:
        raise ValueError("Backup schedule must be a valid systemd OnCalendar expression.")
    return value.strip()


def validate_job(job):
    if not isinstance(job, dict) or not re.fullmatch(r"[a-z0-9-]+", str(job.get("id", ""))):
        raise ValueError("Invalid backup job.")
    if job.get("mode", "rsync") not in ("rsync", "snapshot"):
        raise ValueError("Invalid backup mode.")
    fields = ("source", "destination") if job.get("mode", "rsync") == "rsync" else ("source",)
    for field in fields:
        value = job.get(field)
        if not isinstance(value, str) or not os.path.isabs(value):
            raise ValueError(f"Backup {field} must be an absolute path.")
    if job.get("enabled"):
        on_calendar(job)


def unit_name(job_id, suffix):
    return f"cockpit-navigator-backup@{job_id}.{suffix}"


def write_unit(name, content):
    path = UNIT_DIRECTORY / name
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, 0o644)
    os.replace(temporary, path)


def service_unit(job_id):
    return "\n".join([
        "[Unit]",
        f"Description=Cockpit Navigator backup {job_id}",
        "",
        "[Service]",
        "Type=oneshot",
        f"ExecStart={SCRIPT_PATH} run {job_id}",
        "",
    ])


def timer_unit(job_id, calendar):
    return "\n".join([
        "[Unit]",
        f"Description=Schedule Cockpit Navigator backup {job_id}",
        "",
        "[Timer]",
        f"OnCalendar={calendar}",
        "Persistent=true",
        f"Unit={unit_name(job_id, 'service')}",
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
    ])


def sync_systemd():
    config = load_config()
    jobs = jobs_from(config)
    job_ids = set()
    UNIT_DIRECTORY.mkdir(mode=0o755, parents=True, exist_ok=True)
    for job in jobs:
        validate_job(job)
        job_ids.add(job["id"])
        write_unit(unit_name(job["id"], "service"), service_unit(job["id"]))
        if job.get("enabled"):
            write_unit(unit_name(job["id"], "timer"), timer_unit(job["id"], on_calendar(job)))
        else:
            timer = UNIT_DIRECTORY / unit_name(job["id"], "timer")
            subprocess.run(["systemctl", "disable", "--now", timer.name], capture_output=True)
            timer.unlink(missing_ok=True)
    for timer in UNIT_DIRECTORY.glob("cockpit-navigator-backup@*.timer"):
        job_id = timer.name[len("cockpit-navigator-backup@"): -len(".timer")]
        if job_id not in job_ids:
            subprocess.run(["systemctl", "disable", "--now", timer.name], capture_output=True)
            timer.unlink()
            (UNIT_DIRECTORY / unit_name(job_id, "service")).unlink(missing_ok=True)
    subprocess.run(["systemctl", "daemon-reload"], check=True, capture_output=True)
    enabled = 0
    for job in jobs:
        if job.get("enabled"):
            subprocess.run(["systemctl", "enable", "--now", unit_name(job["id"], "timer")], check=True, capture_output=True)
            enabled += 1
    return {"jobs": enabled}


def zfs_dataset(path):
    output = subprocess.run(
        ["findmnt", "--json", "--target", path, "--output", "FSTYPE,SOURCE"],
        check=True, text=True, capture_output=True,
    ).stdout
    filesystems = json.loads(output).get("filesystems", [])
    filesystem = filesystems[0] if filesystems else {}
    return filesystem.get("source") if filesystem.get("fstype") == "zfs" else None


def log_path(job_id):
    directory = Path(os.environ.get("XDG_CACHE_HOME", "~/.cache")).expanduser() / "cockpit-navigator" / "backups"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    return directory / f"{job_id}.log"


def write_log(job_id, message):
    with log_path(job_id).open("a", encoding="utf-8") as log_file:
        log_file.write(f"{datetime.datetime.now().astimezone().isoformat(timespec='seconds')} {message}\n")


def snapshot_metrics(dataset, job_id, retention):
    prefix = f"{dataset}@navigator-{job_id}-"
    output = subprocess.run(
        ["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation", "-r", dataset],
        check=True, text=True, capture_output=True,
    ).stdout
    snapshots = [name for name in output.splitlines() if name.startswith(prefix)]
    removed = 0
    if retention > 0:
        for snapshot in snapshots[:-retention]:
            subprocess.run(["zfs", "destroy", snapshot], check=True, capture_output=True)
            removed += 1
        snapshots = snapshots[-retention:]
    return {"kept": len(snapshots), "removed": removed}


def rsync_metrics(output):
    metrics = {}
    for line in output.splitlines():
        if line.startswith("Number of files:"):
            metrics["files"] = line.split(":", 1)[1].strip()
        elif line.startswith("Total transferred file size:"):
            metrics["transferred"] = line.split(":", 1)[1].strip()
    return metrics


def run_job(job_id):
    config = load_config()
    job = next((item for item in jobs_from(config) if item.get("id") == job_id), None)
    if not job:
        raise ValueError("Backup job not found.")
    validate_job(job)
    source = os.path.realpath(job["source"])
    destination = os.path.realpath(job["destination"]) if job.get("mode", "rsync") == "rsync" else None
    if not os.path.isdir(source):
        raise ValueError("Backup source must be an existing directory.")
    if destination and (source == destination or destination.startswith(source.rstrip("/") + "/")):
        raise ValueError("Backup destination cannot be the source or a folder inside it.")

    cache_dir = Path(os.environ.get("XDG_CACHE_HOME", "~/.cache")).expanduser() / "cockpit-navigator" / "backups"
    cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = cache_dir / f"{job_id}.lock"
    with lock_path.open("w") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"skipped": True, "message": "Backup is already running."}

        started = datetime.datetime.now(datetime.timezone.utc)
        try:
            write_log(job_id, f"Started {job.get('mode', 'rsync')} job.")
            stamp = started.strftime("%Y%m%d-%H%M%S")
            snapshot_datasets = set()
            snapshot_paths = [(source, job.get("snapshotSource") or job.get("mode") == "snapshot")]
            if destination:
                os.makedirs(destination, exist_ok=True)
                snapshot_paths.append((destination, job.get("snapshotDestination")))
            for path, enabled in snapshot_paths:
                if enabled:
                    dataset = zfs_dataset(path)
                    if not dataset:
                        raise ValueError(f"Snapshot requested but {path} is not on ZFS.")
                    snapshot_datasets.add(dataset)
            for dataset in snapshot_datasets:
                subprocess.run(["zfs", "snapshot", f"{dataset}@navigator-{job_id}-{stamp}"], check=True, capture_output=True)
                write_log(job_id, f"Created snapshot {dataset}@navigator-{job_id}-{stamp}.")
            snapshots = {"kept": 0, "removed": 0}
            retention = max(0, int(job.get("snapshotRetention", 0) or 0))
            for dataset in snapshot_datasets:
                result = snapshot_metrics(dataset, job_id, retention)
                snapshots["kept"] += result["kept"]
                snapshots["removed"] += result["removed"]
            if destination:
                rsync = subprocess.run(
                    ["rsync", "-aHAX", "--numeric-ids", "--stats", source.rstrip("/") + "/", destination.rstrip("/") + "/"],
                    check=True, capture_output=True,
                )
                metrics = rsync_metrics(rsync.stdout.decode())
            else:
                metrics = {}
            finished = datetime.datetime.now(datetime.timezone.utc)
            job["lastRun"] = {
                "status": "success", "at": started.isoformat(),
                "durationSeconds": round((finished - started).total_seconds()),
                "metrics": {**metrics, "snapshots": snapshots["kept"], "snapshotsRemoved": snapshots["removed"]},
            }
            write_log(job_id, "Completed successfully.")
            save_config(config)
            return {"source": source, "destination": destination, "mode": job.get("mode", "rsync")}
        except Exception as error:
            job["lastRun"] = {"status": "error", "at": started.isoformat(), "error": str(error)}
            write_log(job_id, f"Failed: {error}")
            save_config(config)
            raise


def main():
    parser = argparse.ArgumentParser()
    command = parser.add_subparsers(dest="action", required=True)
    command.add_parser("sync-systemd")
    start = command.add_parser("start")
    start.add_argument("job_id")
    logs = command.add_parser("logs")
    logs.add_argument("job_id")
    run = command.add_parser("run")
    run.add_argument("job_id")
    arguments = parser.parse_args()
    try:
        if arguments.action == "sync-systemd":
            result = sync_systemd()
        elif arguments.action == "start":
            subprocess.run(["systemctl", "start", "--no-block", unit_name(arguments.job_id, "service")], check=True, capture_output=True)
            result = {"started": True}
        elif arguments.action == "logs":
            path = log_path(arguments.job_id)
            lines = path.read_text(encoding="utf-8").splitlines()[-50:] if path.exists() else []
            result = {"lines": lines}
        else:
            result = run_job(arguments.job_id)
        print(json.dumps({"ok": True, **result}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
