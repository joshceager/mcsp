"""Backend configuration.

Reads environment variables once at startup. Defaults are chosen so that a
plain ``docker compose up`` produces a working deployment with no extra setup.
"""

from __future__ import annotations

import os
from pathlib import Path


def _bool(env: dict, name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    """Resolved settings for one backend deployment."""

    def __init__(self, env: dict | None = None) -> None:
        env = dict(env if env is not None else os.environ)

        data_dir = Path(env.get("MCSP_DATA_DIR", "/data")).resolve()
        self.data_dir = data_dir
        self.server_dir = data_dir / "server"
        self.pack_dir = data_dir / "pack"
        self.staging_dir = data_dir / "staging"
        self.backups_dir = data_dir / "backups"
        self.logs_dir = data_dir / "logs"
        self.runtime_dir = data_dir / "runtime"
        self.db_path = data_dir / "mcsp.db"
        self.backend_log_path = data_dir / "backend.log"

        # ---- admin auth -------------------------------------------------
        # Fail closed: empty/absent key means ALL admin endpoints are disabled.
        self.admin_key: str = (env.get("MCSP_ADMIN_KEY") or "").strip()

        # ---- managed Minecraft server -----------------------------------
        self.mc_version: str = env.get("MCSP_MC_VERSION", "1.21.1").strip()
        self.neoforge_version: str = env.get("MCSP_NEOFORGE_VERSION", "21.1.259").strip()
        self.accept_eula: bool = _bool(env, "MCSP_ACCEPT_EULA", True)
        self.mc_port: int = int(env.get("MCSP_MC_PORT", "25565"))
        self.mem_gb: int = int(env.get("MCSP_MEM_GB", "4"))
        # Start the managed Minecraft server automatically when the backend
        # deployment starts (approved zero-config behavior).
        self.auto_start: bool = _bool(env, "MCSP_AUTO_START", True)
        self.auto_restart: bool = _bool(env, "MCSP_AUTO_RESTART", True)
        self.auto_restart_max: int = int(env.get("MCSP_AUTO_RESTART_MAX", "5"))
        self.auto_restart_backoff_s: int = int(env.get("MCSP_AUTO_RESTART_BACKOFF_S", "10"))
        # Address players should use to join. If unset, the API omits it and the
        # owner is expected to publish their own host/port.
        self.join_address: str | None = (env.get("MCSP_JOIN_ADDRESS") or "").strip() or None
        self.api_port: int = int(env.get("MCSP_API_PORT", "8080"))

        # Non-ASCII console input is rejected; Minecraft console expects utf-8 lines.
        self.download_timeout_s: int = int(env.get("MCSP_DOWNLOAD_TIMEOUT_S", "120"))
        self.download_max_bytes: int = int(env.get("MCSP_DOWNLOAD_MAX_BYTES", str(512 * 1024 * 1024)))
        self.java_temp_version: str = env.get("MCSP_JAVA_VERSION", "21")
        self.java_temp_flavor: str = env.get("MCSP_JAVA_FLAVOR", "jre")
        self.java_temp_arch: str = env.get("MCSP_JAVA_ARCH", "x64")

        # Test hooks (used by the automated tests; never set in production).
        self.test_server_cmd: list[str] | None = None
        test_cmd = env.get("MCSP_TEST_SERVER_CMD")
        if test_cmd:
            import shlex

            self.test_server_cmd = shlex.split(test_cmd)

    # Manifest loader designation (single loader in MVP; more via new loaders later)
    loader: str = "neoforge"

    @property
    def loader_type(self) -> str:
        return self.loader

    @property
    def admin_configured(self) -> bool:
        return bool(self.admin_key)
