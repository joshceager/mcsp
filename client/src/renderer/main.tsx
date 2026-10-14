/** MCSP Launcher UI (React via esbuild; no plugin-react dependency). */
import { createElement as h, useEffect, useState } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { ClientSettings } from "../main/services/store";

declare global {
  interface Window {
    mcsp: {
      settings: { get(): Promise<ClientSettings>; set(p: Partial<ClientSettings>): Promise<ClientSettings> };
      server: {
        health(): Promise<{ ok: boolean; adminEnabled: boolean }>;
        status(): Promise<Record<string, unknown>>;
        pack(): Promise<{ manifest: {
          mods: { modId: string; name: string; version: string; side: string }[];
          minecraftVersion: string;
          loaderVersion: string;
        } }>;
        logs(): Promise<{ lines: string[] }>;
        console(line: string): Promise<unknown>;
        serverOp(kind: "start" | "stop" | "restart"): Promise<{ id: string }>;
        jobs(): Promise<{ jobs: { kind: string; state: string }[] }>;
        job(id: string): Promise<unknown>;
        restartAck(): Promise<unknown>;
        addMod(payload: unknown): Promise<{ id: string }>;
        updateMod(modId: string, payload: unknown): Promise<{ id: string }>;
        removeMod(modId: string): Promise<{ id: string }>;
      };
      sync: { check(): Promise<SyncCheckResult>; apply(): Promise<ApplyResult> };
      provision: { ensure(): Promise<{ action: string; loaderVersion: string }> };
      launch: {
        start(): Promise<{ pid: number }>;
        stop(): Promise<unknown>;
        isRunning(): Promise<{ running: boolean }>;
      };
      on(channel: "log", cb: (msg: string) => void): void;
    };
  }
}

interface SyncCheckResult { ok: boolean; problems?: string[]; plan: Plan | null; manifest?: unknown }
interface Plan { downloads: unknown[]; removals: unknown[]; unchanged: unknown[]; skipped: unknown[]; restartRequired: boolean }
interface ApplyResult { log: string[]; plan: Plan }

function App() {
  const [settings, setSettings] = useState<ClientSettings | null>(null);
  const [view, setView] = useState<"play" | "admin">("play");
  const [logLines, setLogLines] = useState<string[]>([]);

  useEffect(() => {
    window.mcsp.settings.get().then(setSettings);
    window.mcsp.on("log", (m) => setLogLines((l) => [...l.slice(-500), m]));
  }, []);

  if (!settings) return h("div", null, "loading…");
  const noServer = !settings.serverUrl;

  return h(
    "div",
    null,
    h("div", { className: "row panel" },
      h("h2", { style: { margin: 0, flex: 1 } }, "MCSP Launcher"),
      h("button", { onClick: () => setView("play"), disabled: view === "play" }, "Play"),
      h("button", { onClick: () => setView("admin"), disabled: view === "admin" }, "Server admin"),
    ),
    noServer
      ? h(ConnectForm, { settings, onSave: setSettings })
      : view === "play"
        ? h(Play, { settings })
        : h(Admin, { settings }),
    logLines.length > 0 && h("div", { className: "panel" },
      h("h2", null, "Log"),
      h("pre", null, logLines.slice(-200).join("\n"))),
  );
}

function ConnectForm({ settings, onSave }: { settings: ClientSettings; onSave: (s: ClientSettings) => void }) {
  const [url, setUrl] = useState(settings.serverUrl);
  const [gameDir, setGameDir] = useState(settings.gameDir);
  const [name, setName] = useState(settings.playerName);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true); setErr("");
    try {
      const s = await window.mcsp.settings.set({ serverUrl: url.replace(/\/+$/, ""), gameDir, playerName: name || "Player" });
      await window.mcsp.server.health(); // fail fast if unreachable
      onSave(s);
    } catch (e) {
      setErr(String(e));
    } finally { setBusy(false); }
  }

  return h("div", { className: "panel" },
    h("h2", null, "Connect to a server"),
    h("div", { className: "row" },
      h("label", null, "API URL"), h("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "http://host:8080", size: 40 }),
      h("label", null, "Game dir"), h("input", { value: gameDir, onChange: (e) => setGameDir(e.target.value), placeholder: "/home/you/.minecraft", size: 30 }),
      h("label", null, "Name"), h("input", { value: name, onChange: (e) => setName(e.target.value), size: 14 }),
      h("button", { onClick: connect, disabled: busy }, "Connect")),
    err && h("div", { className: "err" }, err),
  );
}

function Play({ settings }: { settings: ClientSettings }) {
  const [pack, setPack] = useState<{ mods: { modId: string; name: string; version: string; side: string }[]; minecraftVersion: string; loaderVersion: string } | null>(null);
  // pack() promise type matches this shape (declared on the bridge).
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);

  const refresh = async () => {
    const p = await window.mcsp.server.pack();
    setPack(p.manifest);
    const chk = await window.mcsp.sync.check();
    setPlan(chk.ok ? chk.plan : null);
    setStatus(await window.mcsp.server.status());
    setRunning((await window.mcsp.launch.isRunning()).running);
  };
  useEffect(() => { refresh().catch((e) => setMsg(String(e))); }, []);

  async function syncNow() {
    setBusy(true); setMsg("");
    try {
      const chk = await window.mcsp.sync.check();
      if (!chk.ok) throw new Error("manifest invalid: " + (chk.problems || []).join("; "));
      const r = await window.mcsp.sync.apply();
      await window.mcsp.provision.ensure();
      setMsg(`sync complete: ${r.log.length} ops`);
      await refresh();
    } catch (e) { setMsg("sync failed: " + String(e)); }
    finally { setBusy(false); }
  }

  async function launch() {
    setBusy(true); setMsg("");
    try {
      await window.mcsp.sync.check(); // refuse if manifest invalid
      await window.mcsp.provision.ensure();
      const r = await window.mcsp.launch.start();
      setRunning(true);
      setMsg(`launched (pid ${r.pid})`);
    } catch (e) { setMsg("launch failed: " + String(e)); }
    finally { setBusy(false); }
  }

  const st = status?.state as string | undefined;
  return h("div", null,
    h("div", { className: "panel row" },
      h("b", null, `MC ${pack?.minecraftVersion ?? "?"} / NeoForge ${pack?.loaderVersion ?? "?"}`),
      h("span", null, `server: ${st ?? "?"}`),
      h("button", { onClick: syncNow, disabled: busy }, "Sync"),
      h("button", { onClick: launch, disabled: busy || running }, running ? "Running…" : "Launch"),
      running && h("button", { className: "danger", onClick: () => window.mcsp.launch.stop().then(() => setRunning(false)) }, "Stop game")),
    msg && h("div", { className: "panel" }, msg),
    h("div", { className: "panel" },
      h("h2", null, `Required mods (${pack?.mods.length ?? 0})`),
      h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Mod"), h("th", null, "Version"), h("th", null, "Side"), h("th", null, "Status"))),
        h("tbody", null, (pack?.mods ?? []).map((m) =>
          h("tr", { key: m.modId },
            h("td", null, m.name || m.modId), h("td", null, m.version),
            h("td", null, h("span", { className: `tag ${m.side}` }, m.side)),
            h("td", null, m.side === "server" ? "not installed (server-only)" : "required")))))),
  );
}

function Admin({ settings }: { settings: ClientSettings }) {
  const [hasKey, setHasKey] = useState(Boolean(settings.adminKey));
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [jobs, setJobs] = useState<{ kind: string; state: string }[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [consoleInput, setConsoleInput] = useState("");
  const [err, setErr] = useState("");

  const refresh = async () => {
    try {
      setStatus(await window.mcsp.server.status());
      setJobs((await window.mcsp.server.jobs()).jobs.slice(0, 10));
      setLogs((await window.mcsp.server.logs()).lines.slice(-60));
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => { if (hasKey) refresh(); }, [hasKey]);

  async function sendConsole() {
    setErr("");
    try {
      await window.mcsp.server.console(consoleInput);
      setConsoleInput("");
      setTimeout(refresh, 300);
    } catch (e) { setErr(String(e)); }
  }

  return h("div", null,
    !hasKey && h("div", { className: "panel" },
      h("h2", null, "Admin access"),
      h("div", { className: "row" },
        h("input", { type: "password", value: key, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value), placeholder: "admin key", size: 30 }),
        h("button", { onClick: async () => {
          try {
            await window.mcsp.server.logs(); // probe with the key
            const s = await window.mcsp.settings.set({ adminKey: key });
            setHasKey(true);
          } catch (e) { setErr("invalid key? " + String(e)); }
        } }, "Unlock")),
      err && h("div", { className: "err" }, err)),
    hasKey && h("div", null,
      h("div", { className: "panel row" },
        h("b", null, "Server state: " + String(status?.state ?? "?")),
        h("button", { onClick: () => window.mcsp.server.serverOp("start").then(refresh) }, "Start"),
        h("button", { onClick: () => window.mcsp.server.serverOp("stop").then(refresh) }, "Stop"),
        h("button", { onClick: () => window.mcsp.server.serverOp("restart").then(refresh) }, "Restart"),
        h("button", { onClick: refresh }, "Refresh")),
      h("div", { className: "panel" },
        h("h2", null, "Server console"),
        h("div", { className: "row" },
          h("input", { value: consoleInput, onChange: (e) => setConsoleInput(e.target.value), placeholder: "say hi", size: 50, onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && sendConsole() }),
          h("button", { onClick: sendConsole }, "Send")),
        h("pre", null, logs.join("\n") || "(no logs)")),
      h("div", { className: "panel" },
        h("h2", null, "Recent jobs"),
        h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Kind"), h("th", null, "State"))),
          h("tbody", null, jobs.map((j, i) =>
            h("tr", { key: i }, h("td", null, j.kind), h("td", null, j.state)))))),
      err && h("div", { className: "err" }, err)),
  );
}

createRoot(document.getElementById("root")!).render(h(App));
