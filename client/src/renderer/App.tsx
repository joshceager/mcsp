/** App shell: connection sidebar, home screen, account bar and settings.
 *  The add/edit connection form lives in a modal so it can never collide with
 *  (or be pushed off-screen by) the main content. */
import { createElement as h, useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import { bridge } from "./bridge";
import type { ClientSettings, LoginStart, SecurityInfo, SettingsBundle } from "./bridge";
import { Banner, Modal, Spinner, errorText, fmtTime } from "./ui";
import { Play } from "./Play";
import { Admin } from "./Admin";

export interface Session {
  settings: ClientSettings;
  security: SecurityInfo;
  apply: (b: SettingsBundle | { settings: ClientSettings }) => void;
}

export type Route = { screen: "home" } | { screen: "server"; connId: string; tab: "play" | "admin" };

interface LogLine { connId: string | null; line: string; at: number }

export function App() {
  const [settings, setSettings] = useState<ClientSettings | null>(null);
  const [security, setSecurity] = useState<SecurityInfo | null>(null);
  const [route, setRoute] = useState<Route>({ screen: "home" });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [form, setForm] = useState<{ connId?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [flash, setFlash] = useState("");

  const apply = useCallback((b: { settings: ClientSettings } & Partial<SettingsBundle>) => {
    setSettings(b.settings);
    if (b.security) setSecurity(b.security);
  }, []);

  useEffect(() => {
    bridge().settings.get().then(apply).catch((e) => setFlash(errorText(e)));
  }, [apply]);

  useEffect(() => {
    return bridge().on("log", (payload) => {
      const p = payload as { connId?: string; line: string };
      setLogs((l) => [...l.slice(-800), { connId: p.connId ?? null, line: p.line, at: Date.now() }]);
      setLogOpen(true);
    });
  }, []);

  useEffect(() => {
    return bridge().on("stream:error", (payload) => {
      const p = payload as { message: string };
      setLogs((l) => [...l.slice(-800), { connId: null, line: `[stream] ${p.message}`, at: Date.now() }]);
    });
  }, []);

  const session: Session | null = useMemo(
    () => (settings && security ? { settings, security, apply } : null),
    [settings, security, apply],
  );

  if (!session) return h("div", { className: "loading" }, "loading…");

  const active = session.settings.connections.find((c) => c.id === session.settings.activeConnectionId) ?? null;
  const routeConnId = route.screen === "server" ? route.connId : null;
  const visibleLogs = logs.filter((l) => !routeConnId || l.connId === routeConnId || l.connId === null);

  const pick = async (id: string) => {
    try {
      apply(await bridge().connections.select(id));
      setRoute({ screen: "server", connId: id, tab: "play" });
      setSidebarOpen(false);
    } catch (e) { setFlash(errorText(e)); }
  };

  const doDelete = async (id: string) => {
    setConfirmDelete(null);
    try {
      const r = await bridge().connections.delete(id);
      apply(r);
      if (route.screen === "server" && route.connId === id) setRoute({ screen: "home" });
      setFlash("");
    } catch (e) { setFlash(errorText(e)); }
  };

  return h("div", { className: "app" },
    h("div", { className: "homebar" },
      h("button", { className: "homebar-btn", onClick: () => { setRoute({ screen: "home" }); setSidebarOpen(w => window.innerWidth > 700 ? w : false); } }, "⌂ Home"),
      route.screen === "server" && h("div", { className: "homebar-crumb" },
        session.settings.connections.find((c) => c.id === route.connId)?.name ?? "(deleted)"),
      h("div", { className: "spacer" }),
      h("button", { className: "homebar-btn icon", title: "toggle connection list", onClick: () => setSidebarOpen((o) => !o) }, "☰"),
      h("button", { className: "homebar-btn icon", title: logOpen ? "hide log" : "show log", onClick: () => setLogOpen((o) => !o) }, logOpen ? "▾ log" : "▴ log"),
    ),
    flash && h("div", { style: { padding: "8px 12px 0" } }, h(Banner, { kind: "err", onDismiss: () => setFlash("") }, flash)),
    h("div", { className: "body" },
      sidebarOpen && h(Sidebar, {
        session, route,
        onPick: pick,
        onNew: () => setForm({}),
        onEdit: (id: string) => setForm({ connId: id }),
        onDelete: (id: string) => setConfirmDelete(id),
      }),
      h("main", { className: "content" },
        route.screen === "home"
          ? h(Home, { session, route, openServer: (id, tab) => setRoute({ screen: "server", connId: id, tab }) })
          : h(ServerView, { session, connId: route.connId, tab: route.tab, setRoute, openForm: (id) => setForm({ connId: id }) })),
    ),
    logOpen && visibleLogs.length > 0 && h("div", { className: "logbar" },
      h("div", { className: "logbar-head" },
        h("div", { className: "logbar-title" }, `log — ${visibleLogs.length} line(s)`),
        h("button", { className: "link", onClick: () => setLogs([]) }, "clear"),
        h("button", { className: "link", onClick: () => setLogOpen(false) }, "close")),
      h("pre", { ref: autoScroll }, visibleLogs.slice(-150).map((l) => l.line).join("\n"))),
    form && h(ConnectionFormModal, {
      session,
      connId: form.connId,
      onClose: () => setForm(null),
      onSaved: (s, connId, isNew) => {
        apply(s);
        setForm(null);
        setFlash("");
        setRoute({ screen: "server", connId, tab: "play" });
        if (isNew) setSidebarOpen(window.innerWidth > 700);
      },
    }),
    confirmDelete && h(ConfirmModal, {
      title: "Delete connection",
      body: `Delete “${session.settings.connections.find((c) => c.id === confirmDelete)?.name}”? The server itself is not affected — this only removes the saved connection from this machine.`,
      confirmLabel: "Delete",
      onCancel: () => setConfirmDelete(null),
      onConfirm: () => void doDelete(confirmDelete),
    }),
  );
}

function autoScroll(el: HTMLPreElement | null): void {
  if (el) el.scrollTop = el.scrollHeight;
}

// ------------------------------------------------------------------ sidebar

function Sidebar({ session, route, onPick, onNew, onEdit, onDelete }: {
  session: Session; route: Route;
  onPick: (id: string) => void; onNew: () => void;
  onEdit: (id: string) => void; onDelete: (id: string) => void;
}) {
  const conns = session.settings.connections;
  return h("aside", { className: "sidebar" },
    h("div", { className: "sidebar-head" }, h("span", null, "Connections"),
      h("span", { className: "muted" }, `${conns.length}`)),
    h("div", { className: "sidebar-list" },
      conns.length === 0 && h("div", { className: "muted" }, "No saved connections yet."),
      conns.map((c) => h("div", {
        key: c.id,
        className: `conn-item ${route.screen === "server" && route.connId === c.id ? "active" : ""}`,
      },
        h("button", { className: "conn-btn", onClick: () => onPick(c.id), title: c.serverUrl },
          h("span", { className: "conn-name" }, c.name),
          h("span", { className: "conn-url" }, c.serverUrl),
          c.adminKey && h("span", { className: "conn-url ok" }, "admin key saved")),
        h("button", { className: "icon-btn", title: `edit ${c.name}`, "aria-label": `edit ${c.name}`, onClick: () => onEdit(c.id) }, "✎"),
        h("button", { className: "icon-btn danger", title: `delete ${c.name}`, "aria-label": `delete ${c.name}`, onClick: () => onDelete(c.id) }, "✕")))),
    h("button", { className: "sidebar-add", onClick: onNew }, "＋ New connection"));
}

// --------------------------------------------------------------- home screen

function Home({ session, openServer }: {
  session: Session; route?: Route; openServer: (id: string, tab: "play" | "admin") => void;
}) {
  const conns = session.settings.connections;
  return h("div", null,
    h("h1", null, "Home"),
    h(AccountBar),
    h(SettingsPanel, { session }),
    conns.length === 0
      ? h("div", { className: "panel muted" }, "No saved connections. Use “＋ New connection” in the sidebar to add a server.")
      : h("div", { className: "tiles" },
        conns.map((c) => h("button", {
          key: c.id, className: "tile", onClick: () => openServer(c.id, "play"),
        },
          h("div", { className: "tile-icon" }, c.name.slice(0, 1).toUpperCase() || "?"),
          h("div", { className: "tile-name" }, c.name),
          h("div", { className: "tile-url" }, c.serverUrl)))));
}

function AccountBar() {
  const [status, setStatus] = useState<{ signedIn: boolean; name: string | null; expiresSoon: boolean } | null>(null);
  const [login, setLogin] = useState<LoginStart | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const st = await bridge().auth.status();
        if (!stop) setStatus(st);
        if (login) {
          const ls = await bridge().auth.loginStatus();
          if (stop) return;
          setRemaining(ls.expiresIn);
          if (ls.error) { setErr(ls.error); setLogin(null); }
          else if (ls.signedIn) { setLogin(null); setStatus(await bridge().auth.status()); }
        }
      } catch { /* transient */ }
      if (!stop) setTimeout(tick, 1000);
    };
    void tick();
    return () => { stop = true; };
  }, [login]);

  const begin = async () => {
    setBusy(true); setErr("");
    try {
      const r = await bridge().auth.startLogin();
      setLogin(r);
      setRemaining(r.expiresIn);
    } catch (e) { setErr(errorText(e)); }
    finally { setBusy(false); }
  };

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s % 60)).padStart(2, "0")}`;

  return h("div", { className: "panel" },
    h("div", { className: "row" },
      h("b", null, "Microsoft account"),
      h("span", { className: "spacer" }),
      status?.signedIn && h("span", { className: "ok" }, `signed in as ${status.name ?? "?"}`),
      !status?.signedIn && !login && h("button", { onClick: begin, disabled: busy }, busy ? "…" : "Sign in with Microsoft"),
      status?.signedIn && h("button", { className: "secondary", onClick: () => bridge().auth.signOut().then(() => bridge().auth.status().then(setStatus)) }, "Sign out")),
    login && h("div", { className: "stack", style: { marginTop: 8 } },
      h("div", null, "Open ", h("a", {
        href: login.verificationUri,
        onClick: (e: React.MouseEvent) => { e.preventDefault(); void bridge().app.openExternal(login.verificationUri); },
      }, login.verificationUri), " in your browser and enter this code:"),
      h("div", { className: "row" },
        h("b", { style: { fontSize: 20, letterSpacing: 2 } }, login.userCode),
        remaining > 0
          ? h("span", { className: remaining < 60 ? "warn" : "muted" }, `expires in ${mmss(remaining)}`)
          : h("span", { className: "err" }, "code expired — try again"),
        h("button", { className: "secondary", onClick: () => { void bridge().auth.cancelLogin(); setLogin(null); } }, "Cancel"))),
    status?.signedIn && status.expiresSoon &&
      h("div", { className: "muted", style: { marginTop: 6 } }, "session expired — it will refresh automatically on the next launch"),
    err && h("div", { className: "err", style: { marginTop: 6 } }, err));
}

function SettingsPanel({ session }: { session: Session }) {
  const [name, setName] = useState(session.settings.playerName);
  const [auto, setAuto] = useState(session.settings.autoStartServer);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);

  const save = async () => {
    try {
      session.apply(await bridge().settings.set({ playerName: name, autoStartServer: auto }));
      setMsg("saved");
    } catch (e) { setMsg(errorText(e)); }
  };

  return h("div", { className: "panel" },
    h("div", { className: "row" },
      h("b", null, "Settings"),
      h("span", { className: "spacer" }),
      h("button", { className: "link", onClick: () => setOpen((o) => !o) }, open ? "hide" : "show")),
    open && h("div", { style: { marginTop: 10 } },
      h("div", { className: "form-grid" },
        h("label", { htmlFor: "set-player" }, "Player name"),
        h("input", { id: "set-player", value: name, onChange: (e) => setName(e.target.value), placeholder: "Player" }),
        h("label", { htmlFor: "set-auto" }, "Auto-start server"),
        h("label", { className: "row", htmlFor: "set-auto" },
          h("input", { id: "set-auto", type: "checkbox", checked: auto, onChange: (e) => setAuto(e.target.checked) }),
          h("span", { className: "muted" }, "start the managed server when the admin tab is opened"))),
      h("p", { className: "muted", style: { marginBottom: 6 } },
        "The player name is only used when the Microsoft profile name is unavailable; online-mode servers always use your signed-in account."),
      h("div", { className: "row" },
        h("button", { onClick: save }, "Save settings"),
        msg && h("span", { className: msg === "saved" ? "ok" : "err" }, msg)),
      h("p", { className: session.security.encryptionAvailable ? "ok" : "warn", style: { marginBottom: 0 } },
        `${session.security.keyStorage === "os-keychain" ? "🔒" : "⚠"} ${session.security.detail}`)));
}

// ------------------------------------------------------------ server view

function ServerView({ session, connId, tab, setRoute, openForm }: {
  session: Session; connId: string; tab: "play" | "admin";
  setRoute: (r: Route) => void; openForm: (connId: string) => void;
}) {
  const conn = session.settings.connections.find((c) => c.id === connId) ?? null;

  // Never call setRoute during render (React anti-pattern): navigate from an effect.
  useEffect(() => {
    if (!conn) setRoute({ screen: "home" });
  }, [conn, setRoute]);

  if (!conn) {
    return h("div", { className: "panel" },
      h("h2", null, "Connection not found"),
      h("p", { className: "muted" }, "It may have been deleted."),
      h("button", { onClick: () => setRoute({ screen: "home" }) }, "Back to Home"));
  }

  return h("div", null,
    h("div", { className: "server-head" },
      h("h1", null, conn.name),
      h("div", { className: "tabs" },
        h("button", { className: tab === "play" ? "tab active" : "tab", onClick: () => setRoute({ screen: "server", connId, tab: "play" }) }, "▶ Play"),
        h("button", { className: tab === "admin" ? "tab active" : "tab", onClick: () => setRoute({ screen: "server", connId, tab: "admin" }) }, "⚙ Server admin"),
        h("button", { className: "tab", onClick: () => openForm(connId) }, "✎ Edit connection"),
        h("button", { className: "tab", onClick: () => setRoute({ screen: "home" }) }, "← All servers"))),
    tab === "play"
      ? h(Play, { session, conn })
      : h(Admin, { session, conn }));
}

// -------------------------------------------------------- connection form

function ConnectionFormModal({ session, connId, onClose, onSaved }: {
  session: Session; connId?: string;
  onClose: () => void;
  onSaved: (s: { settings: ClientSettings }, connId: string, isNew: boolean) => void;
}) {
  const existing = connId ? session.settings.connections.find((c) => c.id === connId) : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.serverUrl ?? "http://");
  // The stored key never leaves the main process; blank means "keep existing".
  const [key, setKey] = useState("");
  const [probe, setProbe] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setProbe(""); setErr("");
    try {
      const r = await bridge().connections.verify({ serverUrl: url, adminKey: key });
      setProbe(`reachable: MCSP backend${r.adminEnabled ? " (admin enabled)" : " (admin disabled)"}`);
    } catch (e) { setErr(errorText(e)); }
  };

  const save = async () => {
    setBusy(true); setErr(""); setProbe("");
    try {
      const patch: { id?: string; name?: string; serverUrl: string; adminKey?: string } = {
        name: name || url,
        serverUrl: url,
      };
      if (existing) {
        patch.id = existing.id;
        if (key) patch.adminKey = key;
      } else {
        patch.adminKey = key;
      }
      const r = await bridge().connections.save(patch);
      onSaved(r, r.connection.id, !existing);
    } catch (e) {
      // Nothing was persisted: the connection is validated before it is stored.
      setErr(errorText(e));
    } finally { setBusy(false); }
  };

  return h(Modal, {
    title: existing ? `Edit “${existing.name}”` : "New connection",
    onClose,
    footer: h("div", { className: "row" },
      h("button", { className: "secondary", onClick: check, disabled: busy }, "Test connection"),
      h("button", { className: "secondary", onClick: onClose, disabled: busy }, "Cancel"),
      h("button", { onClick: save, disabled: busy }, busy ? "Checking…" : existing ? "Save" : "Connect")),
  },
    h("div", { className: "form-grid" },
      h("label", { htmlFor: "cf-name" }, "Name"),
      h("input", { id: "cf-name", value: name, onChange: (e) => setName(e.target.value), placeholder: "My server" }),
      h("label", { htmlFor: "cf-url" }, "API URL"),
      h("input", { id: "cf-url", value: url, onChange: (e) => setUrl(e.target.value), placeholder: "http://host:8080" }),
      h("label", { htmlFor: "cf-key" }, "Admin key"),
      h("input", {
        id: "cf-key", type: "password", value: key, onChange: (e) => setKey(e.target.value),
        placeholder: existing?.adminKey ? "unchanged (key already saved)" : "(optional)",
      })),
    h("p", { className: "muted" }, existing
      ? "Leave the admin key blank to keep the stored key. It is validated against the server before anything is saved."
      : "The URL is verified against /api/v1/health — a page that merely returns 200 is not accepted. Nothing is saved until the check passes."),
    probe && h("div", { className: "ok" }, `✓ ${probe}`),
    err && h("div", { className: "err" }, err));
}

function ConfirmModal({ title, body, confirmLabel, onCancel, onConfirm }: {
  title: string; body: string; confirmLabel: string;
  onCancel: () => void; onConfirm: () => void;
}) {
  return h(Modal, {
    title, onClose: onCancel,
    footer: h("div", { className: "row" },
      h("button", { className: "secondary", onClick: onCancel }, "Cancel"),
      h("button", { className: "danger", onClick: onConfirm }, confirmLabel)),
  }, h("p", null, body));
}

export { Spinner, fmtTime };
