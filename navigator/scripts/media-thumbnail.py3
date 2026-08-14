#!/usr/bin/env python3

"""Create cached image/video thumbnails in the system temporary directory."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile


CACHE_DIR = os.path.join(tempfile.gettempdir(), "cockpit-navigator", "thumbnails")


def dependency(media_type):
    if media_type == "video":
        return shutil.which("ffmpeg"), "ffmpeg"
    return shutil.which("magick") or shutil.which("convert"), "imagemagick"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("media_type", choices=("image", "video"))
    parser.add_argument("path")
    args = parser.parse_args()
    command, package = dependency(args.media_type)
    if not command:
        print(json.dumps({"status": "missing", "package": package}))
        return
    stats = os.stat(args.path, follow_symlinks=True)
    cache_key = hashlib.sha256(
        f"{args.path}\0{stats.st_mtime_ns}\0{stats.st_size}\0v1".encode()
    ).hexdigest()
    os.makedirs(CACHE_DIR, mode=0o700, exist_ok=True)
    output = os.path.join(CACHE_DIR, f"{cache_key}.jpg")
    if not os.path.exists(output):
        temporary = f"{output}.{os.getpid()}.tmp.jpg"
        try:
            if args.media_type == "video":
                invocation = [command, "-v", "error", "-ss", "1", "-i", args.path,
                              "-frames:v", "1", "-vf", "scale=320:240:force_original_aspect_ratio=decrease",
                              "-q:v", "4", "-y", temporary]
            elif os.path.basename(command) == "magick":
                invocation = [command, args.path + "[0]", "-auto-orient", "-thumbnail", "320x240>",
                              "-strip", "-quality", "82", temporary]
            else:
                invocation = [command, args.path + "[0]", "-auto-orient", "-thumbnail", "320x240>",
                              "-strip", "-quality", "82", temporary]
            subprocess.run(invocation, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
            os.chmod(temporary, 0o600)
            os.replace(temporary, output)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    print(json.dumps({"status": "ok", "path": output}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "error", "message": str(error)}))
