/** Loader provisioning: ensure the local instance has the NeoForge profile
 *  the manifest demands (version + libraries). Reuses the official installer
 *  artifacts from maven.neoforged.net — same source the backend uses. */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { downloadFile } from "./download";

const MAVEN = "https://maven.neoforged.net/releases";

export interface ProvisionResult {
  javaBin: string;
  loaderVersion: string;
  action: "already-installed" | "installed" | "reinstalled";
}

export class ProvisionService {
  constructor(
    private gameDir: string,
    private runtimeDir: string,
    private log: (msg: string) => void,
  ) {}

  markerPath(): string {
    return join(this.gameDir, "mcsp-provision.json");
  }

  async readMarker(): Promise<{ loaderVersion: string; javaBin?: string } | null> {
    try {
      return JSON.parse(await fs.readFile(this.markerPath(), "utf-8"));
    } catch {
      return null;
    }
  }

  /** Ensure NeoForge client libraries for loaderVersion are present locally. */
  async ensure(
    manifest: { minecraftVersion: string; loaderVersion: string },
    ensureJava: (dir: string) => Promise<string>,
  ): Promise<ProvisionResult> {
    const javaBin = await ensureJava(this.runtimeDir);
    const marker = await this.readMarker();
    if (marker && marker.loaderVersion === manifest.loaderVersion) {
      this.log(`loader ${manifest.loaderVersion} already provisioned`);
      return { javaBin, loaderVersion: manifest.loaderVersion, action: "already-installed" };
    }
    this.log(`installing NeoForge ${manifest.loaderVersion} (MC ${manifest.minecraftVersion})…`);
    await this.runInstaller(manifest.loaderVersion, manifest.minecraftVersion, javaBin);
    await fs.writeFile(
      this.markerPath(),
      JSON.stringify(
        { loaderVersion: manifest.loaderVersion, javaBin, installedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    this.log(`NeoForge ${manifest.loaderVersion} installed`);
    return {
      javaBin,
      loaderVersion: manifest.loaderVersion,
      action: marker ? "reinstalled" : "installed",
    };
  }

  private async runInstaller(
    loaderVersion: string,
    mcVersion: string,
    javaBin: string,
  ): Promise<void> {
    // The NeoForge "installer" jar supports headless client installs:
    //   java -jar installer.jar --installClient <dir>
    const installerUrl =
      `${MAVEN}/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
    const installerPath = join(this.runtimeDir, `neoforge-${loaderVersion}-installer.jar`);
    this.log(`downloading NeoForge installer…`);
    await downloadFile({ url: installerUrl, dest: installerPath });
    await new Promise<void>((resolve, reject) => {
      execFile(
        javaBin,
        ["-jar", installerPath, "--installClient", this.gameDir],
        { cwd: this.gameDir },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`NeoForge installer failed: ${String(stderr || stdout)}`));
          } else {
            resolve();
          }
        },
      );
    });
    // Confirm the profile landed where the launcher expects it.
    const profile = join(this.gameDir, "versions", `neoforge-${mcVersion}`);
    const ok = await fs
      .access(profile)
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      throw new Error(
        `installer finished but no profile dir found at versions/neoforge-${mcVersion}`,
      );
    }
  }
}
