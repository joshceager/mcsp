/** Play tab: pack view, prepare/sync actions, join info, launch + stop.
 *  - "Sync" only syncs mods. Preparing Java/loader/assets is a separate,
 *    explicitly announced action.
 *  - Mod status comes from the real computed sync plan, not a hardcoded string.
 *  - Launch checks the Microsoft session before any provisioning work. */
import { createElement as h, useCallback, useEffect, useMemo, useState } from "react";
import { bridge } from "./bridge";
import type { Manifest, PackView, ProvisionInspection, ServerStatus, SyncPlan } from "./bridge";
import type { Session } from "./App";
import { Banner, Spinner, errorText, fmtBytes, fmtDuration, useEvent, usePoll } from "./ui";

interface Props { session: Session; conn: { id: string; name: string; serverUrl: string } }

interface Progress { active: boolean; lines: string[]; pct: number | null }

export function Play({ session, conn }: Props) {
  const [pack, setPack] = useState<PackView | null>(null);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [inspection, setInspection] = useState<ProvisionInspection | null>(null);
  const [gameDir, setGameDir] = useState("");
  const [busy, setBusy] = useState<"" | "sync" | "prepare" | "launch" | "stop">("");
  const [msg, setMsg] = useState("");
  const [packErr, setPackErr] = useState("");
  const [syncErr, setSyncErr] = useState("");
  const [syncActionErr, setSyncActionErr] = useState("");
  const [launchErr, setLaunchErr] = useState("");
  const [launchMsg, setLaunchMsg] = useState("");
  const [progress, setProgress] = useState<Progress>({ active: false, lines: [], pct: null });

  // live server state (fixes the permanently stale "running" label)
  const status = usePoll<ServerStatus>(() => bridge().server.status(), 3000, [conn.id]);
  const launcher = usePoll(() => bridge().launch.status(conn.id), 3000, [conn.id]);
  const streams = usePoll(() => bridge().stream.subscribe(conn.id, true), 60000, [conn.id]);

  useEvent("provision", (payload) => {
    const p = payload as { connId: string; step: string; message: string; done?: number; total?: number };
    if (p.connId !== conn.id) return;
    setProgress((cur) => ({
      active: true,
      lines: [...cur.lines.slice(-40), `${p.step}: ${p.message}`],
      pct: p.done !== undefined && p.total ? Math.round((p.done / p.total) * 100) : cur.pct,
    }));
  }, [conn.id]);

  useEvent("game:exit", (payload) => {
    const p = payload as { connId: string; code: number | null };
    if (p.connId !== conn.id) return;
    setLaunchMsg(`game exited (code ${p.code ?? "?"})`);
    launcher.refresh();
  }, [conn.id]);

  const reloadPack = useCallback(async () => {
    try {
      const p = await bridge().server.pack();
      setPack(p);
      setPackErr("");
    } catch (e) { setPackErr(errorText(e)); }
  }, []);
  const reloadPlan = useCallback(async () => {
    try {
      const r = await bridge().sync.check(conn.id);
      setPlan(r.plan);
      setSyncErr(r.ok ? "" : (r.problems ?? []).join("; "));
    } catch (e) { setSyncErr(errorText(e)); setPlan(null); }
  }, [conn.id]);
  const reloadInspection = useCallback(async () => {
    try {
      const r = await bridge().provision.inspect(conn.id);
      setInspection(r.inspection);
      setGameDir(r.gameDir);
    } catch { /* reported when the user acts */ }
  }, [conn.id]);

  // Poll rather than fire-and-forget: a single missed call must not leave the
  // panel permanently showing "loading" (and unstarted work self-heals).
  useEffect(() => {
    let stop = false;
    const loop = async (fn: () => Promise<void>, ms: number) => {
      for (;;) {
        if (stop) return;
        await fn();
        await new Promise((r) => setTimeout(r, ms));
      }
    };
    void loop(reloadPack, 5000);
    void loop(reloadPlan, 5000);
    void loop(reloadInspection, 15000);
    return () => { stop = true; };
  }, [reloadPack, reloadPlan, reloadInspection]);

  const manifest: Manifest | null = pack?.manifest ?? null;
  const running = launcher.data?.running ?? false;
  const st = status.data;

  const modStatus = useMemo(() => {
    const out = new Map<string, { label: string; cls: string }>();
    if (!manifest) return out;
    for (const m of manifest.mods) {
      if (m.side === "server") { out.set(m.modId, { label: "not installed (server-only)", cls: "server" }); continue; }
      if (!plan) { out.set(m.modId, { label: "unknown (plan unavailable)", cls: "" }); continue; }
      const fname = m.file.filename;
      if (plan.downloads.some((d) => d.filename === fname)) { out.set(m.modId, { label: "will download", cls: "warn" }); continue; }
      if (plan.unchanged.some((d) => d.filename === fname)) { out.set(m.modId, { label: "installed", cls: "ok" }); continue; }
      out.set(m.modId, { label: "not planned", cls: "" });
    }
    return out;
  }, [manifest, plan]);

  // Always publish host:port — a "join info-less" server launcher is useless.
  const joinInfo = st?.joinAddress ? `${st.joinAddress}:${st.joinPort}` : null;

  async function syncNow() {
    setBusy("sync"); setMsg(""); setSyncActionErr("");
    try {
      const r = await bridge().sync.apply(conn.id);
      setPlan(r.plan);
      setPack(r.pack);
      const ops = r.log.length;
      setMsg(ops ? `mods synced: ${ops} file operation(s)` : "mods already up to date");
      if (r.manifest.restartRequired) setMsg((m) => `${m} — the server owner must restart the server for mod changes`);
    } catch (e) {
      setSyncActionErr(errorText(e));
    } finally { setBusy(""); }
  }

  async function prepare() {
    setBusy("prepare"); setMsg(""); setLaunchErr("");
    setProgress({ active: true, lines: ["checking what is needed…"], pct: null });
    try {
      const r = await bridge().provision.ensure(conn.id);
      setProgress((cur) => ({ ...cur, active: false }));
      setMsg(r.installed.length
        ? `game files prepared: ${r.installed.join(", ")}`
        : "game files already prepared");
      await reloadInspection();
    } catch (e) {
      setProgress((cur) => ({ ...cur, active: false }));
      setLaunchErr(errorText(e));
    } finally { setBusy(""); }
  }

  async function launch() {
    setBusy("launch"); setMsg(""); setLaunchErr("");
    try {
      const r = await bridge().launch.start(conn.id);
      setLaunchMsg(`launched (pid ${r.pid})`);
      launcher.refresh();
    } catch (e) {
      setLaunchErr(errorText(e));
    } finally { setBusy(""); }
  }

  async function stop() {
    setBusy("stop"); setLaunchErr("");
    try {
      const r = await bridge().launch.stop(conn.id);
      setLaunchMsg(r.stopped ? "stopping the game…" : "the game was not running");
      setTimeout(() => launcher.refresh(), 500);
    } catch (e) { setLaunchErr(errorText(e)); }
    finally { setBusy(""); }
  }

  const needs = inspection?.needs ?? [];

  return h("div", null,
    h("div", { className: "panel" },
      h("div", { className: "row" },
        h("b", null, manifest ? `Minecraft ${manifest.minecraftVersion} / ${manifest.loader} ${manifest.loaderVersion}` : (packErr ? "pack unavailable" : "loading pack…")),
        h("span", { className: "spacer" }),
        h("span", { className: "muted" }, "server: "),
        h("span", { className: `tag ${st ? (st.state === "running" ? "ok" : st.state === "error" ? "err" : "warn") : ""}` }, st?.state ?? "unknown"),
        h("button", { onClick: () => { void reloadPack(); void reloadPlan(); void reloadInspection(); status.refresh(); launcher.refresh(); }, disabled: busy !== "" }, "Refresh")),
      h("div", { className: "kv", style: { marginTop: 10 } },
        h("dt", null, "Join address"),
        h("dd", null, joinInfo
          ? h("span", { className: "row" }, h("b", null, joinInfo),
              h("button", { className: "link", onClick: () => { void navigator.clipboard?.writeText(joinInfo); setMsg(`copied ${joinInfo}`); } }, "copy"))
          : h("span", { className: "muted" }, "not published by the server (MCSP_JOIN_ADDRESS is unset) — ask the owner for the host:port")),
        h("dt", null, "Game files"),
        h("dd", null, inspection
          ? h("span", { className: needs.length ? "warn" : "ok" },
              needs.length ? `not prepared — needs: ${needs.join(", ")}` : "prepared (Java, client, assets, loader)")
          : h("span", { className: "muted" }, "unknown")),
        gameDir && h("dt", null, "Instance dir"),
        gameDir && h("dd", { className: "muted" }, gameDir),
        st?.pid !== null && st?.pid !== undefined && h("dt", null, "Server pid"),
        st?.pid !== null && st?.pid !== undefined && h("dd", null, String(st.pid)),
      ),
      packErr && h(Banner, { kind: "err" }, `pack unavailable: ${packErr}`),
      syncErr && h(Banner, { kind: "warn" }, `sync plan unavailable: ${syncErr}`),
      syncActionErr && h(Banner, { kind: "err" }, `sync failed: ${syncActionErr}`),
      h("div", { className: "row", style: { marginTop: 10 } },
        h("button", { onClick: syncNow, disabled: busy !== "" }, busy === "sync" ? "Syncing…" : "Sync mods"),
        h("button", { className: "secondary", onClick: prepare, disabled: busy !== "" }, busy === "prepare" ? "Preparing…" : needs.length ? `Prepare game files (${needs.length})` : "Prepare game files"),
        running
          ? h("button", { className: "danger", onClick: stop, disabled: busy !== "" }, busy === "stop" ? "Stopping…" : "Stop game")
          : h("button", { onClick: launch, disabled: busy !== "" }, busy === "launch" ? "Launching…" : "Launch")),
      msg && h("p", { className: "ok" }, msg),
      launchMsg && h("p", { className: "muted" }, launchMsg),
      launchErr && h(Banner, { kind: "err" }, launchErr),
      !manifest && !packErr && h(Spinner, { label: "loading pack" }),
    ),

    progress.active && h("div", { className: "panel" },
      h("div", { className: "row" }, h("b", null, "Preparing game files"), h("span", { className: "spacer" }),
        progress.pct !== null ? h("span", { className: "muted" }, `${progress.pct}%`) : h(Spinner)),
      progress.pct !== null && h("div", { className: "progress" }, h("div", { style: { width: `${progress.pct}%` } })),
      h("pre", null, progress.lines.join("\n"))),

    (st?.restartRequired || manifest?.restartRequired) && h(Banner, { kind: "warn" },
      h("div", { className: "row" },
        h("span", { style: { flex: 1 } },
          "The server's mod set changed while it was running — a server restart is required for the pack changes to take effect."),
        h("button", { className: "secondary", onClick: async () => {
          try { await bridge().server.restartAck(); status.refresh(); setMsg("restart acknowledged"); }
          catch (e) { setLaunchErr(errorText(e)); }
        } }, "Acknowledge restart"))),

    h("div", { className: "panel" },
      h("h2", null, `Mods in this pack (${manifest?.mods.length ?? 0})`),
      plan && h("p", { className: "muted" },
        `sync plan: ${plan.downloads.length} to download, ${plan.removals.length} to remove, ` +
        `${plan.unchanged.length} up to date, ${plan.skipped.length} server-only (never installed locally)`),
      h("div", { className: "table-wrap" },
        h("table", null,
          h("thead", null, h("tr", null,
            h("th", null, "Mod"), h("th", null, "Version"), h("th", null, "Side"), h("th", null, "Status"), h("th", null, "File"))),
          h("tbody", null, (manifest?.mods ?? []).map((m) => {
            const s = modStatus.get(m.modId);
            return h("tr", { key: m.modId },
              h("td", null, m.name || m.modId),
              h("td", null, m.version),
              h("td", null, h("span", { className: `tag ${m.side}` }, m.side)),
              h("td", null, h("span", { className: `tag ${s?.cls ?? ""}` }, s?.label ?? "…")),
              h("td", { className: "muted" }, `${m.file.filename} (${fmtBytes(m.file.size)})`));
          }))),
        (manifest?.mods.length ?? 0) === 0 && h("div", { className: "muted" }, "this pack has no mods yet")),
    ),

    h("div", { className: "panel" },
      h("h2", null, "Server files (on the backend)"),
      h("div", { className: "table-wrap" },
        h("table", null,
          h("thead", null, h("tr", null, h("th", null, "File"), h("th", null, "Size"), h("th", null, "Modified"))),
          h("tbody", null, installedFiles(pack).map((f) => h("tr", { key: f.filename },
            h("td", null, f.filename), h("td", null, fmtBytes(f.size)), h("td", { className: "muted" }, f.modifiedAt ?? "—"))))))),
  );
}

/** Backend used to send `installed`; it now sends `installedFiles`. Accept both. */
function installedFiles(pack: PackView | null) {
  return pack?.installedFiles ?? pack?.installed ?? [];
}

export { fmtDuration };
