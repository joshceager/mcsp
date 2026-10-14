"""MinecraftServerSupervisor: owns the real Minecraft server process.

Responsibilities (from the approved design):
- start / stop / restart the server process it manages
- detect state transitions: starting -> running (on the server's own "Done"
  log line) -> stopping -> stopped; unexpected exit -> error
- auto-restart with capped backoff when enabled (approved default: on)
- capture logs (ring buffer + mirrored files) and expose status
- forward console commands to the running process's stdin
- serialize lifecycle operations so overlapping ops cannot corrupt state

The supervisor is process-based and thread-safe; FastAPI routes call into it
from the threadpool.
"""

from __future__ import annotations

import logging
import os
import platform
import signal
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .linereader import LineRing, ProcessLineReader
from .models import ServerStatus

log = logging.getLogger("mcsp.supervisor")

STATE_INSTALLING = "installing"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MinecraftServerSupervisor:
    def __init__(self, settings, bootstrap, on_state_change=None) -> None:
        self.settings = settings
        self.bootstrap = bootstrap
        self.on_state_change = on_state_change  # callback(dict) for SSE/status
        self._lock = threading.RLock()
        self._state = "stopped"
        self._state_since = _now()
        self._proc: subprocess.Popen | None = None
        self._stdin = None
        self._ring = LineRing(maxlen=8000)
        self._readers: list[ProcessLineReader] = []
        self._started_at: str | None = None
        self._pid: int | None = None
        self._stop_requested = False
        self._graceful_stop_seen = False
        self._auto_restart_count = 0
        self._auto_restart_thread: threading.Thread | None = None
        self._last_error: str | None = None
        self._installing_message: str | None = None
        self._closed = False

    # ------------------------------------------------------------------ state

    def status(self) -> ServerStatus:
        with self._lock:
            return ServerStatus(
                state=self._state,
                pid=self._pid,
                startedAt=self._started_at,
                restartRequired=self.pack_restart_required(),
                pendingRestart=self._state in ("running", "starting")
                and self.pack_restart_required(),
                autoRestartCount=self._auto_restart_count,
                joinAddress=self.settings.join_address,
                joinPort=self.settings.mc_port,
                apiPort=self.settings.api_port,
                adminEnabled=self.settings.admin_configured,
                managerEnabled=self.settings.admin_configured,
                installedMcVersion=self.settings.mc_version,
                installedLoader="neoforge",
                installedLoaderVersion=self.settings.neoforge_version,
            )

    def pack_restart_required(self) -> bool:
        try:
            manifest = self.bootstrap.manifest_store.load()
            return bool(manifest.get("restartRequired", False))
        except Exception:
            return False

    def logs(self, limit: int = 200) -> list[str]:
        return self._ring.tail(limit)

    def wait_for_lines(self, timeout: float = 1.0) -> None:
        self._ring.wait(timeout)

    def _set_state(self, state: str, detail: str | None = None) -> None:
        with self._lock:
            self._state = state
            self._state_since = _now()
            if state == "error":
                self._last_error = detail or self._last_error
            if state == "running":
                self._auto_restart_count = 0
        log.info("state -> %s (%s)", state, detail or "")
        if self.on_state_change:
            try:
                self.on_state_change({"state": state, "detail": detail, "at": _now()})
            except Exception:
                log.exception("state-change callback failed")

    @property
    def state(self) -> str:
        return self._state

    # ------------------------------------------------------------- lifecycle

    def can_start(self) -> tuple[bool, str]:
        with self._lock:
            if self._state == "installing":
                return False, "initial installation is in progress"
            if self._state in ("starting", "running", "stopping"):
                return False, f"server is currently {self._state}"
            return True, "ok"

    def start(self) -> dict:
        """Start the managed Minecraft server. Raises RuntimeError on invalid
        state transitions. Blocking (runs bootstrap + waits for readiness up
        to a bounded time)."""
        ok, why = self.can_start()
        if not ok:
            raise RuntimeError(f"cannot start server: {why}")
        with self._lock:
            self._stop_requested = False
            self._graceful_stop_seen = False
            self._last_error = None
            self._set_state("starting")
        try:
            cmd = self._build_command()
        except Exception as e:
            self._set_state("error", f"bootstrap failed: {e}")
            raise RuntimeError(f"bootstrap failed: {e}") from e
        result = self._spawn(cmd)
        if result.get("state") == "error":
            # Process died during the startup window; fail the start job.
            raise RuntimeError(
                f"server process exited during startup (code {result.get('exitCode')})"
            )
        return result

    def _build_command(self) -> list[str]:
        s = self.settings
        if s.test_server_cmd:
            # Test hook: run a stub "minecraft server" instead of the real JVM.
            return list(s.test_server_cmd)
        # Ensure a Java runtime exists (downloaded on first run if missing).
        self.bootstrap.ensure_java()
        s.server_dir.mkdir(parents=True, exist_ok=True)
        run_sh = s.server_dir / "run.sh"
        if not run_sh.exists():
            raise RuntimeError(
                "server is not installed yet (run.sh missing); bootstrap did not complete"
            )
        # run.sh (created by the NeoForge installer) selects the bundled Java
        # runtime and applies memory settings; 'nogui' disables the bundled GUI.
        return ["bash", str(run_sh), "nogui"]

    def _spawn(self, cmd: list[str]) -> dict:
        s = self.settings
        env = os.environ.copy()
        env.setdefault("MCSP_MANAGED", "1")
        started = time.time()
        log.info("spawning server: %s (cwd=%s)", cmd, s.server_dir)
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(s.server_dir),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                text=True,
                bufsize=1,
            )
        except OSError as e:
            self._set_state("error", f"failed to spawn process: {e}")
            raise RuntimeError(f"failed to spawn process: {e}") from e
        with self._lock:
            self._proc = proc
            self._pid = proc.pid
            self._started_at = _now()
        stamp = time.strftime("%Y%m%d-%H%M%S")
        reader = ProcessLineReader(
            proc.stdout, self._ring, s.logs_dir / f"console-{stamp}.log", prefix="[server] "
        )
        reader.start()
        self._readers.append(reader)
        watcher = threading.Thread(
            target=self._watch, args=(proc, started), daemon=True, name="mcsp-watch"
        )
        watcher.start()
        # Wait (bounded) for the "Done" marker so the API can report truthfully.
        deadline = time.time() + 180
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            for line in self._ring.tail(50):
                if "Done (" in line and "help" in line:
                    self._set_state("running")
                    return {"state": "running", "pid": self._pid}
            time.sleep(0.25)
        if proc.poll() is None:
            # Still alive but no Done yet: it may be a long first boot.
            self._set_state("starting") if self._state == "starting" else None
            return {"state": self._state, "pid": self._pid, "note": "readiness marker not yet seen"}
        # Exited during start window
        code = proc.returncode
        self._set_state("error", f"process exited during startup (code {code})")
        return {"state": "error", "exitCode": code}

    def _watch(self, proc: subprocess.Popen, started: float) -> None:
        """Watch the child; on exit decide stopped vs error and maybe auto-restart."""
        code = proc.wait()
        with self._lock:
            self._proc = None
            self._pid = None
        was_graceful = self._graceful_stop_seen or self._stop_requested
        tail = self._ring.tail(80)
        graceful_text = any("Stopping" in l or "Stopped" in l for l in tail)
        if was_graceful or (code == 0 and graceful_text):
            log.info("server stopped cleanly (code %s)", code)
            self._set_state("stopped")
            return
        detail = f"process exited unexpectedly (code {code})"
        log.warning(detail)
        if self._state == "stopping":
            # We asked for a stop; treat exit as success even if code != 0.
            self._set_state("stopped")
            return
        self._set_state("error", detail)
        if self.settings.auto_restart:
            with self._lock:
                if self._auto_restart_count >= self.settings.auto_restart_max:
                    log.warning("auto-restart limit reached; staying in error")
                    self._ring.append("[mcsp] auto-restart limit reached; manual restart required")
                    return
                self._auto_restart_count += 1
                attempt = self._auto_restart_count
                delay = min(
                    self.settings.auto_restart_backoff_s * (2 ** (attempt - 1)), 300
                )
            self._ring.append(
                f"[mcsp] unexpected exit (code {code}); auto-restart attempt {attempt} in {delay}s"
            )
            t = threading.Thread(target=self._auto_restart, args=(delay,), daemon=True)
            self._auto_restart_thread = t
            t.start()

    def _auto_restart(self, delay: float) -> None:
        time.sleep(delay)
        if self._closed:
            return
        try:
            self.start()
        except Exception as e:
            log.error("auto-restart failed: %s", e)

    def stop(self, timeout: float = 45.0) -> dict:
        """Stop the managed server gracefully: stdin 'stop', then SIGTERM, SIGKILL."""
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                self._set_state("stopped")
                return {"state": "stopped", "note": "server was not running"}
            self._stop_requested = True
            self._set_state("stopping")
            stdin = proc.stdin
        try:
            if stdin:
                stdin.write("stop\n")
                stdin.flush()
        except OSError:
            pass
        try:
            proc.wait(timeout=timeout)
            return {"state": "stopped", "exitCode": proc.returncode}
        except subprocess.TimeoutExpired:
            pass
        log.warning("graceful stop timed out; sending SIGTERM")
        try:
            if platform.system() == "Windows":
                proc.terminate()
            else:
                proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=10)
            return {"state": "stopped", "via": "sigterm"}
        except subprocess.TimeoutExpired:
            pass
        log.error("SIGTERM ignored; sending SIGKILL")
        proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log.error("SIGKILL ignored?!")
        self._set_state("stopped")
        return {"state": "stopped", "via": "sigkill"}

    def restart(self) -> dict:
        state = self.state
        if state == "running" or state == "starting":
            self.stop()
        result = self.start()
        # The freshly started server has loaded the current mod set; the flag
        # is now stale. (Kept in sync with the admin restart-ack endpoint.)
        try:
            m = self.bootstrap.manifest_store.load()
            if m.get("restartRequired"):
                m["restartRequired"] = False
                self.bootstrap.manifest_store.save(m)
        except Exception:
            log.exception("failed to clear restartRequired after restart")
        return result

    def send_console(self, command: str) -> dict:
        """Send a console command line to the running server's stdin."""
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                raise RuntimeError("server is not running; console is unavailable")
            cmd = command.rstrip("\r\n")
            if not cmd:
                raise ValueError("empty command")
            if len(cmd) > 2000:
                raise ValueError("command too long (max 2000 chars)")
            stdin = proc.stdin
        try:
            stdin.write(cmd + "\n")
            stdin.flush()
        except OSError as e:
            raise RuntimeError(f"failed to write to server console: {e}") from e
        self._ring.append(f"[mcsp] console> {cmd}")
        return {"sent": True, "command": cmd}

    def close(self) -> None:
        """Shutdown hook: stop the managed server if we own it."""
        self._closed = True
        with self._lock:
            proc = self._proc
        if proc is not None:
            try:
                self.stop(timeout=30)
            except Exception:
                log.exception("graceful shutdown failed; killing")
                try:
                    proc.kill()
                except OSError:
                    pass
