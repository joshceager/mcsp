"""MinecraftServerSupervisor: owns the real Minecraft server process.

Responsibilities (from the approved design):
- start / stop / restart the server process it manages
- detect state transitions: starting -> running (on the server's own "Done"
  log line) -> stopping -> stopped; unexpected exit -> error
- auto-restart with capped backoff when enabled (approved default: on)
- capture logs (ring buffer + mirrored files) and expose status
- forward console commands to the running process's stdin
- serialize lifecycle operations so overlapping ops cannot corrupt state

Crash policy (why the two exits are treated differently)
- A process that dies *before* it ever reaches readiness is a **startup
  failure**: the install or the configuration is wrong, and retrying the exact
  same command cannot fix it. It is reported once, with the reason and the
  process's own last output, and is *not* auto-restarted. (Restarting it was
  what turned one clear "your install is broken" into an endless crash log.)
- A process that reached readiness and *then* died is a **runtime crash**:
  restarted with capped exponential backoff. The cap counts consecutive
  crashes and is only cleared by an operator start, or once the server has
  stayed up for ``auto_restart_stable_s`` — a server that boots and immediately
  dies therefore still hits the cap instead of looping forever.

Process scoping
Every spawn gets an epoch. The ring buffer is shared by all runs of the server,
so a watcher/monitor belonging to a superseded process must never touch the
current state, pid, or readiness: it returns immediately. Readiness is only
ever read from lines the *current* process appended.

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

# How long start() waits for the readiness marker before answering "still
# starting"; the monitor keeps watching afterwards, so a slow first boot still
# flips to running when it gets there.
READY_TIMEOUT_S = 180.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_ready_line(line: str) -> bool:
    """The server's own "Done (1.234s)! For help, type "help"" readiness line."""
    return "Done (" in line and "help" in line


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
        self._epoch = 0                # increments on every spawn
        self._ready_epoch = -1         # epoch whose process reached readiness
        self._restart_cancel = threading.Event()

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
        """Start the managed server (operator/API initiated)."""
        return self._start(manual=True)

    def _start(self, manual: bool) -> dict:
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
            self._restart_cancel.clear()
            if manual:
                # An operator asked for this start; give the crash budget back.
                self._auto_restart_count = 0
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
                f"server process exited during startup (code {result.get('exitCode')}): "
                f"{self._last_error or 'see the console log'}"
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
            self._epoch += 1
            epoch = self._epoch
        stamp = time.strftime("%Y%m%d-%H%M%S")
        reader = ProcessLineReader(
            proc.stdout, self._ring, s.logs_dir / f"console-{stamp}.log", prefix="[server] "
        )
        reader.start()
        self._readers.append(reader)
        # Everything appended from here on belongs to THIS process.
        mark = self._ring.snapshot()
        ready = threading.Event()      # set when THIS process reaches readiness
        finished = threading.Event()   # set when THIS process exits
        threading.Thread(
            target=self._monitor_readiness,
            args=(proc, epoch, mark, ready),
            daemon=True,
            name="mcsp-ready",
        ).start()
        threading.Thread(
            target=self._watch,
            args=(proc, started, epoch, ready, finished, mark),
            daemon=True,
            name="mcsp-watch",
        ).start()
        # Wait (bounded) for the readiness marker so the API can report
        # truthfully — but wake up immediately if the process exits first. The
        # monitor keeps watching past this point, so a long first boot still
        # becomes "running" when it actually gets there.
        deadline = time.time() + READY_TIMEOUT_S
        while time.time() < deadline and not ready.is_set() and not finished.is_set():
            time.sleep(0.05)
        if proc.poll() is not None:
            return {"state": "error", "exitCode": proc.returncode}
        if ready.is_set():
            return {"state": "running", "pid": self._pid}
        return {
            "state": self._state,
            "pid": self._pid,
            "note": "readiness marker not yet seen",
        }

    def _monitor_readiness(
        self, proc: subprocess.Popen, epoch: int, mark: int, ready: threading.Event
    ) -> None:
        """Flip to running on the readiness line produced by *this* process."""
        while True:
            with self._lock:
                if self._epoch != epoch or self._closed:
                    return
            if proc.poll() is not None:
                return
            for line in self._ring.since(mark):
                if _is_ready_line(line):
                    with self._lock:
                        if self._epoch != epoch:
                            return
                        self._ready_epoch = epoch
                    self._set_state("running")
                    ready.set()
                    return
            time.sleep(0.25)

    def _watch(
        self,
        proc: subprocess.Popen,
        started: float,
        epoch: int,
        ready: threading.Event,
        finished: threading.Event,
        mark: int,
    ) -> None:
        """Watch one child process; on exit decide stopped vs startup-failure vs
        runtime crash and maybe auto-restart."""
        code = proc.wait()
        finished.set()
        with self._lock:
            if self._epoch != epoch:
                # Superseded by a newer process (restart): its watcher owns the
                # state and the pid now. Touching them here is what used to mark
                # a freshly restarted server as crashed/stopped and orphan it.
                log.info("ignoring exit of superseded server process (pid %s)", proc.pid)
                return
            if self._proc is proc:
                self._proc = None
                self._pid = None
            stop_requested = self._stop_requested
            state = self._state
        was_graceful = self._graceful_stop_seen or stop_requested
        tail = self._ring.tail(80)
        graceful_text = any("Stopping" in l or "Stopped" in l for l in tail)
        if was_graceful or (code == 0 and graceful_text) or state == "stopping":
            log.info("server stopped cleanly (code %s)", code)
            self._set_state("stopped")
            return
        uptime = time.time() - started
        if not (ready.is_set() or self._ready_epoch == epoch):
            self._report_startup_failure(proc, code, uptime, mark)
            return
        self._report_crash(code, uptime, started)

    def _report_startup_failure(
        self, proc: subprocess.Popen, code: int | None, uptime: float, mark: int
    ) -> None:
        """The process died before it ever became ready: retrying cannot help."""
        detail = f"server exited during startup (code {code}) after {uptime:.1f}s"
        problem = self._provisioning_problem()
        if problem:
            detail += f"; {problem}"
        output = self._last_output(mark)
        if output:
            detail += f"; last output: {output}"
        log.error(detail)
        self._ring.append(f"[mcsp] {detail}")
        self._ring.append(
            "[mcsp] not auto-restarting: the server never reached readiness, so the "
            "same start would fail again. Fix the install/configuration and start it "
            "again (see /api/v1/status + the console log above)."
        )
        self._set_state("error", detail)

    def _report_crash(self, code: int | None, uptime: float, started: float) -> None:
        detail = f"process exited unexpectedly (code {code}) after {uptime:.1f}s"
        log.warning(detail)
        self._set_state("error", detail)
        if not self.settings.auto_restart:
            return
        with self._lock:
            if uptime >= self.settings.auto_restart_stable_s:
                # It had been up long enough to count as healthy; fresh budget.
                self._auto_restart_count = 0
            if self._auto_restart_count >= self.settings.auto_restart_max:
                log.warning("auto-restart limit reached; staying in error")
                self._ring.append(
                    f"[mcsp] auto-restart limit reached "
                    f"({self.settings.auto_restart_max} attempts); manual restart required"
                )
                return
            self._auto_restart_count += 1
            attempt = self._auto_restart_count
            delay = min(self.settings.auto_restart_backoff_s * (2 ** (attempt - 1)), 300)
            self._restart_cancel.clear()
        self._ring.append(
            f"[mcsp] unexpected exit (code {code}); auto-restart attempt {attempt} in {delay}s"
        )
        t = threading.Thread(target=self._auto_restart, args=(delay,), daemon=True)
        self._auto_restart_thread = t
        t.start()

    def _provisioning_problem(self) -> str | None:
        """Why the managed server cannot start, according to the bootstrap."""
        try:
            return self.bootstrap.provisioning_problem()
        except Exception:
            log.exception("could not evaluate the server install")
            return None

    def _last_output(self, mark: int, limit: int = 3) -> str:
        """The last few lines this process produced (its own, not a stale run's)."""
        lines = [l.split("[server] ", 1)[-1].strip() for l in self._ring.since(mark)]
        lines = [l for l in lines if l and not l.startswith("[mcsp]")]
        return " | ".join(lines[-limit:])[:500]

    def _auto_restart(self, delay: float) -> None:
        # An operator Stop during the backoff must win: it cancels the restart
        # instead of letting the server come back to life and crash again.
        if self._restart_cancel.wait(delay):
            log.info("auto-restart cancelled (stop requested)")
            return
        if self._closed:
            return
        with self._lock:
            if self._stop_requested:
                log.info("auto-restart skipped: stop requested")
                return
        try:
            self._start(manual=False)
        except Exception as e:
            log.error("auto-restart failed: %s", e)

    def stop(self, timeout: float = 45.0) -> dict:
        """Stop the managed server gracefully: stdin 'stop', then SIGTERM, SIGKILL."""
        with self._lock:
            self._restart_cancel.set()  # a pending auto-restart must not resurrect it
            proc = self._proc
            if proc is None or proc.poll() is not None:
                self._stop_requested = True
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
        result = self._start(manual=True)
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
        self._restart_cancel.set()
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
