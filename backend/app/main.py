"""MCSP backend entrypoint: FastAPI app + managed Minecraft server.

Deployment (approved): one container; the backend supervises the Minecraft
JVM as a child process and owns its lifecycle. Zero app-specific configuration
for a basic deployment: defaults below, overridable via MCSP_* env vars.
"""

from __future__ import annotations

import logging
import threading

import anyio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .bootstrap import Bootstrap
from .config import Settings
from .errors import ApiError
from .jobs import JobQueue
from .models import MANIFEST_FORMAT_VERSION
from .packmgr import PackManager
from .routes import admin, public
from .serverctl import ServerControl
from .store import Store
from .supervisor import MinecraftServerSupervisor

log = logging.getLogger("mcsp")


def _setup_logging(settings: Settings) -> None:
    settings.logs_dir.mkdir(parents=True, exist_ok=True)
    handlers = [logging.StreamHandler()]
    try:
        handlers.append(logging.FileHandler(settings.backend_log_path, encoding="utf-8"))
    except OSError:
        pass
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    _setup_logging(settings)
    app = FastAPI(title="MCSP backend", version="0.1.0", lifespan=_lifespan)
    app.state.settings = settings
    app.state.settings_ready = False

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(
            status_code=exc.status,
            content={"error": exc.code, "message": exc.message, "details": exc.details},
        )

    return app


async def _lifespan(app: FastAPI):
    settings = app.state.settings
    log.info("MCSP backend starting; data dir %s", settings.data_dir)

    # sse-starlette awaits a *module-global* shutdown Event inside every SSE
    # response, and creates it lazily in whichever event loop happens to serve
    # the first stream. Any second event loop in the same process (a --reload
    # restart, TestClient, a test that boots a second server) would then await
    # an Event owned by a dead loop and abort the stream with
    # "RuntimeError: ... is bound to a different event loop", which the client
    # can only see as a truncated response. Bind it here instead, inside the
    # loop that will actually serve the streams.
    from sse_starlette.sse import AppStatus

    AppStatus.should_exit = False
    AppStatus.should_exit_event = anyio.Event()

    store = Store(settings.db_path)
    app.state.store = store
    bootstrap = Bootstrap(settings, store)
    app.state.bootstrap = bootstrap
    app.state.manifest_store = bootstrap.manifest_store

    # Publish the pack manifest *now*, before the first request: it is the
    # backend's own document (it describes the pack, not the install) and clients
    # must never receive `manifest: null`, which they can only read as a corrupt
    # pack. Provisioning (a slow, network-bound install that can also fail) must
    # not gate it.
    bootstrap.manifest_store.ensure_default()

    supervisor = MinecraftServerSupervisor(settings, bootstrap)
    app.state.supervisor = supervisor
    jobs = JobQueue(store)
    app.state.job_queue = jobs
    packmgr = PackManager(settings, bootstrap.manifest_store, supervisor)
    app.state.packmgr = packmgr
    app.state.control = ServerControl(settings, supervisor, jobs, packmgr)
    app.state.serverctl = app.state.control  # alias used by admin routes

    app.include_router(public.router, prefix="/api/v1")
    app.include_router(admin.router, prefix="/api/v1")

    @app.get("/api/v1/health")
    def health():
        return {
            "ok": True,
            "service": "mcsp-backend",
            "version": MANIFEST_FORMAT_VERSION,
            "adminEnabled": settings.admin_configured,
        }

    # ---- provisioning (blocking, in a worker thread) ------------------------
    def provision_and_autostart():
        try:
            bootstrap.ensure_provisioned()
            app.state.settings_ready = True
        except Exception:
            log.exception("provisioning failed; server will stay stopped")
            # The pack stays published and servable even when the install failed:
            # the reason is reported through /status + the logs, not by breaking
            # every client-side pack operation.
            bootstrap.manifest_store.ensure_default()
            supervisor._set_state("error", "initial provisioning failed; see backend logs")
            return
        if settings.auto_start and supervisor.state in ("stopped", "error"):
            log.info("auto-starting managed Minecraft server")
            try:
                supervisor.start()
            except Exception:
                log.exception("initial auto-start failed")

    threading.Thread(target=provision_and_autostart, daemon=True, name="mcsp-provision").start()

    try:
        yield
    finally:
        log.info("shutting down; stopping managed server")
        supervisor.close()
