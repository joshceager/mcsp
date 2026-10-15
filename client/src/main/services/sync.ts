/** Applies a SyncPlan to the local game dir: downloads + removals + record keeping.
 *  The side filtering itself is done in shared/sync.ts (planSync). */
import { createHash } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { downloadFile } from "./net";
import { planSync } from "../../shared/sync";
import type { InstalledMod, Manifest, SyncPlan } from "../../shared/types";

export class SyncEngine {
  constructor(
    private gameDir: string,
    private onProgress: (msg: string) => void,
  ) {}

  modsDir(): string {
    return join(this.gameDir, "mods");
  }

  async installedMods(): Promise<InstalledMod[]> {
    const dir = this.modsDir();
    await fs.mkdir(dir, { recursive: true });
    const out: InstalledMod[] = [];
    for (const name of await fs.readdir(dir)) {
      const p = join(dir, name);
      const st = await fs.stat(p).catch(() => null);
      if (!st || !st.isFile() || !/\.(jar|jar\.disabled|disabled)$/i.test(name)) continue;
      const buf = await fs.readFile(p);
      out.push({
        filename: name,
        sha1: createHash("sha1").update(buf).digest("hex"),
        size: st.size,
      });
    }
    return out;
  }

  async plan(manifest: Manifest, removeUnknown = true): Promise<SyncPlan> {
    return planSync(manifest, await this.installedMods(), { removeUnknown });
  }

  /** Execute the plan; returns per-step messages. Throws on first failure. */
  async apply(plan: SyncPlan): Promise<string[]> {
    const log: string[] = [];
    const dir = this.modsDir();
    await fs.mkdir(dir, { recursive: true });

    // Removals first (superseded files), with a one-time backup.
    if (plan.removals.length) {
      const backupDir = join(this.gameDir, "mcsp-backup", new Date().toISOString().replace(/[:.]/g, "-"));
      for (const r of plan.removals) {
        const target = join(dir, r.filename);
        try {
          await fs.copyFile(target, join(backupDir, r.filename));
        } catch { /* file may already be gone */ }
        await fs.rm(target, { force: true });
        log.push(`removed ${r.filename} (${r.reason})`);
        this.onProgress(log[log.length - 1]);
      }
    }

    for (const d of plan.downloads) {
      if (!d.url || !d.sha1) throw new Error(`incomplete download action for ${d.filename}`);
      this.onProgress(`downloading ${d.filename}…`);
      const dest = join(dir, d.filename);
      if (dest !== join(dir, d.filename)) throw new Error("unsafe filename");
      await downloadFile({
        url: d.url,
        dest,
        expectedSha1: d.sha1,
        onProgress: (got, total) =>
          this.onProgress(
            `downloading ${d.filename}: ${got}${total ? `/${total}` : ""} bytes`,
          ),
      });
      log.push(`downloaded ${d.filename}`);
    }
    return log;
  }

  async writeLocalRecord(manifest: Manifest, plan: SyncPlan): Promise<void> {
    const record = {
      updatedAt: new Date().toISOString(),
      minecraftVersion: manifest.minecraftVersion,
      loaderVersion: manifest.loaderVersion,
      mods: await this.installedMods(),
      lastPlan: plan,
    };
    await fs.mkdir(this.gameDir, { recursive: true });
    await fs.writeFile(join(this.gameDir, "mcsp-installed.json"), JSON.stringify(record, null, 2), "utf-8");
  }
}
