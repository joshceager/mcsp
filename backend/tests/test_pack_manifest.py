"""The published pack manifest must always be a complete, valid format-v1 pack.

Regression guard: the manifest used to be written only as the *last* step of
first-boot provisioning, and `ManifestStore.load_manifest()` returned `None`
while no file existed yet. So every deployment that had not finished
provisioning — or whose provisioning failed (no network to the NeoForge maven,
no Java, a full disk, an installer error) — answered
`GET /api/v1/pack` with `{"manifest": null}`. The desktop client can only read
that as a corrupt pack and blocked every pack operation with

    the server's pack manifest is invalid: manifest is not a JSON object

...i.e. the real cause (the install) was reported as a broken pack, and it never
healed on its own. The manifest is the backend's own document: it is published
from the first request on, and it is never `null`.
"""

from __future__ import annotations

import time

RULES = (
    "the same rules the desktop client enforces before it will sync or launch "
    "(src/shared/manifest-validate.ts)"
)


def valid_default_manifest(m, settings) -> None:
    """Assert *m* is exactly what the client accepts as a usable empty pack."""
    assert isinstance(m, dict), f"manifest must be an object — {RULES}"
    assert m["formatVersion"] == 1, RULES
    for key in ("loader", "loaderVersion", "minecraftVersion"):
        assert isinstance(m.get(key), str) and m[key], f"{key} missing/empty — {RULES}"
    assert m["loader"] == "neoforge"
    assert m["loaderVersion"] == settings.neoforge_version
    assert m["minecraftVersion"] == settings.mc_version
    assert m["mods"] == []
    assert m["restartRequired"] is False


def manifest_path(app):
    return app.state.settings.pack_dir / "manifest.json"


def test_pack_never_answers_null_when_provisioning_fails(settings_factory, monkeypatch):
    """A first boot whose install blows up still serves a valid (empty) pack."""
    from fastapi.testclient import TestClient

    from app import bootstrap as bootstrap_module
    from app.main import create_app

    def explode(self):
        raise RuntimeError("NeoForge installer exploded (simulated)")

    monkeypatch.setattr(bootstrap_module.Bootstrap, "ensure_provisioned", explode)
    settings = settings_factory(MCSP_ADMIN_KEY="test-admin-key-123")
    app = create_app(settings)
    with TestClient(app) as c:
        deadline = time.time() + 10
        while time.time() < deadline and app.state.supervisor.state != "error":
            time.sleep(0.05)
        assert app.state.supervisor.state == "error", "the failed install must be visible"
        assert app.state.settings_ready is False

        r = c.get("/api/v1/pack")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["manifest"] is not None, "clients read null as a corrupt pack"
        valid_default_manifest(body["manifest"], settings)
        assert manifest_path(app).exists(), "the manifest must be on disk, not synthesized"
        assert body["installedFiles"] == []
        assert body["installed"] == []
        # the failure is reported honestly, where the client can see it
        assert c.get("/api/v1/status").json()["state"] == "error"


def test_pack_is_published_from_startup_even_mid_provisioning(client):
    """Provisioning takes minutes; the pack must be servable while it runs."""
    c, app = client
    assert app.state.settings_ready is True  # provisioning (stub) finished
    valid_default_manifest(c.get("/api/v1/pack").json()["manifest"], app.state.settings)
    assert manifest_path(app).exists()


def test_missing_manifest_is_republished_not_answered_with_null(client):
    """An operator deleting the file (or losing it) must not brick the client."""
    c, app = client
    manifest_path(app).unlink()

    r = c.get("/api/v1/pack")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["manifest"] is not None
    valid_default_manifest(body["manifest"], app.state.settings)
    assert manifest_path(app).exists(), "the default pack is persisted, not just returned"


def test_corrupt_manifest_reports_a_clear_error_and_is_not_emptied(client):
    """A corrupt manifest is an operator problem, not a silently empty pack.

    Replacing it with the empty default would be worse than failing: every client
    would then treat its locally installed mods as stale and sweep them.
    """
    c, app = client
    path = manifest_path(app)
    path.write_text("{ not json at all", encoding="utf-8")

    r = c.get("/api/v1/pack")
    assert r.status_code == 500, r.text
    body = r.json()
    assert body["error"] == "manifest_corrupt"
    assert "manifest.json" in body["message"]
    assert path.read_text(encoding="utf-8") == "{ not json at all"
