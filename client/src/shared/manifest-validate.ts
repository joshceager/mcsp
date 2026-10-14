/** Minimal client-side manifest validation (defense in depth; the backend
 *  validates too, but the manifest arrives over the network). */
import type { Manifest, ManifestValidation } from "./types";

const MOD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA1_RE = /^[a-f0-9]{40}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse+validate an unknown blob into a Manifest, with a problems list. */
export function validateManifest(data: unknown): ManifestValidation & { manifest?: Manifest } {
  const problems: string[] = [];
  if (!isRecord(data)) {
    return { ok: false, problems: ["manifest is not a JSON object"] };
  }
  if (data.formatVersion !== 1) {
    problems.push(`unsupported formatVersion ${String(data.formatVersion)} (expected 1)`);
  }
  for (const k of ["loader", "loaderVersion", "minecraftVersion"]) {
    if (typeof data[k] !== "string" || !(data[k] as string).length) {
      problems.push(`missing required field: ${k}`);
    }
  }
  if (!Array.isArray(data.mods)) {
    problems.push("mods must be an array");
    return { ok: false, problems };
  }
  const seen = new Set<string>();
  (data.mods as unknown[]).forEach((m, i) => {
    const ctx = `mods[${i}]`;
    if (!isRecord(m)) return problems.push(`${ctx} is not an object`);
    const id = m.modId;
    if (typeof id !== "string" || !MOD_ID_RE.test(id)) {
      problems.push(`${ctx}.modId invalid: ${String(id)}`);
      return;
    }
    if (seen.has(id)) problems.push(`${ctx}.modId duplicate: ${id}`);
    seen.add(id);
    if (!["client", "server", "both"].includes(String(m.side))) {
      problems.push(`${ctx}.side invalid: ${String(m.side)}`);
    }
    const f = m.file;
    if (!isRecord(f)) return problems.push(`${ctx}.file missing`);
    if (typeof f.url !== "string" || !/^https?:\/\//i.test(f.url)) {
      problems.push(`${ctx}.file.url must be http(s)`);
    }
    if (typeof f.filename !== "string" || f.filename.length === 0 ||
        /[/\\]/.test(f.filename) || f.filename.includes("..")) {
      problems.push(`${ctx}.file.filename unsafe: ${String(f.filename)}`);
    }
    const h = f.hashes;
    if (!isRecord(h) || typeof h.sha1 !== "string" || !SHA1_RE.test(h.sha1.toLowerCase())) {
      problems.push(`${ctx}.file.hashes.sha1 missing/invalid`);
    }
  });
  return { ok: problems.length === 0, problems, manifest: data as unknown as Manifest };
}
