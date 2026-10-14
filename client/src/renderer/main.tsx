/** MCSP Launcher UI — sidebar (connections) + home screen (tiles) + server view. */
import { createElement as h, useEffect, useState } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import type { ClientSettings, SavedConnection } from "../main/services/store";

declare global {
  interface Window {
    mcsp: {
      auth: {
        status(): Promise<{ signedIn: boolean; name: string | null; expiresSoon: boolean }>;
        startLogin(): Promise<{ userCode: string; verificationUri: string }>;
        loginStatus(): Promise<{ pending: boolean; userCode: string; verificationUri: string; error: string | null; signedIn: boolean; name: string | null }>;
        signOut(): Promise<unknown>;
      };
      connections: {
        list(): Promise<{ connections: SavedConnection[]; activeConnectionId: string | null }>;
        save(p: { id?: string; name?: string; serverUrl: string; adminKey?: string }): Promise<ClientSettings>;
        delete(id: string): Promise<ClientSettings>;
        select(id: string): Promise<ClientSettings>;
      };
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

type Route = { screen: "home" } | { screen: "server"; connId: string; tab: "play" | "admin" };

function App() {
  const [settings, setSettings] = useState<ClientSettings | null>(null);
  const [route, setRoute] = useState<Route>({ screen: "home" });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logLines, setLogLines] = useState<string[]>([]);

  useEffect(() => {
    window.mcsp.settings.get().then(setSettings);
    window.mcsp.on("log", (m) => setLogLines((l) => [...l.slice(-500), m]));
  }, []);

  if (!settings) return h("div", { className: "loading" }, "loading…");

  const activeConn =
    settings.connections.find((c) => c.id === settings.activeConnectionId) ?? null;

  const refreshSettings = (s: ClientSettings) => setSettings(s);

  return h("div", { className: "app" },
    // ---- top home bar (always visible) ----
    h("div", { className: "homebar" },
      h("button", { className: "homebar-btn", onClick: () => setRoute({ screen: "home" }) },
        "⌂ Home"),
      route.screen === "server" && h("div", { className: "homebar-crumb" },
        settings.connections.find((c) => c.id === route.connId)?.name ?? "server"),
      h("div", { className: "spacer" }),
      h("button", { className: "homebar-btn icon", title: "toggle sidebar", onClick: () => setSidebarOpen((o) => !o) }, "☰"),
    ),
    h("div", { className: "body" },
      // ---- sidebar with saved connections ----
      sidebarOpen && h(Sidebar, {
        settings, route, refreshSettings, setRoute,
      }),
      // ---- main content ----
      h("main", { className: "content" },
        route.screen === "home"
          ? h(Home, { settings, setRoute })
          : h(ServerView, { settings, connId: route.connId, tab: route.tab, setRoute, refreshSettings })),
    ),
    logLines.length > 0 && h("div", { className: "logbar" },
      h("div", { className: "logbar-title" }, "log"),
      h("pre", null, logLines.slice(-120).join("\n"))),
  );
}

function Sidebar({ settings, route, refreshSettings, setRoute }: {
  settings: ClientSettings;
  route: Route;
  refreshSettings: (s: ClientSettings) => void;
  setRoute: (r: Route) => void;
}) {
  const [adding, setAdding] = useState(false);

  async function pick(id: string) {
    const s = await window.mcsp.connections.select(id);
    refreshSettings(s);
    setRoute({ screen: "server", connId: id, tab: "play" });
  }
  async function remove(id: string) {
    const s = await window.mcsp.connections.delete(id);
    refreshSettings(s);
    if (route.screen === "server" && route.connId === id) setRoute({ screen: "home" });
  }

  return h("aside", { className: "sidebar" },
    h("div", { className: "sidebar-head" }, "Connections"),
    h("div", { className: "sidebar-list" },
      settings.connections.length === 0 && h("div", { className: "muted" }, "No saved connections yet."),
      settings.connections.map((c) =>
        h("div", { key: c.id, className: `conn-item ${route.screen === "server" && route.connId === c.id ? "active" : ""}` },
          h("button", { className: "conn-btn", onClick: () => pick(c.id), title: c.serverUrl },
            h("span", { className: "conn-name" }, c.name),
            h("span", { className: "conn-url" }, c.serverUrl)),
          h("button", { className: "conn-del", title: "delete connection", onClick: () => remove(c.id) }, "✕")))),
    h("button", { className: "sidebar-add", onClick: () => setAdding(true) }, "＋ New connection"),
    adding && h(ConnectionForm, {
      title: "New connection", onCancel: () => setAdding(false),
      onSave: async (patch) => {
        const s = await window.mcsp.connections.save(patch);
        refreshSettings(s);
        setAdding(false);
        setRoute({ screen: "server", connId: s.activeConnectionId!, tab: "play" });
      },
    }));
}

function AccountBar() {
  const [status, setStatus] = useState<{ signedIn: boolean; name: string | null; expiresSoon: boolean } | null>(null);
  const [login, setLogin] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const st = await window.mcsp.auth.status().catch(() => null);
      if (st) setStatus(st);
      if (login) {
        const ls = await window.mcsp.auth.loginStatus().catch(() => null);
        if (ls) {
          if (ls.error) { setErr(ls.error); setLogin(null); }
          else if (ls.signedIn) { setLogin(null); setStatus(await window.mcsp.auth.status()); }
        }
      }
      if (!stop) setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; };
  }, [login !== null]);

  async function begin() {
    setBusy(true); setErr("");
    try {
      const r = await window.mcsp.auth.startLogin();
      setLogin(r);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  return h("div", { className: "panel account" },
    h("div", { className: "row" },
      status?.signedIn
        ? h("span", null, "Signed in: ", h("b", null, status.name ?? "?"))
        : login
          ? h("span", null,
              "Go to ", h("a", { href: login.verificationUri, target: "_blank", rel: "noreferrer" }, login.verificationUri),
              " and enter code ", h("b", null, login.userCode), " …")
          : h("button", { onClick: begin, disabled: busy }, busy ? "…" : "Sign in with Microsoft"),
      status?.expiresSoon && h("span", { className: "muted" }, "(session expired — will refresh on next launch)"),
      status?.signedIn && h("button", { className: "secondary", onClick: () => window.mcsp.auth.signOut().then(() => window.mcsp.auth.status().then(setStatus)) }, "Sign out")),
    err && h("div", { className: "err" }, err));
}

function Home({ settings, setRoute }: {
  settings: ClientSettings;
  setRoute: (r: Route) => void;
}) {
  return h("div", null,
    h("h1", null, "Home"),
    h(AccountBar),
    settings.connections.length === 0
      ? h("div", { className: "panel muted" }, "No saved connections. Use “＋ New connection” in the sidebar to add a server.")
      : h("div", { className: "tiles" },
          settings.connections.map((c) =>
            h("button", {
              key: c.id, className: "tile", onClick: () => setRoute({ screen: "server", connId: c.id, tab: "play" }),
            },
              h("div", { className: "tile-icon" }, c.name.slice(0, 1).toUpperCase() || "?"),
              h("div", { className: "tile-name" }, c.name),
              h("div", { className: "tile-url" }, c.serverUrl)))),
  );
}

function ConnectionForm({ title, initial, onSave, onCancel }: {
  title: string;
  initial?: SavedConnection;
  onSave: (p: { id?: string; name?: string; serverUrl: string; adminKey?: string }) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.serverUrl ?? "");
  const [key, setKey] = useState(initial?.adminKey ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); setErr("");
    try {
      const clean = url.replace(/\/+$/, "");
      const s = initial
        ? await window.mcsp.connections.save({ id: initial.id, name: name || clean, serverUrl: clean, adminKey: key })
        : await window.mcsp.connections.save({ name: name || clean, serverUrl: clean, adminKey: key });
      await window.mcsp.server.health(); // fail fast if unreachable
      onSave({ id: s.activeConnectionId ?? initial?.id, name, serverUrl: clean, adminKey: key });
    } catch (e) {
      setErr(String(e));
    } finally { setBusy(false); }
  }

  return h("div", { className: "panel form" },
    h("h2", null, title),
    h("div", { className: "form-grid" },
      h("label", null, "Name"),
      h("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "My server" }),
      h("label", null, "API URL"),
      h("input", { value: url, onChange: (e) => setUrl(e.target.value), placeholder: "http://host:8080" }),
      h("label", null, "Admin key"),
      h("input", { type: "password", value: key, onChange: (e) => setKey(e.target.value), placeholder: "(optional)" })),
    err && h("div", { className: "err" }, err),
    h("div", { className: "row" },
      h("button", { onClick: save, disabled: busy }, initial ? "Save" : "Connect"),
      h("button", { className: "secondary", onClick: onCancel, disabled: busy }, "Cancel")));
}

function ServerView({ settings, connId, tab, setRoute, refreshSettings }: {
  settings: ClientSettings;
  connId: string;
  tab: "play" | "admin";
  setRoute: (r: Route) => void;
  refreshSettings: (s: ClientSettings) => void;
}) {
  const conn = settings.connections.find((c) => c.id === connId);
  if (!conn) { setRoute({ screen: "home" }); return null; }

  return h("div", null,
    h("div", { className: "server-head" },
      h("h1", null, conn.name),
      h("div", { className: "tabs" },
        h("button", { className: tab === "play" ? "tab active" : "tab", onClick: () => setRoute({ screen: "server", connId, tab: "play" }) }, "▶ Play"),
        h("button", { className: tab === "admin" ? "tab active" : "tab", onClick: () => setRoute({ screen: "server", connId, tab: "admin" }) }, "⚙ Server admin"),
        h("button", { className: "tab", onClick: () => setRoute({ screen: "home" }) }, "← All servers"))),
    tab === "play" ? h(Play, { conn, settings, refreshSettings }) : h(Admin, { conn, settings, refreshSettings }));
}

function Play({ conn, settings, refreshSettings }: {
  conn: SavedConnection; settings: ClientSettings; refreshSettings: (s: ClientSettings) => void;
}) {
  const [pack, setPack] = useState<{ mods: { modId: string; name: string; version: string; side: string }[]; minecraftVersion: string; loaderVersion: string } | null>(null);
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
  useEffect(() => { refresh().catch((e) => setMsg(String(e))); }, [conn.id]);

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
      await window.mcsp.sync.check();
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
      h("span", { className: "muted" }, `server: ${st ?? "?"}`),
      h("span", { className: "spacer" }),
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
            h("td", null, m.side === "server" ? "not installed (server-only)" : "required")))))))
}

function Admin({ conn, settings, refreshSettings }: {
  conn: SavedConnection; settings: ClientSettings; refreshSettings: (s: ClientSettings) => void;
}) {
  const hasKey = Boolean(conn.adminKey);
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
  useEffect(() => { if (hasKey) refresh(); else setErr(""); }, [hasKey, conn.id]);

  async function sendConsole() {
    setErr("");
    try {
      await window.mcsp.server.console(consoleInput);
      setConsoleInput("");
      setTimeout(refresh, 300);
    } catch (e) { setErr(String(e)); }
  }

  async function unlock(k: string) {
    setErr("");
    try {
      await window.mcsp.connections.save({ id: conn.id, name: conn.name, serverUrl: conn.serverUrl, adminKey: k });
      const s = await window.mcsp.settings.get();
      refreshSettings(s);
    } catch (e) { setErr("invalid key? " + String(e)); }
  }

  if (!hasKey) {
    return h(KeyPrompt, { onSubmit: unlock, err });
  }
  return h("div", null,
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
          h("tr", { key: i }, h("td", null, j.kind), h("td", null, j.state)))),
        jobs.length === 0 && h("div", { className: "muted" }, "no jobs yet")),
      err && h("div", { className: "err" }, err)));
}

function KeyPrompt({ onSubmit, err }: { onSubmit: (key: string) => void; err: string }) {
  const [key, setKey] = useState("");
  return h("div", { className: "panel" },
    h("h2", null, "Admin access"),
    h("p", { className: "muted" }, "Enter the server's admin key to unlock management for this connection."),
    h("div", { className: "row" },
      h("input", { type: "password", value: key, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value), placeholder: "admin key", size: 30 }),
      h("button", { onClick: () => onSubmit(key) }, "Unlock")),
    err && h("div", { className: "err" }, err));
}

createRoot(document.getElementById("root")!).render(h(App));
