#!/usr/bin/env python3
"""Read a bounded source ZIP from stdin and emit only a safe file manifest.

The archive never touches disk.  This helper deliberately accepts only
regular files and directories, and emits Git blob SHA-1 values rather than
file contents.  The caller compares the manifest to an explicitly reviewed
Git tree.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import stat
import sys
import zipfile


def reject() -> None:
    raise ValueError("unsupported source archive")


def safe_path(name: str, directory: bool) -> str:
    if not isinstance(name, str) or not name or len(name) > 2048 or "\x00" in name:
        reject()
    if "\\" in name or any(ord(char) < 32 or ord(char) == 127 for char in name):
        reject()
    if len(name) >= 2 and name[0].isalpha() and name[1] == ":":
        reject()
    if directory:
        if not name.endswith("/"):
            reject()
        name = name[:-1]
    elif name.endswith("/"):
        reject()
    if not name or name.startswith("/"):
        reject()
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        reject()
    return name


def entry_kind(info: zipfile.ZipInfo) -> str:
    if info.flag_bits & 0x1:
        reject()
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        reject()
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    directory = info.is_dir()
    if directory:
        if file_type not in (0, stat.S_IFDIR):
            reject()
        if info.file_size != 0 or info.compress_size != 0:
            reject()
        safe_path(info.filename, True)
        return "directory"
    if info.filename.endswith("/") or file_type == stat.S_IFDIR or (info.external_attr & 0x10):
        reject()
    if file_type not in (0, stat.S_IFREG):
        reject()
    safe_path(info.filename, False)
    return "file"


def run(args: argparse.Namespace) -> None:
    archive = sys.stdin.buffer.read(args.max_archive_bytes + 1)
    if len(archive) > args.max_archive_bytes:
        reject()
    archive_digest = hashlib.sha256(archive).hexdigest()
    try:
        source = zipfile.ZipFile(io.BytesIO(archive), mode="r")
    except (OSError, ValueError, zipfile.BadZipFile):
        reject()

    infos = source.infolist()
    if len(infos) == 0 or len(infos) > args.max_entries:
        reject()
    seen: set[str] = set()
    files: list[dict[str, str]] = []
    directories: list[str] = []
    decompressed_bytes = 0
    try:
        for info in infos:
            kind = entry_kind(info)
            path = safe_path(info.filename, kind == "directory")
            if path in seen:
                reject()
            seen.add(path)
            if kind == "directory":
                directories.append(path)
                continue
            if info.file_size < 0 or info.file_size > args.max_decompressed_bytes:
                reject()
            decompressed_bytes += info.file_size
            if decompressed_bytes > args.max_decompressed_bytes:
                reject()
            try:
                with source.open(info, mode="r") as stream:
                    content = stream.read(info.file_size + 1)
            except (OSError, RuntimeError, ValueError, zipfile.BadZipFile):
                reject()
            if len(content) != info.file_size:
                reject()
            blob_header = f"blob {len(content)}\0".encode("ascii")
            blob_sha = hashlib.sha1(blob_header + content).hexdigest()
            files.append({"path": path, "blobSha1": blob_sha})
    finally:
        source.close()

    files.sort(key=lambda item: item["path"])
    directories.sort()
    result = {
        "archiveSha256": archive_digest,
        "files": files,
        "directories": directories,
        "decompressedBytes": decompressed_bytes,
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":"), ensure_ascii=True))


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--max-archive-bytes", type=int, required=True)
    parser.add_argument("--max-decompressed-bytes", type=int, required=True)
    parser.add_argument("--max-entries", type=int, required=True)
    args = parser.parse_args()
    if args.max_archive_bytes <= 0 or args.max_decompressed_bytes <= 0 or args.max_entries <= 0:
        return 2
    try:
        run(args)
    except Exception:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
