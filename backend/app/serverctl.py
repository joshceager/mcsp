"""ServerControl: lifecycle + pack operations submitted to the job queue.

All long-running operations (start/stop/restart, mod add/update/remove) run as
serialized jobs so overlapping admin requests can never corrupt state. The
backend auto-starts the server when the deployment starts (approved).
"""

from __future__ import annotations

import logging

from .errors import conflict, internal
from .jobs import JobQueue
from .packmgr import PackManager
from .supervisor import MinecraftServerSupervisor

log = logging.getLogger("mcsp.serverctl")


class ServerControl:
    def __init__(self, settings, supervisor, jobs: JobQueue, packmgr: PackManager) -> None:
        self.settings = settings
        self.supervisor = supervisor
        self.jobs = jobs
        self.packmgr = packmgr

    # ------------------------------------------------------------- lifecycle

    def start_server(self) -> dict:
        return self.jobs.submit(
            "server.start", self.supervisor.start, queue_ok=False
        )

    def stop_server(self) -> dict:
        return self.jobs.submit(
            "server.stop", self.supervisor.stop, queue_ok=False
        )

    def restart_server(self) -> dict:
        return self.jobs.submit(
            "server.restart", self.supervisor.restart, queue_ok=False
        )

    # ------------------------------------------------------------- pack ops

    def add_mod(self, req) -> dict:
        return self.jobs.submit("pack.add", lambda: self.packmgr.add_mod(req))

    def update_mod(self, mod_id: str, req) -> dict:
        return self.jobs.submit("pack.update", lambda: self.packmgr.update_mod(mod_id, req))

    def remove_mod(self, mod_id: str) -> dict:
        return self.jobs.submit("pack.remove", lambda: self.packmgr.remove_mod(mod_id))

    # ------------------------------------------------------------- restarts

    def clear_restart_required(self) -> dict:
        """Admin: mark that a restart has been observed (after restart job)."""
        manifest = self.packmgr._current_manifest()
        manifest.restartRequired = False
        self.packmgr.manifest_store.save_manifest(manifest)
        return {"restartRequired": False}
