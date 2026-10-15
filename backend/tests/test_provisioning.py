"""The install tree is verified, never assumed from a marker file.

Regression: `is_provisioned()` used to be exactly `run.sh exists`. The NeoForge
installer writes the launch scripts *before* it finishes patching the Minecraft
jar, so an interrupted install (container restart, installer killed, installer
timed out, out of disk) left a tree that could never start. The backend then
skipped the installer forever and auto-restarted the doomed JVM — the real
failure being FML's

    java.util.NoSuchElementException: No value present
      at ...CommonLaunchHandler.runTarget(CommonLaunchHandler.java:136)

i.e. `layer.findModule("minecraft").orElseThrow()` with no `minecraft` module on
the module path (the patched Minecraft jar is missing).
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
NEOFORGE = "21.1.259"
SRG = "libraries/net/minecraft/server/1.21.1-20240808.144430/server-1.21.1-20240808.144430-srg.jar"
UNIX_ARGS = f"libraries/net/neoforged/neoforge/{NEOFORGE}/unix_args.txt"


def bootstrap_for(settings_factory, **env):
    from app.bootstrap import Bootstrap
    from app.store import Store

    # MCSP_TEST_SERVER_CMD="" -> real (non-stub) settings, so provisioning applies.
    settings = settings_factory(MCSP_TEST_SERVER_CMD="", **env)
    store = Store(settings.db_path)
    return settings, store, Bootstrap(settings, store)


def write_launch_scripts(settings, *, srg_jar: bool, universal_jar: bool = True) -> None:
    """A NeoForge server tree, minus whatever the caller wants to be missing."""
    server = settings.server_dir
    (server / "libraries/net/neoforged/neoforge" / NEOFORGE).mkdir(parents=True, exist_ok=True)
    (server / "run.sh").write_text(
        "#!/usr/bin/env sh\n"
        "java @user_jvm_args.txt @libraries/net/neoforged/neoforge/"
        f"{NEOFORGE}/unix_args.txt \"$@\"\n",
        encoding="utf-8",
    )
    (server / "user_jvm_args.txt").write_text("# Add custom JVM arguments here\n", encoding="utf-8")
    module_path = [UNIX_ARGS.replace("unix_args.txt", "neoforge-" + NEOFORGE + "-universal.jar")]
    if universal_jar:
        (server / module_path[0]).write_bytes(b"jar")
    module_path.append(SRG)
    (server / UNIX_ARGS).write_text("-p " + ":".join(module_path) + "\n", encoding="utf-8")
    if srg_jar:
        (server / SRG).parent.mkdir(parents=True, exist_ok=True)
        (server / SRG).write_bytes(b"jar")  # the jar that carries the `minecraft` module


def test_an_interrupted_install_is_detected_and_names_the_missing_artifact(settings_factory):
    settings, store, bs = bootstrap_for(settings_factory)
    write_launch_scripts(settings, srg_jar=False)  # killed before the MC jar was patched

    assert not bs.is_provisioned()
    problem = bs.provisioning_problem()
    assert problem and "incomplete" in problem
    assert SRG in problem, problem


def test_ensure_provisioned_repairs_an_incomplete_install(settings_factory, monkeypatch):
    settings, store, bs = bootstrap_for(settings_factory)
    write_launch_scripts(settings, srg_jar=False)
    calls: list[int] = []

    def fake_install() -> None:
        calls.append(1)
        write_launch_scripts(settings, srg_jar=True)  # the installer finished this time
        bs.store.set_meta("installed_mc_version", settings.mc_version)
        bs.store.set_meta("installed_neoforge_version", settings.neoforge_version)

    monkeypatch.setattr(bs, "_install_server", fake_install)

    bs.ensure_provisioned()
    assert calls == [1], "the broken install was trusted instead of being repaired"
    assert bs.provisioning_problem() is None

    bs.ensure_provisioned()  # a healthy install is left alone
    assert calls == [1]


def test_a_healthy_install_is_left_alone(settings_factory, monkeypatch):
    settings, store, bs = bootstrap_for(settings_factory)
    write_launch_scripts(settings, srg_jar=True)
    bs.store.set_meta("installed_mc_version", settings.mc_version)
    bs.store.set_meta("installed_neoforge_version", settings.neoforge_version)

    def boom() -> None:
        raise AssertionError("the installer must not run for a complete install")

    monkeypatch.setattr(bs, "_install_server", boom)
    bs.ensure_provisioned()
    assert bs.is_provisioned()


def test_a_version_change_reinstalls(settings_factory):
    settings, store, bs = bootstrap_for(settings_factory)
    write_launch_scripts(settings, srg_jar=True)
    bs.store.set_meta("installed_mc_version", settings.mc_version)
    bs.store.set_meta("installed_neoforge_version", "21.1.100")  # older than requested

    problem = bs.provisioning_problem()
    assert problem and "21.1.100" in problem, problem


def test_installer_exiting_zero_without_artifacts_fails_loudly(settings_factory, monkeypatch):
    """A "successful" installer that left nothing usable must not be trusted."""
    from app import bootstrap as bootstrap_mod
    from app.errors import ApiError

    settings, store, bs = bootstrap_for(settings_factory)

    class Done:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(bootstrap_mod, "NEOFORGE_INSTALLER_URL", "http://127.0.0.1:1/never")
    monkeypatch.setattr(bs, "_java_for_install", lambda: Path("/bin/true"))
    monkeypatch.setattr(bootstrap_mod.netdl, "download_to", lambda *a, **k: None)
    monkeypatch.setattr("app.jarutil.check_zip_safety", lambda *a, **k: None)
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Done())

    with pytest.raises(ApiError) as err:
        bs._install_server()
    assert err.value.code == "install_incomplete"
    assert "not installed" in err.value.message


def test_installer_timeout_is_reported_as_incomplete(settings_factory, monkeypatch):
    from app import bootstrap as bootstrap_mod
    from app.errors import ApiError

    settings, store, bs = bootstrap_for(settings_factory, MCSP_INSTALL_TIMEOUT_S="7")

    def time_out(*a, **k):
        raise subprocess.TimeoutExpired(cmd="installer", timeout=7)

    monkeypatch.setattr(bs, "_java_for_install", lambda: Path("/bin/true"))
    monkeypatch.setattr(bootstrap_mod.netdl, "download_to", lambda *a, **k: None)
    monkeypatch.setattr("app.jarutil.check_zip_safety", lambda *a, **k: None)
    monkeypatch.setattr(subprocess, "run", time_out)

    with pytest.raises(ApiError) as err:
        bs._install_server()
    assert err.value.code == "installer_timeout"
    assert "7s" in err.value.message


def test_memory_setting_reaches_the_launcher(settings_factory):
    """MCSP_MEM_GB used to patch a -Xmx that modern run.sh does not contain."""
    settings, store, bs = bootstrap_for(settings_factory, MCSP_MEM_GB="6")
    server = settings.server_dir
    (server / "libraries/net/neoforged/neoforge" / NEOFORGE).mkdir(parents=True, exist_ok=True)
    (server / "run.sh").write_text(
        "#!/usr/bin/env sh\n"
        f"java @user_jvm_args.txt @libraries/net/neoforged/neoforge/{NEOFORGE}/unix_args.txt \"$@\"\n",
        encoding="utf-8",
    )
    (server / "user_jvm_args.txt").write_text(
        "# Add custom JVM arguments (such as -Xmx6G) here\n-Xmx2G\n", encoding="utf-8"
    )

    bs._write_defaults()

    lines = (server / "user_jvm_args.txt").read_text(encoding="utf-8").splitlines()
    heap = [l for l in lines if l.strip().startswith("-Xmx")]
    assert heap == ["-Xmx6G"], lines
    assert (server / "eula.txt").read_text(encoding="utf-8").startswith("eula=true")
