/** Persistent settings (JSON in the Electron userData dir). */
import { app } from "electron";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";

/** One saved backend connection. */
export interface SavedConnection {
  id: string;          // stable uuid
  name: string;        // display name shown in sidebar / home tiles
  serverUrl: string;   // e.g. http://host:8080
  adminKey: string;    // stored only on this machine; used for server management
}

export interface ClientSettings {
  serverUrl: string;          // legacy single-server field (kept for migration)
  adminKey: string;           // legacy single-server field (kept for migration)
  gameDir: string;            // legacy single-instance dir (kept for migration only)
  playerName: string;
  azureClientId: string;      // Azure app registration id for Microsoft sign-in
  autoStartServer: boolean;   // start server when admin panel opens (if permitted)
  connections: SavedConnection[];
  activeConnectionId: string | null;
}

const DEFAULTS: ClientSettings = {
  serverUrl: "",
  adminKey: "",
  gameDir: "",
  playerName: "Player",
  azureClientId: "",
  autoStartServer: false,
  connections: [],
  activeConnectionId: null,
};

const FILE = "mcsp-client-settings.json";

export class SettingsStore {
  private data: ClientSettings = { ...DEFAULTS };
  private path = "";

  async load(): Promise<ClientSettings> {
    try {
      this.path = join(app.getPath("userData"), FILE);
      const raw = await fs.readFile(this.path, "utf-8");
      const parsed = { ...DEFAULTS, ...JSON.parse(raw) } as ClientSettings;
      this.data = this.migrate(parsed);
    } catch {
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  /** Migrate legacy single-server settings into the connections list. */
  private migrate(s: ClientSettings): ClientSettings {
    const out: ClientSettings = { ...DEFAULTS, ...s, connections: s.connections ?? [] };
    if (out.connections.length === 0 && out.serverUrl) {
      const conn: SavedConnection = {
        id: randomUUID(),
        name: "My server",
        serverUrl: out.serverUrl,
        adminKey: out.adminKey,
      };
      out.connections = [conn];
      out.activeConnectionId = conn.id;
    }
    // keep legacy fields in sync with the active connection so old code paths work
    const active = out.connections.find((c) => c.id === out.activeConnectionId) ?? null;
    if (active) {
      out.serverUrl = active.serverUrl;
      out.adminKey = active.adminKey;
    }
    return out;
  }

  get(): ClientSettings {
    return this.data;
  }

  async set(patch: Partial<ClientSettings>): Promise<ClientSettings> {
    this.data = { ...this.data, ...patch };
    // keep legacy mirror fields consistent with the active connection
    const active = this.data.connections.find((c) => c.id === this.data.activeConnectionId) ?? null;
    this.data.serverUrl = active?.serverUrl ?? this.data.serverUrl;
    this.data.adminKey = active?.adminKey ?? this.data.adminKey;
    if (!this.path) {
      this.path = join(app.getPath("userData"), FILE);
    }
    await fs.writeFile(this.path, JSON.stringify(this.data, null, 2), "utf-8");
    return this.data;
  }
}
