/** Shared UI atoms + small hooks used by every screen. */
import { createElement as h, useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { sanitizeMessage } from "../shared/errors";
import { bridge } from "./bridge";
import type { Bridge } from "./bridge";

/** Error text that never leaks HTML bodies / IPC internals. */
export function errorText(e: unknown): string {
  return sanitizeMessage(e);
}

export function Banner({ kind = "err", children, onDismiss }: {
  kind?: "err" | "warn" | "ok"; children?: React.ReactNode; onDismiss?: () => void;
}) {
  if (!children) return null;
  return h("div", { className: `banner ${kind}` },
    h("div", { className: "row" },
      h("div", { style: { flex: 1, minWidth: 0 } }, children),
      onDismiss && h("button", { className: "link", onClick: onDismiss }, "dismiss")));
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: string; onClose: () => void; children?: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return h("div", { className: "modal-backdrop", onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose(); } },
    h("div", { className: "modal", style: wide ? { width: "min(760px, 100%)" } : undefined, role: "dialog", "aria-label": title },
      h("h2", null, title),
      children,
      footer && h("div", { className: "modal-foot" }, footer)));
}

export function Spinner({ label }: { label?: string }) {
  return h("span", { className: "muted" }, label ? `${label}…` : "…");
}

/** Poll an async function while the component is mounted. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): {
  data: T | null; error: string; loading: boolean; refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      try {
        const v = await fnRef.current();
        if (!stop) { setData(v); setError(""); }
      } catch (e) {
        if (!stop) setError(errorText(e));
      } finally {
        if (!stop) { setLoading(false); timer = setTimeout(run, ms); }
      }
    };
    setLoading(true);
    void run();
    return () => { stop = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, tick, ...deps]);
  return { data, error, loading, refresh };
}

/** Subscribe to a main-process event channel for the component's lifetime. */
type EventChannel = Parameters<Bridge["on"]>[0];

export function useEvent(channel: EventChannel, handler: (payload: any) => void, deps: unknown[] = []) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const off = bridge().on(channel, (payload) => ref.current(payload));
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, ...deps]);
}

// ------------------------------------------------------------- formatters

export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString();
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

export function fmtDuration(fromIso?: string | null, toIso?: string | null): string {
  if (!fromIso) return "—";
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to)) return "—";
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtBytes(n?: number | null): string {
  if (n === undefined || n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human description of a job's outcome, including the failure reason. */
export function jobSummary(job: { state: string; message?: string | null; result?: Record<string, unknown> | null }): string {
  const result = job.result ?? {};
  if (job.state === "failed") {
    const msg = (result.message as string) ?? job.message;
    const code = (result.error as string) ?? "";
    return msg ? `${code ? `${code}: ` : ""}${msg}` : "failed (no reason reported)";
  }
  if (job.state === "succeeded") {
    const keys = Object.keys(result);
    if (keys.length === 0) return "ok";
    if (typeof result.state === "string") return `state → ${result.state}`;
    return `ok (${keys.join(", ")})`;
  }
  return job.message ?? job.state;
}

export function stateTag(state: string): { cls: string; label: string } {
  switch (state) {
    case "running": return { cls: "ok", label: "running" };
    case "starting": return { cls: "warn", label: "starting" };
    case "stopping": return { cls: "warn", label: "stopping" };
    case "stopped": return { cls: "warn", label: "stopped" };
    case "error": return { cls: "err", label: "error" };
    case "succeeded": return { cls: "ok", label: "succeeded" };
    case "failed": return { cls: "err", label: "failed" };
    case "queued": return { cls: "warn", label: "queued" };
    default: return { cls: "", label: state };
  }
}
