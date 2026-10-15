/** Admin tab: server lifecycle, live console, job history, pack management.
 *
 *  Fixes baked in here:
 *   - a wrong admin key is validated before it is stored (never "unlocks" silently)
 *   - Start/Stop/Restart show busy state, poll the real state and report errors
 *   - jobs show times, duration, progress and the failure reason, with a detail view
 *   - errors render next to the panel that produced them, never in one shared slot
 *   - an unreachable backend says so, instead of claiming "no jobs yet"
 *   - the console is fed by the backend SSE /logs/stream
 *   - pack management and backups are exposed
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { bridge } from "./bridge";
import type { BackupView, JobView, ServerStatus } from "./bridge";
import type { Session } from "./App";
import { Banner, Modal, Spinner, errorText, fmtBytes, fmtDateTime, fmtDuration, jobSummary, stateTag, useEvent, usePoll } from "./ui";

interface Props { session: Session; conn: { id: string; name: string; serverUrl: string; adminKey: string } }

export function Admin({ session, conn }: Props) {
  const [key, setKey] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [changingKey, setChangingKey] = useState(false);
  const hasKey = Boolean(conn.adminKey);

  // Applying a validated key: only reachable after the server accepted it.
  const saveKey = async (value: string, close?: () => void) => {
    setKeyBusy(true); setKeyErr("");
    try {
      if (value) {
        const probe = await bridge().server.probeKey(value);
        if (!probe.ok) throw new Error(probe.message);
      }
      const r = await bridge().connections.save({
        id: conn.id, name: conn.name, serverUrl: conn.serverUrl,
        adminKey: value,
      });
      session.apply(r);
      setKey(value);
      setChangingKey(false);
      close?.();
    } catch (e) {
      setKeyErr(errorText(e));
    } finally { setKeyBusy(false); }
  };

  if (!hasKey && !key) {
    return h(UnlockPanel, { busy: keyBusy, err: keyErr, onSubmit: (v) => void saveKey(v) });
  }

  return h("div", null,
    changingKey && h(ChangeKeyModal, {
      busy: keyBusy, err: keyErr,
      onCancel: () => { setChangingKey(false); setKeyErr(""); },
      onSubmit: (v) => void saveKey(v),
    }),
    h(AdminBody, {
      conn, session,
      onChangeKey: () => { setChangingKey(true); setKeyErr(""); },
    }),
  );
}

function UnlockPanel({ busy, err, onSubmit }: { busy: boolean; err: string; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState("");
  return h("div", { className: "panel" },
    h("h2", null, "Admin access"),
    h("p", { className: "muted" },
      "Enter this server's admin key. It is checked against the server before it is saved, so a wrong key can never unlock a broken panel."),
    h("div", { className: "row" },
      h("input", {
        type: "password", value, placeholder: "admin key", "aria-label": "admin key",
        onChange: (e) => setValue(e.target.value),
        onKeyDown: (e) => { if (e.key === "Enter" && value) onSubmit(value); },
      }),
      h("button", { onClick: () => onSubmit(value), disabled: busy || !value }, busy ? "Checking…" : "Unlock")),
    err && h("div", { className: "err", style: { marginTop: 8 } }, err));
}

function ChangeKeyModal({ busy, err, onCancel, onSubmit }: {
  busy: boolean; err: string; onCancel: () => void; onSubmit: (v: string) => void;
}) {
  const [value, setValue] = useState("");
  return h(Modal, {
    title: "Change admin key", onClose: onCancel,
    footer: h("div", { className: "row" },
      h("button", { className: "secondary", onClick: onCancel, disabled: busy }, "Cancel"),
      h("button", { onClick: () => onSubmit(value), disabled: busy || !value }, busy ? "Checking…" : "Save key")),
  },
    h("p", { className: "muted" }, "The new key is validated against the server before it replaces the saved one."),
    h("input", {
      type: "password", value, "aria-label": "new admin key", style: { width: "100%" },
      onChange: (e) => setValue(e.target.value),
    }),
    err && h("div", { className: "err", style: { marginTop: 8 } }, err));
}

// --------------------------------------------------------------------- body

function AdminBody({ conn, session, onChangeKey }: {
  conn: { id: string; name: string; serverUrl: string; adminKey: string };
  session: Session;
  onChangeKey: () => void;
}) {
  const status = usePoll<ServerStatus>(() => bridge().server.status(), 3000, [conn.id]);
  const jobs = usePoll(() => bridge().server.jobs(25), 5000, [conn.id]);
  const backups = usePoll(() => bridge().server.backups(), 15000, [conn.id]);
  const pack = usePoll(() => bridge().server.pack(), 15000, [conn.id]);

  const [lifecycleBusy, setLifecycleBusy] = useState<"" | "start" | "stop" | "restart">("");
  const [lifecycleErr, setLifecycleErr] = useState("");
  const [lifecycleMsg, setLifecycleMsg] = useState("");
  const [consoleErr, setConsoleErr] = useState("");
  const [consoleInput, setConsoleInput] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLive, setLogsLive] = useState(false);
  const [packErr, setPackErr] = useState("");
  const [packMsg, setPackMsg] = useState("");
  const [backupErr, setBackupErr] = useState("");
  const [selectedJob, setSelectedJob] = useState<JobView | null>(null);
  const [jobDetailErr, setJobDetailErr] = useState("");
  const jobDetailId = useRef<string | null>(null);
  const [adding, setAdding] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const st = status.data;
  const offline = /cannot reach|network_error|fetch failed/i.test(status.error || jobs.error);

  const subscribe = usePoll(() => bridge().stream.subscribe(conn.id, true), 60000, [conn.id]);
  void subscribe;

  useEvent("server:log", (payload) => {
    const p = payload as { connId: string; line: string };
    if (p.connId !== conn.id) return;
    setLogsLive(true);
    setLogs((l) => [...l.slice(-800), p.line]);
  }, [conn.id]);

  // Seed the console once so it is never empty while the stream warms up.
  useEffect(() => {
    bridge().server.logs(200).then((r) => setLogs((cur) => (cur.length ? cur : r.lines))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id]);

  useEvent("server:job", (payload) => {
    const p = payload as { connId: string; job: JobView };
    if (p.connId !== conn.id) return;
    jobs.refresh();
    void status.refresh();
    if (p.job?.id && jobDetailId.current === p.job.id) setSelectedJob(p.job);
  }, [conn.id, selectedJob?.id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // "start the server when the admin panel opens" (previously a dead setting)
  const autoStartDone = useRef(false);
  useEffect(() => {
    if (autoStartDone.current || !session.settings.autoStartServer || !st) return;
    if (st.state === "stopped") {
      autoStartDone.current = true;
      void op("start", "auto-start");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.state, session.settings.autoStartServer]);

  async function op(kind: "start" | "stop" | "restart", reason?: string) {
    setLifecycleBusy(kind); setLifecycleErr(""); setLifecycleMsg("");
    try {
      const r = await bridge().server.serverOp(kind);
      setLifecycleMsg(`${reason ?? kind} accepted — job ${String(r.id).slice(0, 8)}; waiting for the server to settle…`);
      // Poll quickly until the state has settled (no more stale "running").
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 700));
        const s = await bridge().server.status().catch(() => null);
        if (s) status.refresh();
        const current = await bridge().server.job(r.id).catch(() => null);
        if (current && current.state !== "queued" && current.state !== "running") {
          if (current.state === "failed") {
            setLifecycleErr(`server ${kind} failed — ${jobSummary(current)}`);
          } else {
            setLifecycleMsg(`${kind} finished (${jobSummary(current)}); server state: ${s?.state ?? "?"}`);
          }
          jobs.refresh();
          return;
        }
      }
      setLifecycleMsg(`${kind} is still running — use Refresh to check again`);
    } catch (e) {
      setLifecycleErr(errorText(e));
    } finally { setLifecycleBusy(""); }
  }

  async function sendConsole() {
    if (!consoleInput.trim()) { setConsoleErr("Type a console command first."); return; }
    setConsoleErr("");
    try {
      await bridge().server.console(consoleInput);
      setConsoleInput("");
    } catch (e) {
      setConsoleErr(errorText(e));
    }
  }

  async function restore(id: string) {
    setBackupErr(""); setPackMsg("");
    try {
      const r = (await bridge().server.restoreBackup(id)) as { id?: string };
      setPackMsg(`restore requested — job ${String(r.id ?? "?").slice(0, 8)}`);
      jobs.refresh(); backups.refresh();
    } catch (e) { setBackupErr(errorText(e)); }
  }

  async function removeMod(modId: string) {
    setPackErr(""); setPackMsg("");
    try {
      const r = await bridge().server.removeMod(modId);
      setPackMsg(`remove ${modId} requested — job ${String(r.id).slice(0, 8)}`);
      jobs.refresh();
    } catch (e) { setPackErr(errorText(e)); }
  }

  /** Detail view: fetch the full job from GET /jobs/{id}. A late response must
   *  never re-open a dialog the user already dismissed. */
  async function openJob(id: string) {
    jobDetailId.current = id;
    setJobDetailErr("");
    setSelectedJob(jobRows.find((j) => j.id === id) ?? null);
    try {
      const job = await bridge().server.job(id);
      if (jobDetailId.current === id) setSelectedJob(job);
    } catch (e) {
      if (jobDetailId.current === id) setJobDetailErr(errorText(e));
    }
  }

  function closeJob() {
    jobDetailId.current = null;
    setSelectedJob(null);
  }

  const manifest = pack.data?.manifest ?? null;
  const jobRows = useMemo(() => jobs.data?.jobs ?? [], [jobs.data]);

  return h("div", null,
    offline && h(Banner, { kind: "err" },
      `the backend at ${conn.serverUrl} is unreachable (${status.error || jobs.error}). Everything below is stale — start the backend or fix the URL.`),

    // ------------------------------------------------------------ lifecycle
    h("div", { className: "panel" },
      h("div", { className: "row" },
        h("h2", { style: { margin: 0 } }, "Server lifecycle"),
        h("span", { className: `tag ${st ? stateTag(st.state).cls : ""}` }, st ? stateTag(st.state).label : (status.error ? "unreachable" : "…")),
        st?.pid ? h("span", { className: "muted" }, `pid ${st.pid}`) : null,
        st?.startedAt ? h("span", { className: "muted" }, `up ${fmtDuration(st.startedAt)}`) : null,
        h("span", { className: "spacer" }),
        h("button", { onClick: () => { status.refresh(); jobs.refresh(); backups.refresh(); pack.refresh(); } }, "Refresh")),
      h("div", { className: "row", style: { marginTop: 8 } },
        h("button", { onClick: () => op("start"), disabled: lifecycleBusy !== "" || st?.state === "running" },
          lifecycleBusy === "start" ? "Starting…" : "Start"),
        h("button", { className: "secondary", onClick: () => op("stop"), disabled: lifecycleBusy !== "" || st?.state === "stopped" },
          lifecycleBusy === "stop" ? "Stopping…" : "Stop"),
        h("button", { className: "secondary", onClick: () => op("restart"), disabled: lifecycleBusy !== "" },
          lifecycleBusy === "restart" ? "Restarting…" : "Restart"),
        h("button", { className: "link", onClick: onChangeKey }, "change admin key")),
      lifecycleMsg && h("p", { className: "ok" }, lifecycleMsg),
      lifecycleErr && h(Banner, { kind: "err" }, lifecycleErr),
      st?.autoRestartCount ? h("p", { className: "warn" }, `auto-restart attempts: ${st.autoRestartCount}`) : null,
      st?.pendingRestart ? h("p", { className: "warn" }, "pack changes are pending — restart the server to apply them") : null,
      (st?.restartRequired || pack.data?.restartRequired) && h("div", { className: "row" },
        h("span", { className: "warn", style: { flex: 1 } }, "restartRequired is set on the manifest."),
        h("button", { className: "secondary", onClick: async () => {
          try { await bridge().server.restartAck(); status.refresh(); setLifecycleMsg("restart acknowledged (restartRequired cleared)"); }
          catch (e) { setLifecycleErr(errorText(e)); }
        } }, "Acknowledge restart"))),

    // -------------------------------------------------------------- console
    h("div", { className: "panel" },
      h("div", { className: "row" },
        h("h2", { style: { margin: 0 } }, "Server console"),
        h("span", { className: logsLive ? "ok" : "muted" }, logsLive ? "● live (SSE)" : "○ snapshot"),
        h("span", { className: "spacer" }),
        h("button", { className: "link", onClick: () => setLogs([]) }, "clear")),
      h("div", { className: "row", style: { marginTop: 8 } },
        h("input", {
          value: consoleInput, placeholder: "say hi", style: { flex: 1, minWidth: 160 },
          "aria-label": "console command",
          onChange: (e) => setConsoleInput(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") void sendConsole(); },
        }),
        h("button", { onClick: sendConsole, disabled: st?.state !== "running" }, "Send")),
      consoleErr && h("div", { className: "err", style: { marginTop: 6 } }, consoleErr),
      st?.state !== "running" && h("p", { className: "muted", style: { marginBottom: 0 } },
        "The console input is disabled because the managed server is not running."),
      h("pre", { ref: logRef }, logs.length ? logs.slice(-400).join("\n") : (status.error ? "(backend unreachable)" : "(no log lines yet)"))),

    // ----------------------------------------------------------------- jobs
    h("div", { className: "panel" },
      h("div", { className: "row" },
        h("h2", { style: { margin: 0 } }, "Recent jobs"),
        h("span", { className: "muted" }, `${jobRows.length} shown`),
        h("span", { className: "spacer" }),
        h("button", { onClick: () => jobs.refresh() }, "Refresh")),
      jobs.error && h(Banner, { kind: "err" }, jobs.error),
      !jobs.error && h("div", { className: "table-wrap" },
        h("table", { className: "jobs-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Job"), h("th", null, "Kind"), h("th", null, "State"),
            h("th", null, "Started"), h("th", null, "Duration"), h("th", null, "Progress"), h("th", null, "Result / failure reason"))),
          h("tbody", null, jobRows.map((j) => h("tr", { key: j.id, onClick: () => void openJob(j.id), style: { cursor: "pointer" } },
            h("td", { className: "muted" }, j.id.slice(0, 8)),
            h("td", null, j.kind),
            h("td", null, h("span", { className: `tag ${stateTag(j.state).cls}` }, stateTag(j.state).label)),
            h("td", { className: "muted" }, fmtDateTime(j.createdAt)),
            h("td", { className: "muted" }, fmtDuration(j.createdAt, j.updatedAt)),
            h("td", { className: "muted" }, j.progress !== null && j.progress !== undefined ? `${Math.round(j.progress * 100)}%` : "—"),
            h("td", { className: j.state === "failed" ? "err" : "" }, jobSummary(j)))))),
        jobRows.length === 0 && h("div", { className: "muted" },
          jobs.loading ? "loading jobs…" : "the backend reports no jobs yet (it is reachable)")),
      selectedJob && h(Modal, {
        title: `Job ${selectedJob.id}`, wide: true, onClose: closeJob,
        footer: h("button", { className: "secondary", onClick: closeJob }, "Close"),
      },
        h("div", { className: "kv" },
          h("dt", null, "Kind"), h("dd", null, selectedJob.kind),
          h("dt", null, "State"), h("dd", null, h("span", { className: `tag ${stateTag(selectedJob.state).cls}` }, selectedJob.state)),
          h("dt", null, "Created"), h("dd", null, fmtDateTime(selectedJob.createdAt)),
          h("dt", null, "Updated"), h("dd", null, fmtDateTime(selectedJob.updatedAt)),
          h("dt", null, "Duration"), h("dd", null, fmtDuration(selectedJob.createdAt, selectedJob.updatedAt)),
          h("dt", null, "Message"), h("dd", null, selectedJob.message ?? "—"),
          h("dt", null, "Progress"), h("dd", null, selectedJob.progress === null ? "—" : String(selectedJob.progress))),
        h("h2", { style: { marginTop: 14 } }, "Result"),
        h("pre", null, JSON.stringify(selectedJob.result ?? {}, null, 2)))),

    // ------------------------------------------------------------------ pack
    h("div", { className: "panel" },
      h("div", { className: "row" },
        h("h2", { style: { margin: 0 } }, "Pack management"),
        h("span", { className: "muted" }, `${manifest?.mods.length ?? 0} mod(s)`),
        h("span", { className: "spacer" }),
        h("button", { onClick: () => setAdding(true) }, "＋ Add mod")),
      pack.error && h(Banner, { kind: "err" }, pack.error),
      packMsg && h("p", { className: "ok" }, packMsg),
      packErr && h(Banner, { kind: "err" }, packErr),
      h("div", { className: "table-wrap" },
        h("table", null,
          h("thead", null, h("tr", null,
            h("th", null, "Mod"), h("th", null, "Version"), h("th", null, "Side"), h("th", null, "File"), h("th", null, "Actions"))),
          h("tbody", null, (manifest?.mods ?? []).map((m) => h("tr", { key: m.modId },
            h("td", null, m.name || m.modId),
            h("td", null, m.version),
            h("td", null, h("span", { className: `tag ${m.side}` }, m.side)),
            h("td", { className: "muted" }, m.file.filename),
            h("td", null,
              h("button", { className: "secondary", onClick: () => setAdding(true) }, "Update"),
              h("button", { className: "danger", onClick: () => void removeMod(m.modId) }, "Remove"))))))),
      adding && h(AddModModal, {
        initial: null,
        onClose: () => setAdding(false),
        onSubmit: async (payload, mode) => {
          setPackErr(""); setPackMsg("");
          try {
            const r = mode === "update"
              ? await bridge().server.updateMod(String(payload.modId), payload)
              : await bridge().server.addMod(payload);
            setPackMsg(`${mode} ${payload.modId} requested — job ${String(r.id).slice(0, 8)}`);
            setAdding(false);
            jobs.refresh();
          } catch (e) { setPackErr(errorText(e)); }
        },
      })),

    // --------------------------------------------------------------- backups
    h("div", { className: "panel" },
      h("div", { className: "row" },
        h("h2", { style: { margin: 0 } }, "Backups"),
        h("span", { className: "spacer" }),
        h("button", { onClick: () => backups.refresh() }, "Refresh")),
      backups.error && h(Banner, { kind: "err" }, backups.error),
      backupErr && h(Banner, { kind: "err" }, backupErr),
      h("div", { className: "table-wrap" },
        h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Backup"), h("th", null, "Created"), h("th", null, "Size"), h("th", null, ""))),
          h("tbody", null, (backups.data?.backups ?? []).map((b: BackupView) => h("tr", { key: b.id },
            h("td", null, b.reason ? `${b.id} (${b.reason})` : b.id),
            h("td", { className: "muted" }, b.createdAt ? fmtDateTime(b.createdAt) : "—"),
            h("td", { className: "muted" }, fmtBytes(b.size)),
            h("td", null, h("button", { className: "secondary", onClick: () => void restore(b.id) }, "Restore")))))),
      (backups.data?.backups ?? []).length === 0 && h("div", { className: "muted" },
        backups.loading ? "loading backups…" : "no backups yet"))),
  );
}

// ---------------------------------------------------------------- add mod

function AddModModal({ initial, onClose, onSubmit }: {
  initial: null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>, mode: "add" | "update") => void;
}) {
  const [mode, setMode] = useState<"add" | "update">("add");
  const [modId, setModId] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [side, setSide] = useState("both");
  const [url, setUrl] = useState("https://");
  const [filename, setFilename] = useState("");
  const [size, setSize] = useState("");
  const [sha1, setSha1] = useState("");
  const [err, setErr] = useState("");

  const payload = () => ({
    modId, name, version, side,
    file: { url, filename, size: Number(size), hashes: { sha1: sha1.toLowerCase() } },
  });

  return h(Modal, {
    title: mode === "add" ? "Add a mod to the server pack" : "Update a mod in the server pack",
    onClose, wide: true,
    footer: h("div", { className: "row" },
      h("button", { className: "secondary", onClick: onClose }, "Cancel"),
      h("button", { onClick: () => { setErr(""); submitPayload(); } }, mode === "add" ? "Add mod" : "Update mod")),
  },
    h("p", { className: "muted" }, "The backend downloads this file, verifies its sha1, backs up mods/ and applies it atomically. Client-only mods are rejected with side_mismatch."),
    h("div", { className: "form-grid" },
      h("label", { htmlFor: "am-mode" }, "Operation"),
      h("select", { id: "am-mode", value: mode, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setMode(e.target.value as "add" | "update") },
        h("option", { value: "add" }, "add (new mod)"),
        h("option", { value: "update" }, "update (existing mod)")),
      h("label", { htmlFor: "am-id" }, "modId"),
      h("input", { id: "am-id", value: modId, onChange: (e) => setModId(e.target.value), placeholder: "create" }),
      h("label", { htmlFor: "am-name" }, "Name"),
      h("input", { id: "am-name", value: name, onChange: (e) => setName(e.target.value), placeholder: "Create" }),
      h("label", { htmlFor: "am-ver" }, "Version"),
      h("input", { id: "am-ver", value: version, onChange: (e) => setVersion(e.target.value), placeholder: "6.0.4" }),
      h("label", { htmlFor: "am-side" }, "Side"),
      h("select", { id: "am-side", value: side, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setSide(e.target.value) },
        h("option", { value: "both" }, "both"),
        h("option", { value: "server" }, "server"),
        h("option", { value: "client" }, "client (rejected by the server)")),
      h("label", { htmlFor: "am-url" }, "File URL"),
      h("input", { id: "am-url", value: url, onChange: (e) => setUrl(e.target.value) }),
      h("label", { htmlFor: "am-file" }, "Filename"),
      h("input", { id: "am-file", value: filename, onChange: (e) => setFilename(e.target.value), placeholder: "create-6.0.4.jar" }),
      h("label", { htmlFor: "am-size" }, "Size (bytes)"),
      h("input", { id: "am-size", value: size, onChange: (e) => setSize(e.target.value), placeholder: "19834512" }),
      h("label", { htmlFor: "am-sha1" }, "sha1"),
      h("input", { id: "am-sha1", value: sha1, onChange: (e) => setSha1(e.target.value), placeholder: "40 hex characters" })),
    err && h("div", { className: "err" }, err));

  function submitPayload() {
    // validate the same way, then hand the structured payload up
    const problems: string[] = [];
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(modId)) problems.push("modId must be lowercase letters, digits, - or _ (max 64)");
    if (!name.trim()) problems.push("name is required");
    if (!version.trim()) problems.push("version is required");
    if (side === "client") problems.push("side=client mods are rejected by the server");
    if (!/^https?:\/\//i.test(url)) problems.push("the download URL must be http(s)");
    if (!filename.trim() || filename.includes("/") || filename.includes("..")) problems.push("filename must be a bare file name");
    if (!/^[0-9]+$/.test(size) || Number(size) <= 0) problems.push("size must be a positive number of bytes");
    if (!/^[0-9a-f]{40}$/i.test(sha1)) problems.push("sha1 must be 40 hex characters");
    if (problems.length) { setErr(problems.join("; ")); return; }
    onSubmit(payload(), mode);
  }
}

