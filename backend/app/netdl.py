"""HTTP downloading with size limits and hash verification."""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Callable

import httpx

log = logging.getLogger("mcsp.netdl")


class DownloadError(Exception):
    pass


def download_to(
    url: str,
    dest_path,
    max_bytes: int,
    timeout_s: float = 120.0,
    progress_cb: Callable[[int, int | None], None] | None = None,
    follow_redirects: bool = True,
) -> int:
    """Stream *url* into *dest_path* (returns bytes written).

    Enforces a hard size limit; never loads the whole body into memory.
    Raises DownloadError on HTTP/transport problems.
    """
    sha1 = hashlib.sha1()
    written = 0
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest_path.parent / (dest_path.name + ".part")
    try:
        with httpx.Client(timeout=timeout_s, follow_redirects=follow_redirects) as client:
            with client.stream("GET", url) as resp:
                if resp.status_code != 200:
                    raise DownloadError(f"HTTP {resp.status_code} for {url}")
                total = resp.headers.get("content-length")
                total = int(total) if total and total.isdigit() else None
                with open(tmp, "wb") as f:
                    for chunk in resp.iter_bytes(chunk_size=64 * 1024):
                        sha1.update(chunk)
                        written += len(chunk)
                        if written > max_bytes:
                            raise DownloadError(f"download exceeded size limit ({max_bytes} bytes)")
                        f.write(chunk)
                        if progress_cb:
                            progress_cb(written, total)
        os.replace(tmp, dest_path)
        return written
    except httpx.HTTPError as e:
        raise DownloadError(f"download failed for {url}: {e}") from e
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def sha1_file(path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
