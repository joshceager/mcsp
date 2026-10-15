/** HTTP helpers for the main process: JSON fetch with retries, streaming
 *  downloads with sha1 verification, size caps and progress reporting. */
import { createHash } from "crypto";
import { createWriteStream, promises as fs } from "fs";
import { dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { sanitizeMessage } from "../../shared/errors";

export class NetError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(sanitizeMessage(message));
  }
}

const MAX_BYTES = 512 * 1024 * 1024;

export async function fetchJson<T>(url: string, init?: RequestInit & { retries?: number }): Promise<T> {
  const retries = init?.retries ?? 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { ...init, retries: undefined } as RequestInit);
      const text = await resp.text();
      if (!resp.ok) {
        throw new NetError("http_error", `HTTP ${resp.status} for ${url}${explainBody(text)}`, resp.status);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new NetError("bad_json", `${url} did not return JSON${explainBody(text)}`, resp.status);
      }
    } catch (e) {
      lastErr = e;
      // 4xx are not retryable — surface immediately.
      if (e instanceof NetError && e.status >= 400 && e.status < 500) throw e;
      if (attempt < retries) await delay(400 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new NetError("network_error", String(lastErr));
}

function explainBody(text: string): string {
  if (!text) return "";
  const s = sanitizeMessage(text, 120);
  return s.startsWith("the server returned an HTML page") ? ` (${s})` : "";
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface DownloadOptions {
  url: string;
  dest: string;
  expectedSha1?: string;
  expectedSize?: number;
  maxBytes?: number;
  onProgress?: (received: number, total: number | null) => void;
  retries?: number;
}

/** Download to `dest` atomically (tmp + rename), verifying size and sha1. */
export async function downloadFile(opts: DownloadOptions): Promise<void> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const retries = opts.retries ?? 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await downloadOnce(opts, maxBytes);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await delay(500 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function downloadOnce(opts: DownloadOptions, maxBytes: number): Promise<void> {
  if (opts.expectedSize !== undefined && (await sizeOf(opts.dest)) === opts.expectedSize) return;
  await fs.mkdir(dirname(opts.dest), { recursive: true });
  let resp: Response;
  try {
    resp = await fetch(opts.url);
  } catch (e) {
    throw new NetError("network_error", `cannot download ${opts.url}: ${sanitizeMessage(e)}`);
  }
  if (!resp.ok) throw new NetError("http_error", `download failed: HTTP ${resp.status} for ${opts.url}`, resp.status);
  const totalHeader = resp.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : (opts.expectedSize ?? null);
  if (total !== null && total > maxBytes) {
    throw new NetError("too_large", `refusing ${opts.url}: ${total} bytes exceeds the ${maxBytes} byte cap`);
  }
  if (!resp.body) throw new NetError("empty_body", `empty response body for ${opts.url}`);
  const hash = createHash("sha1");
  let received = 0;
  const tmp = `${opts.dest}.part`;
  const reader = Readable.fromWeb(resp.body as never);
  reader.on("data", (chunk: Buffer) => {
    received += chunk.length;
    hash.update(chunk);
    if (received > maxBytes) {
      reader.destroy(new NetError("too_large", `download exceeded the ${maxBytes} byte cap`));
      return;
    }
    opts.onProgress?.(received, total);
  });
  try {
    await pipeline(reader, createWriteStream(tmp));
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e instanceof Error ? e : new Error(String(e));
  }
  const sha1 = hash.digest("hex");
  const want = opts.expectedSha1?.toLowerCase();
  if (want && sha1 !== want) {
    await fs.rm(tmp, { force: true });
    throw new NetError("hash_mismatch", `checksum mismatch for ${opts.dest} (expected ${want.slice(0, 12)}…, got ${sha1.slice(0, 12)}…)`);
  }
  await fs.rename(tmp, opts.dest);
}

async function sizeOf(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

export async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

/** Run `worker` over `items` with bounded concurrency. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

export function joinPosix(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}
