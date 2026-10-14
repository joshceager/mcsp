/** Persistent settings (JSON in the Electron userData dir). */
import { app } from "electron";
import { promises as fs } from "fs";
import { join } from "path";

export interface ClientSettings {
  serverUrl: string;          // e.g. http://host:8080 (HTTP is fine; reverse-proxyable)
  adminKey: string;           // stored only on this machine; used for server management
  gameDir: string;            // instance directory (mods/ + launcher assets)
  playerName: string;
  autoStartServer: boolean;   // start server when admin panel opens (if permitted)
}

const DEFAULTS: ClientSettings = {
  serverUrl: "",
  adminKey: "",
  gameDir: "",
  playerName: "Player",
  autoStartServer: false,
};

const FILE = "mcsp-client-settings.json";

export class SettingsStore {
  private data: ClientSettings = { ...DEFAULTS };
  private path = "";

  async load(): Promise<ClientSettings> {
    try {
      this.path = join(app.getPath("userData"), FILE);
      const raw = await fs.readFile(this.path, "utf-8");
      this.data = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  get(): ClientSettings {
    return this.data;
  }

  async set(patch: Partial<ClientSettings>): Promise<ClientSettings> {
    this.data = { ...this.data, ...patch };
    if (!this.path) {
      this.path = join(app.getPath("userData"), FILE);
    }
    await fs.writeFile(this.path, JSON.stringify(this.data, null, 2), "utf-8");
    return this.data;
  }
}
