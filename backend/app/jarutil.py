"""Validation of downloaded mod jars / loader installers (zip-safety checks)."""

from __future__ import annotations

import zipfile
from pathlib import Path


class InvalidJar(Exception):
    pass


def check_zip_safety(path: Path) -> None:
    """Reject archives whose entry names would escape the extraction directory
    or contain absolute paths. This guards both mods/ and the server dir."""
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                name = info.filename
                if not name:
                    raise InvalidJar(f"empty entry name in {path.name}")
                if name.startswith("/") or "\\" in name or ":" in name.split("/")[0]:
                    raise InvalidJar(f"absolute path in archive entry: {name!r}")
                parts = name.replace("\\", "/").split("/")
                if ".." in parts:
                    raise InvalidJar(f"path traversal in archive entry: {name!r}")
                if info.is_dir():
                    continue
    except zipfile.BadZipFile as e:
        raise InvalidJar(f"not a valid zip/jar: {e}") from e


def check_loader_marker(path: Path, expected_loader: str) -> None:
    """Verify the jar is actually a mod for the expected loader.

    NeoForge mods carry META-INF/neoforge.mods.toml; Fabric carries
    fabric.mod.json. A jar with neither marker is not a mod we manage.
    """
    markers = {
        "neoforge": ("META-INF/neoforge.mods.toml", "META-INF/mods.toml"),
        "fabric": ("fabric.mod.json",),
    }
    names = markers.get(expected_loader)
    if names is None:
        return  # unknown loader: no marker rule (schema forbids this in v1)
    with zipfile.ZipFile(path) as zf:
        have = set(zf.namelist())
    if not any(n in have for n in names):
        raise InvalidJar(
            f"no {expected_loader} mod metadata in {path.name}; refusing to install"
        )
