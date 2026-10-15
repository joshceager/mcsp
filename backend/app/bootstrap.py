"""Zero-configuration provisioning of the managed Minecraft server.

On first boot the backend (1) obtains a Java runtime (bundled in the Docker
image, downloaded on demand on bare-metal/first run), (2) downloads the
NeoForge installer from maven.neoforged.net, (3) runs it headlessly to create
the server, (4) writes eula.txt (opt-out via MCSP_ACCEPT_EULA=0), a default
server.properties with sensible defaults (which the owner can edit on the bind
mount), and (5) records installed version markers in meta.db.

Everything lands under MCSP_DATA_DIR so a container upgrade with the same bind
mount simply finds an already-provisioned server.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import subprocess
import threading
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from . import netdl
from .errors import internal
from .safeio import atomic_write, atomic_write_json, ensure_dir, read_json

log = logging.getLogger("mcsp.bootstrap")

MAVEN = "https://maven.neoforged.net/releases"
NEOFORGE_INSTALLER_URL = (
    f"{MAVEN}/net/neoforged/neoforge/{{v}}/neoforge-{{v}}-installer.jar"
)
# adoptium api: latest LTS JRE for linux/macos/windows x64
ADOPTIUM_API = (
    "https://api.adoptium.net/v3/assets/latest/{ver}/{hotspot}"
    "?architecture={arch}&image_type=jre&os={os}&vendor=eclipse"
)


class Bootstrap:
    """Idempotent first-boot provisioning of the managed server directory."""

    def __init__(self, settings, store) -> None:
        self.settings = settings
        self.store = store
        self.manifest_store = ManifestStore(settings)
        self._install_lock = threading.Lock()

    # ------------------------------------------------------------------ state

    def is_provisioned(self) -> bool:
        return (self.settings.server_dir / "run.sh").exists()

    def ensure_java(self) -> Path:
        """Return a java executable path, downloading a JRE on demand.

        The Docker image ships a Java 21 JRE, so in the default deployment this
        just returns the system java. On bare-metal first runs we fetch an
        Adoptium JRE into the data dir. The resolved runtime is remembered in
        meta so subsequent boots are instant.
        """
        s = self.settings
        cached = self.store.get_meta("java_runtime")
        if cached and Path(cached).exists():
            return Path(cached)
        sys_java = shutil.which("java")
        if sys_java:
            return Path(sys_java)
        jre_dir = s.runtime_dir / f"jre-{s.java_temp_version}"
        java_bin = jre_dir / "bin" / "java"
        if java_bin.exists():
            self.store.set_meta("java_runtime", str(java_bin))
            return java_bin
        # Last resort: pull an Adoptium JRE into the data dir.
        return self.download_java()

    def download_java(self, progress=None) -> Path:
        """Fetch an Adoptium JRE into the runtime dir (bare-metal first run).

        Uses the Adoptium public API (no key required). Extracts safely into
        the data dir and remembers the resolved java path in meta.
        """
        s = self.settings
        osname = {"Linux": "linux", "Darwin": "mac", "Windows": "windows"}[
            platform.system()
        ]
        url = ADOPTIUM_API.format(
            ver=s.java_temp_version, hotspot="hotspot", arch=s.java_temp_arch, os=osname
        )
        import httpx

        with httpx.Client(timeout=60) as client:
            resp = client.get(url)
            resp.raise_for_status()
            assets = resp.json()
        if not assets:
            raise internal(
                f"Adoptium API returned no JRE {s.java_temp_version} for {osname}/{s.java_temp_arch}",
                "java_download_failed",
            )
        link = assets[0]["binary"]["package"]["link"]
        ext = ".zip" if osname == "windows" else ".tar.gz"
        jre_dir = s.runtime_dir / f"jre-{s.java_temp_version}"
        jre_dir.parent.mkdir(parents=True, exist_ok=True)
        pkg = jre_dir.parent / f"jre{ext}"
        netdl.download_to(link, pkg, s.download_max_bytes, progress_cb=progress)
        from .jarutil import InvalidJar

        try:
            _extract_archive(pkg, jre_dir.parent)
        finally:
            pkg.unlink(missing_ok=True)
        # Adoptium archives contain a top-level dir like jdk-21.0.5+11-jre/
        entries = [d for d in jre_dir.parent.iterdir() if d.is_dir() and d.name != f"jre-{s.java_temp_version}"]
        if not entries:
            raise internal("JRE extraction produced no directories", "java_download_failed")
        entries[0].rename(jre_dir)
        java_bin = jre_dir / "bin" / ("java.exe" if osname == "windows" else "java")
        if not java_bin.exists():
            raise internal("downloaded JRE has no java binary", "java_download_failed")
        self.store.set_meta("java_runtime", str(java_bin))
        log.info("downloaded JRE %s -> %s", s.java_temp_version, jre_dir)
        return java_bin

    # ---------------------------------------------------------------- install

    def ensure_provisioned(self) -> None:
        """Idempotently provision the server dir; safe to call on every boot."""
        s = self.settings
        ensure_dir(s.data_dir)
        ensure_dir(s.server_dir)
        ensure_dir(s.pack_dir)
        ensure_dir(s.staging_dir)
        ensure_dir(s.backups_dir)
        ensure_dir(s.logs_dir)
        if self.is_provisioned():
            log.info("server already provisioned at %s", s.server_dir)
            return
        with self._install_lock:
            if self.is_provisioned():
                return
            self._install_server()

    def _install_server(self) -> None:
        s = self.settings
        if s.test_server_cmd is not None:
            # Test mode: skip the real NeoForge installer entirely. Tests use a
            # fake MC process and never need the real server artifacts.
            log.warning("TEST MODE: skipping NeoForge installer")
            self._write_defaults()
            self.store.set_meta("installed_mc_version", s.mc_version)
            self.store.set_meta("installed_neoforge_version", s.neoforge_version)
            return
        log.info("installing NeoForge server %s (MC %s)", s.neoforge_version, s.mc_version)
        java = self._java_for_install()
        installer_url = NEOFORGE_INSTALLER_URL.format(v=s.neoforge_version)
        tmp = tempfile.mkdtemp(prefix="mcsp-install-")
        installer_path = Path(tmp) / "neoforge-installer.jar"
        try:
            netdl.download_to(installer_url, installer_path, s.download_max_bytes)
            from .jarutil import check_zip_safety

            check_zip_safety(installer_path)
            cmd = [
                str(java),
                "-jar",
                str(installer_path),
                "--installServer",
                str(s.server_dir),
            ]
            log.info("running installer: %s", " ".join(cmd))
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=1200, cwd=str(s.server_dir)
            )
            if proc.returncode != 0:
                log.error("installer stderr tail: %s", proc.stderr[-2000:])
                raise internal(
                    f"NeoForge installer failed (exit {proc.returncode})",
                    "installer_failed",
                    stderr_tail=proc.stderr[-1000:],
                )
            self._write_defaults()
            self.store.set_meta("installed_mc_version", s.mc_version)
            self.store.set_meta("installed_neoforge_version", s.neoforge_version)
            log.info("server install complete")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def _java_for_install(self) -> Path:
        s = self.settings
        sys_java = shutil.which("java")
        if sys_java:
            return Path(sys_java)
        jre_dir = s.runtime_dir / f"jre-{s.java_temp_version}"
        java_bin = jre_dir / "bin" / "java"
        if java_bin.exists():
            return java_bin
        raise internal(
            "No Java runtime available for the NeoForge installer. The Docker "
            "image bundles one; on bare metal, install Java 21 and retry.",
            "java_missing",
        )

    def _write_defaults(self) -> None:
        """Create eula.txt, a default server.properties, and patch run.sh memory."""
        s = self.settings
        if s.accept_eula:
            atomic_write(
                s.server_dir / "eula.txt",
                b"eula=true\n# accepted by MCSP deployment (MCSP_ACCEPT_EULA=1)\n",
            )
        else:
            atomic_write(
                s.server_dir / "eula.txt",
                b"eula=false\n# MCSP_ACCEPT_EULA=0: accept the Mojang EULA manually.\n",
            )
        props = s.server_dir / "server.properties"
        if not props.exists():
            atomic_write(
                props,
                (
                    f"server-port={s.mc_port}\n"
                    "server-ip=0.0.0.0\n"
                    "online-mode=true\n"
                    "enable-rcon=false\n"
                    "level-type=minecraft\\:normal\n"
                    "max-players=20\n"
                    "motd=MCSP managed server\n"
                ).encode("utf-8"),
            )
        run_sh = s.server_dir / "run.sh"
        if run_sh.exists():
            text = run_sh.read_text(encoding="utf-8", errors="replace")
            patched = text.replace("-Xmx4096M", f"-Xmx{s.mem_gb * 1024}M")
            patched = patched.replace("-Xmx4G", f"-Xmx{s.mem_gb}G")
            if patched != text:
                atomic_write(run_sh, patched.encode("utf-8"))


class ManifestStore:
    """Loads/saves the published pack manifest with atomic writes.

    The manifest is the backend's *own* document: it describes the pack, not the
    state of the Minecraft install. So it is published from the very first
    request, independently of provisioning — a deployment that has not published
    one yet (fresh install, provisioning still running, provisioning failed) is
    served the empty default pack instead of ``null``. Clients treat a missing
    manifest as an invalid one and block sync/launch, so "nothing published yet"
    must never look like a broken pack.
    """

    def __init__(self, settings) -> None:
        self.settings = settings
        self.path = settings.pack_dir / "manifest.json"

    def load(self) -> dict:
        try:
            data = read_json(self.path)
        except FileNotFoundError:
            return {}
        return data

    def default_manifest(self) -> dict:
        """The empty format-v1 pack every deployment starts from."""
        from .models import LOADER, MANIFEST_FORMAT_VERSION

        s = self.settings
        return {
            "formatVersion": MANIFEST_FORMAT_VERSION,
            "loader": LOADER,
            "loaderVersion": s.neoforge_version,
            "minecraftVersion": s.mc_version,
            "mods": [],
            "restartRequired": False,
        }

    def ensure_default(self) -> None:
        """Publish the default (empty) pack unless a manifest already exists."""
        if self.path.exists():
            return
        ensure_dir(self.settings.pack_dir)
        self.save(self.default_manifest())

    def load_manifest(self):
        """The published manifest. Never ``None``.

        A missing file is (re)published as the empty default pack, so ``GET /pack``
        can never answer ``{"manifest": null}``. A file that exists but does not
        parse/validate raises one clear, actionable error instead of a pydantic
        traceback — and it is deliberately *not* replaced by the empty default,
        because an empty manifest would make clients sweep their installed mods.
        """
        from .errors import internal
        from .models import Manifest

        if not self.path.exists():
            log.warning("no pack manifest at %s; publishing the empty default pack", self.path)
            self.ensure_default()
        try:
            return Manifest.model_validate(read_json(self.path))
        except FileNotFoundError:
            # Lost between the check and the read (e.g. an operator deleted it).
            self.ensure_default()
            return Manifest.model_validate(read_json(self.path))
        except Exception as e:
            log.exception("published pack manifest is unreadable: %s", self.path)
            raise internal(
                f"the published pack manifest at {self.path} is not a valid MCSP "
                f"manifest ({e}); fix it or delete the file to republish the empty "
                f"default pack",
                "manifest_corrupt",
                path=str(self.path),
            )

    def save(self, manifest_dict: dict) -> None:
        manifest_dict["updatedAt"] = datetime.now(timezone.utc).isoformat()
        atomic_write_json(self.path, manifest_dict)

    def save_manifest(self, manifest) -> None:
        self.save(manifest.model_dump())


def _extract_archive(archive: Path, dest: Path) -> None:
    """Safely extract tar.gz/zip into *dest* with traversal protection."""
    if archive.name.endswith(".zip"):
        import zipfile

        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                # Raises PermissionError if the entry would escape dest.
                from .safeio import resolve_within

                resolve_within(dest, info.filename)
            zf.extractall(dest)
    else:
        import tarfile

        with tarfile.open(archive) as tf:
            from .safeio import resolve_within

            for member in tf.getmembers():
                if member.issym() or member.islnk():
                    # Only allow links that stay inside dest.
                    from .safeio import resolve_within

                    resolve_within(dest, member.name)
                else:
                    resolve_within(dest, member.name)
            tf.extractall(dest)
