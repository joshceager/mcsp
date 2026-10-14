"""PackManager: real file-level mod management on the managed server.

Contract (approved): every successful authorized add/update/remove writes or
deletes actual files in <server>/mods/. Never metadata-only. Sequence per op:
    1. download to staging (never directly into mods/)
    2. verify sha1 (from manifest) + zip-safety + loader marker
    3. tar.gz backup of mods/ + config/ into backups/
    4. atomic apply (write + os.replace, or unlink for removal)
    5. publish updated manifest (only after files applied; rollback on failure)
    6. set restartRequired; when the server is running, file changes take
       effect on the next restart (the client sees pendingRestart=true).
"""

from __future__ import annotations

import logging
import shutil
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

from . import netdl
from .errors import ApiError, bad_request, conflict, internal, not_found
from .jarutil import InvalidJar, check_loader_marker, check_zip_safety
from .models import AddModRequest, Manifest, ModEntry, UpdateModRequest
from .safeio import atomic_write, ensure_dir, read_json, resolve_within

log = logging.getLogger("mcsp.packmgr")


class PackManager:
    def __init__(self, settings, manifest_store, supervisor) -> None:
        self.settings = settings
        self.manifest_store = manifest_store
        self.supervisor = supervisor

    # ------------------------------------------------------------------ files

    @property
    def mods_dir(self) -> Path:
        return ensure_dir(self.settings.server_dir / "mods")

    def installed_files(self) -> list[dict]:
        """Actual files currently in the managed server's mods dir."""
        out = []
        mods_dir = self.mods_dir
        if not mods_dir.exists():
            return out
        for p in sorted(mods_dir.iterdir()):
            if p.is_file() and p.suffix in (".jar", ".jar.disabled", ".disabled"):
                out.append(
                    {
                        "filename": p.name,
                        "size": p.stat().st_size,
                        "modifiedAt": datetime.fromtimestamp(
                            p.stat().st_mtime, timezone.utc
                        ).isoformat(),
                    }
                )
        return out

    # ------------------------------------------------------------------- ops

    def add_mod(self, req: AddModRequest, progress=None) -> dict:
        manifest = self._current_manifest()
        if manifest.find(req.modId) is not None:
            raise conflict(
                f"mod {req.modId} already exists; use PUT /pack/mods/{req.modId} to update it",
                "mod_exists",
                modId=req.modId,
            )
        # Side enforcement FIRST: never spend a download on a forbidden op.
        if req.side == "client":
            raise bad_request(
                f"mod {req.modId} has side=client (client-only); refusing to "
                "install it on the managed server",
                "side_mismatch",
                modId=req.modId,
                side=req.side,
            )
        staged = self._download_and_verify(req.file, progress)
        try:
            self._validate_jar(staged, req)
            backup = self._backup("add", req.modId)
            target = self.mods_dir / req.file.filename
            shutil.copy2(staged, target)
            self._publish(lambda m: self._add_to_manifest(m, req), backup)
            return self._result(
                "add",
                req,
                filesWritten=[target.name],
                restartRequired=True,
            )
        finally:
            self._cleanup_staging(staged)

    def update_mod(self, mod_id: str, req: UpdateModRequest, progress=None) -> dict:
        manifest = self._current_manifest()
        existing = manifest.find(mod_id)
        if existing is None:
            raise not_found(f"mod {mod_id} is not in the pack", "mod_not_found", modId=mod_id)
        if mod_id != req.modId:
            raise bad_request("modId in path and body must match", "modid_mismatch")
        if req.side == "client":
            raise bad_request(
                f"mod {mod_id} is side=client (client-only); it is not installed "
                "on the managed server, so there is nothing to update",
                "side_mismatch",
                modId=mod_id,
                side=req.side,
            )
        staged = self._download_and_verify(req.file, progress)
        try:
            self._validate_jar(staged, req)
            backup = self._backup("update", mod_id)
            target = self.mods_dir / req.file.filename
            # Remove the old jar (whatever its filename) before placing the new one.
            removed = []
            old_name = existing.file.filename
            old_path = resolve_within(self.mods_dir, old_name)
            if old_path.exists():
                old_path.unlink()
                removed.append(old_path.name)
            elif old_name != req.file.filename:
                # Old manifest entry name missing on disk; best effort sweep.
                self._sweep_orphan(old_name)
            shutil.copy2(staged, target)
            self._publish(lambda m: self._replace_in_manifest(m, req), backup)
            return self._result(
                "update",
                req,
                filesWritten=[target.name],
                filesRemoved=removed,
                restartRequired=True,
            )
        finally:
            self._cleanup_staging(staged)

    def remove_mod(self, mod_id: str) -> dict:
        manifest = self._current_manifest()
        existing = manifest.find(mod_id)
        if existing is None:
            raise not_found(f"mod {mod_id} is not in the pack", "mod_not_found", modId=mod_id)
        if existing.side == "client":
            raise bad_request(
                f"mod {mod_id} has side=client; it was never installed on the "
                "managed server, so nothing can be removed",
                "side_mismatch",
                modId=mod_id,
                side=existing.side,
            )
        backup = self._backup("remove", mod_id)
        removed = []
        path = resolve_within(self.mods_dir, existing.file.filename)
        if path.exists():
            path.unlink()
            removed.append(path.name)
        else:
            self._sweep_orphan(existing.file.filename)
        self._publish(lambda m: self._remove_from_manifest(m, mod_id), backup)
        return self._result(
            "remove",
            existing,
            filesRemoved=removed,
            restartRequired=True,
        )

    # ------------------------------------------------------------ internals

    def _current_manifest(self) -> Manifest:
        manifest = self.manifest_store.load_manifest()
        if manifest is None:
            raise internal("pack manifest missing on disk", "manifest_missing")
        return manifest

    def _download_and_verify(self, file_ref, progress=None) -> Path:
        staging = ensure_dir(self.settings.staging_dir / f"dl-{int(time.time()*1000)}")
        target = resolve_within(staging, file_ref.filename)
        log.info("downloading %s (%d bytes) to staging", file_ref.url, file_ref.size)
        try:
            written = netdl.download_to(
                file_ref.url,
                target,
                self.settings.download_max_bytes,
                progress_cb=progress,
            )
        except netdl.DownloadError as e:
            raise bad_request(str(e), "download_failed", url=file_ref.url)
        if written != file_ref.size:
            raise bad_request(
                f"downloaded {written} bytes but manifest declared {file_ref.size}",
                "size_mismatch",
                expected=file_ref.size,
                actual=written,
            )
        sha1 = netdl.sha1_file(target)
        if sha1 != file_ref.hashes["sha1"].lower():
            raise bad_request(
                "sha1 hash mismatch; download rejected (interrupted or tampered)",
                "hash_mismatch",
                expected=file_ref.hashes["sha1"],
                actual=sha1,
            )
        try:
            check_zip_safety(target)
        except InvalidJar as e:
            raise bad_request(str(e), "invalid_archive")
        return target

    def _validate_jar(self, staged: Path, entry) -> None:
        try:
            check_loader_marker(staged, self.settings.loader_type)
        except InvalidJar as e:
            raise bad_request(str(e), "not_a_loader_mod")

    def _backup(self, op: str, mod_id: str) -> Path:
        backups = ensure_dir(self.settings.backups_dir)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = backups / f"{stamp}-{op}-{mod_id}.tar.gz"
        server = self.settings.server_dir
        with tarfile.open(path, "w:gz") as tf:
            for sub in ("mods", "config"):
                d = server / sub
                if d.exists():
                    tf.add(d, arcname=sub)
        self._prune_backups()
        return path

    def _prune_backups(self, keep: int = 5) -> None:
        backups = sorted(self.settings.backups_dir.glob("*.tar.gz"))
        for old in backups[:-keep]:
            old.unlink(missing_ok=True)

    def restore_backup(self, backup_id: str) -> dict:
        """Admin: restore a mods/config snapshot taken before a pack change."""
        path = resolve_within(self.settings.backups_dir, backup_id)
        if not path.exists() or path.suffix != ".gz":
            raise not_found(f"no such backup: {backup_id}", "backup_not_found", backupId=backup_id)
        # Refuse to restore over a running server (files are loaded).
        st = self.supervisor.state
        if st in ("running", "starting"):
            raise conflict(
                "stop the server before restoring a backup", "server_running"
            )
        server = self.settings.server_dir
        with tarfile.open(path, "r:gz") as tf:
            for member in tf.getmembers():
                from .safeio import resolve_within

                resolve_within(server, member.name)
            tf.extractall(server)
        self._sweep_manifest_vs_disk()
        return {"restored": backup_id, "restartRequired": True}

    def list_backups(self) -> list[dict]:
        out = []
        for p in sorted(self.settings.backups_dir.glob("*.tar.gz")):
            out.append({"id": p.name, "size": p.stat().st_size})
        return out

    def _sweep_orphan(self, filename: str) -> None:
        try:
            resolve_within(self.mods_dir, filename).unlink(missing_ok=True)
        except PermissionError:
            pass

    def _sweep_manifest_vs_disk(self) -> None:
        """Best-effort: after a restore, report (not fix) manifest/disk skew."""
        manifest = self.manifest_store.load_manifest()
        if manifest is None:
            return
        disk = {p.name for p in self.mods_dir.iterdir()} if self.mods_dir.exists() else set()
        log.info("post-restore skew check: manifest=%d mods, disk=%d files",
                 len(manifest.mods), len(disk))

    def _publish(self, mutate, backup_path: Path) -> None:
        """Apply a mutation to the on-disk manifest, atomically and last.

        If the manifest write fails after files were already applied, roll the
        server's mods/config back from the snapshot taken at step 3 so disk
        and manifest can never drift apart silently."""
        manifest = self._current_manifest()
        mutate(manifest)
        try:
            self.manifest_store.save_manifest(manifest)
        except Exception as e:
            log.exception("manifest write failed; rolling back files from %s", backup_path)
            try:
                with tarfile.open(backup_path, "r:gz") as tf:
                    tf.extractall(self.settings.server_dir)
                log.warning("rolled back server files from %s", backup_path)
            except Exception:
                log.exception("rollback failed; manual restore required: %s", backup_path)
            raise internal(
                f"failed to publish manifest: {e}",
                "manifest_write_failed",
                rolledBackFrom=backup_path.name,
            )

    def _add_to_manifest(self, m: Manifest, req: AddModRequest) -> None:
        m.mods.append(
            ModEntry(
                modId=req.modId,
                name=req.name,
                version=req.version,
                side=req.side,
                file=req.file,
                iconUrl=req.iconUrl,
                notes=req.notes,
            )
        )
        m.restartRequired = True

    def _replace_in_manifest(self, m: Manifest, req: UpdateModRequest) -> None:
        for i, entry in enumerate(m.mods):
            if entry.modId == req.modId:
                m.mods[i] = ModEntry(
                    modId=req.modId,
                    name=req.name,
                    version=req.version,
                    side=req.side,
                    file=req.file,
                    iconUrl=req.iconUrl,
                    notes=req.notes,
                )
                break
        m.restartRequired = True

    def _remove_from_manifest(self, m: Manifest, mod_id: str) -> None:
        m.mods = [e for e in m.mods if e.modId != mod_id]
        m.restartRequired = True

    def _result(self, op, entry, **kw) -> dict:
        return {
            "op": op,
            "modId": entry.modId,
            "side": entry.side,
            **kw,
            "note": (
                "files applied to the managed server's mods/ directory; the "
                "running server picks them up on the next restart"
            ),
        }

    def _cleanup_staging(self, staged: Path) -> None:
        shutil.rmtree(staged.parent, ignore_errors=True)
