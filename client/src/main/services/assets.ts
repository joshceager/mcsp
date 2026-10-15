/** Minecraft asset pipeline: the asset index and every referenced object.
 *  Without this the client starts without textures/sounds/languages (the
 *  launcher used to pass --assetIndex with nothing ever downloaded). */
import { promises as fs } from "fs";
import { join } from "path";
import { downloadFile, exists, mapLimit } from "./net";

export interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>;
  map_to_resources?: boolean;
  virtual?: boolean;
}

export interface AssetProgress {
  phase: "index" | "objects" | "done";
  done: number;
  total: number;
  bytes: number;
  message?: string;
}

export const ASSET_HOST = "https://resources.download.minecraft.net";

export class AssetStore {
  constructor(private assetsDir: string, private objectBase: string = ASSET_HOST) {}

  indexDir(): string { return join(this.assetsDir, "indexes"); }
  objectsDir(): string { return join(this.assetsDir, "objects"); }

  indexFile(indexId: string): string {
    return join(this.indexDir(), `${indexId}.json`);
  }

  objectPath(hash: string): string {
    return join(this.objectsDir(), hash.slice(0, 2), hash);
  }

  /** Download the index (if needed) and all objects it references. */
  async ensure(
    indexId: string,
    indexUrl: string,
    onProgress?: (p: AssetProgress) => void,
    maxBytes = 512 * 1024 * 1024,
  ): Promise<{ index: AssetIndex; downloaded: number; skipped: number }> {
    await fs.mkdir(this.indexDir(), { recursive: true });
    const indexPath = this.indexFile(indexId);
    if (!(await exists(indexPath))) {
      onProgress?.({ phase: "index", done: 0, total: 1, bytes: 0, message: `downloading asset index ${indexId}` });
      await downloadFile({ url: indexUrl, dest: indexPath, maxBytes: 32 * 1024 * 1024 });
    }
    const raw = JSON.parse(await fs.readFile(indexPath, "utf-8")) as AssetIndex;
    const objects = Object.entries(raw.objects ?? {});
    const total = objects.length;
    let done = 0;
    let downloaded = 0;
    let skipped = 0;
    let bytes = 0;
    const concurrency = 8;

    await mapLimit(objects, concurrency, async ([, obj]) => {
      const dest = this.objectPath(obj.hash);
      if (await exists(dest)) {
        skipped++;
      } else {
        await fs.mkdir(join(this.objectsDir(), obj.hash.slice(0, 2)), { recursive: true });
        await downloadFile({
          url: `${this.objectBase}/${obj.hash.slice(0, 2)}/${obj.hash}`,
          dest,
          expectedSha1: obj.hash,
          expectedSize: obj.size,
          maxBytes: 64 * 1024 * 1024,

        });
        downloaded++;
        bytes += obj.size;
      }
      done++;
      if (done % 25 === 0 || done === total) {
        onProgress?.({ phase: "objects", done, total, bytes, message: `assets ${done}/${total}` });
      }
    });

    onProgress?.({ phase: "done", done: total, total, bytes, message: `assets ready (${downloaded} downloaded, ${skipped} cached)` });
    return { index: raw, downloaded, skipped };
  }

  /** True when every object in the index is already on disk. */
  async isComplete(indexId: string): Promise<boolean> {
    try {
      const raw = JSON.parse(await fs.readFile(this.indexFile(indexId), "utf-8")) as AssetIndex;
      const list = Object.values(raw.objects ?? {});
      if (list.length === 0) return false;
      let missing = 0;
      await mapLimit(list, 16, async (o) => { if (!(await exists(this.objectPath(o.hash)))) missing++; return 0; });
      return missing === 0;
    } catch {
      return false;
    }
  }
}
