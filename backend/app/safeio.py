"""Path-traversal-safe filesystem helpers.

All writes into the server tree go through these guards: resolve() the final
path and assert it stays inside the designated root.
"""

from __future__ import annotations

import os
from pathlib import Path


def resolve_within(root: Path, *parts: str) -> Path:
    """Join *parts* under *root* and verify the result cannot escape it."""
    root_res = root.resolve()
    candidate = (root_res / Path(*parts)).resolve()
    if candidate != root_res and root_res not in candidate.parents:
        raise PermissionError(f"path escapes allowed root {root}: {candidate}")
    return candidate


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def atomic_write(path: Path, data: bytes) -> None:
    """Write bytes to *path* atomically (same-directory temp + rename)."""
    ensure_dir(path.parent)
    tmp = path.parent / (path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def atomic_write_json(path: Path, obj) -> None:
    import json

    atomic_write(path, (json.dumps(obj, indent=2) + "\n").encode("utf-8"))


def read_json(path: Path):
    import json

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
