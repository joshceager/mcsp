"""Thread that drains a subprocess stdout/stderr into a bounded ring buffer."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from pathlib import Path

log = logging.getLogger("mcsp.linereader")


class LineRing:
    """Bounded in-memory buffer of recent log lines."""

    def __init__(self, maxlen: int = 5000) -> None:
        self._lines: deque[str] = deque(maxlen=maxlen)
        self._lock = threading.Lock()
        self._waiters: list[threading.Event] = []
        self._total = 0

    def append(self, line: str) -> None:
        with self._lock:
            self._lines.append(line)
            self._total += 1
        self._notify()

    def snapshot(self) -> int:
        """A mark for "everything appended so far"; feed it to :meth:`since`.

        Used to scope a read to one server process: the ring is shared between
        every run of the managed server, so a marker like the readiness line
        ("Done (...)") from a *previous* process must never be mistaken for the
        current one's.
        """
        with self._lock:
            return self._total

    def since(self, mark: int) -> list[str]:
        """Lines appended after *mark* (clamped to what the ring still holds)."""
        with self._lock:
            if mark >= self._total:
                return []
            n = min(self._total - mark, len(self._lines))
            return list(self._lines)[-n:] if n else []

    def _notify(self) -> None:
        for ev in list(self._waiters):
            ev.set()

    def tail(self, n: int = 200) -> list[str]:
        with self._lock:
            return list(self._lines)[-n:]

    def wait(self, timeout: float) -> None:
        ev = threading.Event()
        with self._lock:
            self._waiters.append(ev)
        try:
            ev.wait(timeout)
        finally:
            with self._lock:
                try:
                    self._waiters.remove(ev)
                except ValueError:
                    pass


class ProcessLineReader:
    """Reads lines from a process pipe until EOF, mirroring into files + ring."""

    def __init__(self, stream, ring: LineRing, mirror_path: Path, prefix: str = "") -> None:
        self._stream = stream
        self._ring = ring
        self._mirror_path = mirror_path
        self._prefix = prefix
        self._fh = None
        self._thread = threading.Thread(target=self._run, daemon=True, name="mcsp-linereader")

    def start(self) -> None:
        self._mirror_path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self._mirror_path, "a", encoding="utf-8", errors="replace")
        self._thread.start()

    def _run(self) -> None:
        try:
            for raw in self._stream:
                if isinstance(raw, bytes):
                    line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                else:
                    line = str(raw).rstrip("\r\n")
                stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
                out = f"{stamp} {self._prefix}{line}"
                self._ring.append(out)
                if self._fh:
                    self._fh.write(out + "\n")
                    self._fh.flush()
        except Exception:
            log.exception("line reader died")
        finally:
            try:
                if self._fh:
                    self._fh.close()
            except OSError:
                pass
            self._ring.append(f"--- {self._prefix}stream closed ---")

    def join(self, timeout: float = 5.0) -> None:
        self._thread.join(timeout)
