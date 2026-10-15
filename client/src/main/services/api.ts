/** REST client for the active MCSP backend (the trusted server the player chose).
 *  Plain HTTP is supported; reverse proxies (Caddy/Tailscale) sit in front.
 *  Every error message is sanitized before it can reach the UI. */
import { sanitizeMessage } from "../../shared/errors";
import type { BackupView, ConnectVerify, JobView, PackView, ServerStatus } from "../../shared/types";
import type { ClientSettings } from "./store";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(sanitizeMessage(message));
    this.name = "ApiError";
  }
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

interface Endpoint { url: string; adminKey: string }

export class ApiClient {
  constructor(private getSettings: () => ClientSettings) {}

  private active(): Endpoint | null {
    const s = this.getSettings();
    const conn = s.connections.find((c) => c.id === s.activeConnectionId);
    if (conn) return { url: conn.serverUrl, adminKey: conn.adminKey };
    if (s.serverUrl) return { url: s.serverUrl, adminKey: s.adminKey };
    return null;
  }

  base(): string {
    const a = this.active();
    if (!a) throw new ApiError(0, "no_server", "No server selected — add a connection first.");
    return normalizeBaseUrl(a.url);
  }

  private headers(admin = false): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const a = this.active();
    if (admin && a?.adminKey) h["Authorization"] = `Bearer ${a.adminKey}`;
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown, admin = false): Promise<T> {
    return request<T>(this.base(), path, method, body, this.headers(admin));
  }

  // ------------------------------------------------------------ public
  health() {
    return this.req<{ ok: boolean; service?: string; adminEnabled: boolean }>("GET", "/api/v1/health");
  }
  status() {
    return this.req<ServerStatus>("GET", "/api/v1/status");
  }
  pack() {
    return this.req<PackView>("GET", "/api/v1/pack");
  }

  // ------------------------------------------------------------ admin
  logs(limit = 200) {
    return this.req<{ lines: string[] }>("GET", `/api/v1/logs?limit=${limit}`, undefined, true);
  }
  sendConsole(line: string) {
    return this.req<{ sent: boolean }>("POST", "/api/v1/server/console", { line }, true);
  }
  serverOp(kind: "start" | "stop" | "restart") {
    return this.req<{ id: string }>("POST", `/api/v1/server/${kind}`, undefined, true);
  }
  addMod(payload: Record<string, unknown>) {
    return this.req<{ id: string }>("POST", "/api/v1/pack/mods", payload, true);
  }
  updateMod(modId: string, payload: Record<string, unknown>) {
    return this.req<{ id: string }>("PUT", `/api/v1/pack/mods/${encodeURIComponent(modId)}`, payload, true);
  }
  removeMod(modId: string) {
    return this.req<{ id: string }>("DELETE", `/api/v1/pack/mods/${encodeURIComponent(modId)}`, undefined, true);
  }
  jobs(limit = 50) {
    return this.req<{ jobs: JobView[] }>("GET", `/api/v1/jobs?limit=${limit}`, undefined, true);
  }
  job(id: string) {
    return this.req<JobView>("GET", `/api/v1/jobs/${encodeURIComponent(id)}`, undefined, true);
  }
  backups() {
    return this.req<{ backups: BackupView[] }>("GET", "/api/v1/backups", undefined, true);
  }
  restoreBackup(id: string) {
    return this.req<{ id: string }>("POST", `/api/v1/backups/${encodeURIComponent(id)}/restore`, undefined, true);
  }
  restartAck() {
    return this.req<{ restartRequired: boolean }>("POST", "/api/v1/pack/restart-ack", undefined, true);
  }

  /** Validate the configured admin key against a real admin endpoint. */
  async probeAdmin(): Promise<{ ok: boolean; adminEnabled: boolean; message: string }> {
    const h = this.headers(true);
    if (!h["Authorization"]) return { ok: false, adminEnabled: false, message: "no admin key set for this connection" };
    const health = await this.health().catch(() => null);
    const adminEnabled = health?.adminEnabled ?? false;
    try {
      await this.jobs(1);
      return { ok: true, adminEnabled, message: "key accepted" };
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) return { ok: false, adminEnabled, message: "the server rejected this admin key (401 unauthorized)" };
      if (err.status === 503) return { ok: false, adminEnabled, message: "this server has admin operations disabled (no MCSP_ADMIN_KEY configured)" };
      return { ok: false, adminEnabled, message: err.message };
    }
  }
}

async function request<T>(
  base: string,
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  if (!base) throw new ApiError(0, "no_server", "No server selected — add a connection first.");
  let resp: Response;
  try {
    resp = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, "network_error", `cannot reach ${base}: ${sanitizeMessage(e)}`);
  }
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const b = json as { error?: string; message?: string; detail?: string } | null;
    throw new ApiError(
      resp.status,
      b?.error ?? "http_error",
      b?.message ?? b?.detail ?? (text && json === null ? text : `HTTP ${resp.status} on ${path}`),
    );
  }
  if (json === null) {
    throw new ApiError(resp.status, "bad_json", `${base}${path} did not return JSON${text ? ` — ${sanitizeMessage(text, 120)}` : ""}`);
  }
  return json as T;
}

/** Probe an arbitrary URL to confirm it is an MCSP backend (not just any 200). */
export async function verifyBackend(rawUrl: string, adminKey = ""): Promise<ConnectVerify> {
  const url = normalizeBaseUrl(rawUrl);
  if (!url) throw new ApiError(0, "bad_url", "Enter a server URL, e.g. http://host:8080");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(0, "bad_url", `"${rawUrl}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(0, "bad_url", "the URL must start with http:// or https://");
  }
  const headers: Record<string, string> = {};
  if (adminKey) headers["Authorization"] = `Bearer ${adminKey}`;
  let resp: Response;
  try {
    resp = await fetch(`${url}/api/v1/health`, { headers });
  } catch (e) {
    throw new ApiError(0, "network_error", `cannot reach ${url}: ${sanitizeMessage(e)}`);
  }
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  if (resp.status === 404) {
    throw new ApiError(404, "not_mcsp", `${url} answered but has no /api/v1/health — it is not an MCSP backend`);
  }
  if (!resp.ok) {
    throw new ApiError(resp.status, "http_error", `health check failed: HTTP ${resp.status} ${sanitizeMessage(text, 120)}`);
  }
  if (!json || json.ok !== true || json.service !== "mcsp-backend") {
    throw new ApiError(200, "not_mcsp", `${url} responded but is not an MCSP backend (unexpected /api/v1/health payload)`);
  }
  return {
    ok: true,
    url,
    adminEnabled: Boolean(json.adminEnabled),
    version: (json.version as number | string) ?? undefined,
    service: String(json.service),
  };
}
