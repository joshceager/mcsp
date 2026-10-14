/** REST client for a single MCSP backend (the trusted server the player chose).
 *  Plain HTTP is supported; reverse proxies (Caddy/Tailscale) sit in front.
 */
import type { PackView, ServerStatus, JobView } from "../../shared/types";
import type { ClientSettings } from "./store";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export class ApiClient {
  constructor(private getSettings: () => ClientSettings) {}

  private base(): string {
    const url = this.getSettings().serverUrl.replace(/\/+$/, "");
    if (!url) throw new ApiError(0, "no_server", "No server configured");
    return url;
  }

  private headers(admin = false): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const s = this.getSettings();
    if (admin && s.adminKey) h["Authorization"] = `Bearer ${s.adminKey}`;
    return h;
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    admin = false,
  ): Promise<T> {
    let resp: Response;
    try {
      resp = await fetch(this.base() + path, {
        method,
        headers: this.headers(admin),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, "network_error", `cannot reach ${this.base()}: ${String(e)}`);
    }
    const text = await resp.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text };
    }
    if (!resp.ok) {
      const b = json as { error?: string; message?: string; detail?: string } | null;
      throw new ApiError(
        resp.status,
        b?.error ?? "http_error",
        b?.message ?? b?.detail ?? `HTTP ${resp.status} on ${path}`,
      );
    }
    return json as T;
  }

  // ------------------------------------------------------------ public
  health() {
    return this.req<{ ok: boolean; adminEnabled: boolean }>("GET", "/api/v1/health");
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
    return this.req<{ id: string }>("PUT", `/api/v1/pack/mods/${modId}`, payload, true);
  }
  removeMod(modId: string) {
    return this.req<{ id: string }>("DELETE", `/api/v1/pack/mods/${modId}`, undefined, true);
  }
  jobs(limit = 50) {
    return this.req<{ jobs: JobView[] }>("GET", `/api/v1/jobs?limit=${limit}`, undefined, true);
  }
  job(id: string) {
    return this.req<JobView>("GET", `/api/v1/jobs/${id}`, undefined, true);
  }
  restartAck() {
    return this.req("POST", "/api/v1/pack/restart-ack", undefined, true);
  }
}
