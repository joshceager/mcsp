"""Pydantic models: the MCSP manifest schema and API payloads.

The per-mod ``side`` field is REQUIRED and enforced here at the schema level:
``client`` (client-only), ``server`` (dedicated-server-only) or ``both``.
Anything else fails validation before any logic runs.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

Side = Literal["client", "server", "both"]
MANIFEST_FORMAT_VERSION = 1
LOADER = "neoforge"

MOD_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def safe_relative_path(path: str) -> bool:
    """True if *path* is a safe relative path (no traversal / absolute escape)."""
    if not path or not isinstance(path, str):
        return False
    p = path.replace("\\", "/")
    if p.startswith("/") or (len(p) > 1 and p[1] == ":"):
        return False
    parts = p.split("/")
    for part in parts:
        if part in ("", ".", ".."):
            return False
    return True


class FileRef(BaseModel):
    """A downloadable artifact: where to get it, what it must hash to."""

    url: Annotated[str, Field(min_length=1, max_length=2048)]
    filename: Annotated[str, Field(min_length=1, max_length=255)]
    size: Annotated[int, Field(gt=0)]
    hashes: dict[str, str]

    @field_validator("filename")
    @classmethod
    def _safe_filename(cls, v: str) -> str:
        # Filename only: no separators at all.
        if not safe_relative_path(v) or "/" in v or "\\" in v:
            raise ValueError(
                f"filename must be a bare file name, got {v!r}"
            )
        return v

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: str) -> str:
        low = v.lower()
        if low.startswith("http://") or low.startswith("https://"):
            return v
        raise ValueError("download url must be http(s)")

    @field_validator("hashes")
    @classmethod
    def _require_sha1(cls, v: dict[str, str]) -> dict[str, str]:
        if "sha1" not in v or len(v["sha1"]) != 40 or not all(c in "0123456789abcdef" for c in v["sha1"].lower()):
            raise ValueError("hashes must include a lowercase 40-hex sha1")
        return v


class ModEntry(BaseModel):
    """One mod (or config file) in the pack, with its REQUIRED side classification."""

    modId: Annotated[str, Field(min_length=1, max_length=64)]
    name: str
    version: str
    side: Side
    file: FileRef
    iconUrl: str | None = None
    notes: str | None = None

    @field_validator("modId")
    @classmethod
    def _mod_id(cls, v: str) -> str:
        if not MOD_ID_RE.match(v):
            raise ValueError(
                f"modId must match {MOD_ID_RE.pattern} (got {v!r})"
            )
        return v


class Manifest(BaseModel):
    """The server-published pack. Custom MCSP format; no .mrpack anywhere."""

    formatVersion: int = MANIFEST_FORMAT_VERSION
    loader: Literal["neoforge"] = LOADER
    loaderVersion: str
    minecraftVersion: str
    mods: Annotated[list[ModEntry], Field(max_length=2000)]
    restartRequired: bool = False
    updatedAt: str | None = None

    def find(self, mod_id: str) -> ModEntry | None:
        for m in self.mods:
            if m.modId == mod_id:
                return m
        return None


# ---- API request/response payloads ------------------------------------------


class AddModRequest(BaseModel):
    modId: Annotated[str, Field(min_length=1, max_length=64)]
    name: str
    version: str
    side: Side
    file: FileRef
    iconUrl: str | None = None
    notes: str | None = None

    @field_validator("modId")
    @classmethod
    def _mod_id(cls, v: str) -> str:
        if not MOD_ID_RE.match(v):
            raise ValueError(f"modId must match {MOD_ID_RE.pattern} (got {v!r})")
        return v


class UpdateModRequest(AddModRequest):
    pass


class RemoveModRequest(BaseModel):
    pass


class JobView(BaseModel):
    id: str
    kind: str
    state: str
    progress: float | None = None
    message: str | None = None
    result: dict | None = None
    createdAt: str | None = None
    updatedAt: str | None = None


class ServerStatus(BaseModel):
    state: Literal["starting", "running", "stopping", "stopped", "error"]
    pid: int | None = None
    startedAt: str | None = None
    restartRequired: bool
    pendingRestart: bool
    autoRestartCount: int = 0
    installedMcVersion: str | None = None
    installedLoader: str | None = None
    installedLoaderVersion: str | None = None
    joinAddress: str | None = None
    joinPort: int
    apiPort: int
    adminEnabled: bool
    managerEnabled: bool


class ConsoleLine(BaseModel):
    line: str
