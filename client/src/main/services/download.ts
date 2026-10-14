/** Streaming file downloads with size cap + sha1 verification + progress. */
import { createHash } from "crypto";
import { createWriteStream, promises as fs } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

export interface DownloadOptions {
  url: string;
  dest: string;
  expectedSha1?: string;
  maxBytes?: number;
  onProgress?: (received: number, total: number | null) => void;
  signal?: AbortSignal;
}

export async function downloadFile(opts: DownloadOptions): Promise<void> {
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;
  const resp = await fetch(opts.url, { signal: opts.signal });
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status} for ${opts.url}`);
  const totalHeader = resp.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : null;
  if (total !== null && total > maxBytes) {
    throw new Error(`download too large: ${total} > ${maxBytes} bytes`);
  }
  if (!resp.body) throw new Error(`empty body for ${opts.url}`);
  const hash = createHash("sha1");
  let received = 0;
  const reader = Readable.fromWeb(resp.body as never);
  const tmp = opts.dest + ".tmp";
  await fs.mkdir(join(opts.dest, ".."), { recursive: true });
  const out = createWriteStream(tmp);
  reader.on("data", (chunk: Buffer) => {
    received += chunk.length;
    hash.update(chunk);
    if (received > maxBytes) {
      reader.destroy(new Error(`download too large: exceeded ${maxBytes} bytes`));
      return;
    }
    opts.onProgress?.(received, total);
  });
  try {
    await pipeline(reader, out);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  const sha1 = hash.digest("hex");
  if (opts.expectedSha1 && sha1 !== opts.expectedSha1.toLowerCase()) {
    await fs.rm(tmp, { force: true });
    throw new Error(
      `hash mismatch for ${opts.dest}: expected ${opts.expectedSha1}, got ${sha1}`,
    );
  }
  await fs.rename(tmp, opts.dest);
}
