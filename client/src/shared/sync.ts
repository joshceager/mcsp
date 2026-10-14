/** Pure sync planning: diff a remote manifest against local installed mods.
 *
 * Approved side rule: the CLIENT never installs side=server mods. They are
 * listed as skipped so the user can see them but they are never downloaded.
 * side=client and side=both mods are required locally.
 *
 * This module is deliberately free of I/O so it is unit-testable.
 */
import type { InstalledMod, Manifest, ModEntry, SyncAction, SyncPlan } from "./types";

export interface PlanSyncOptions {
  /** Remove local mod files that are not in the manifest (default true). */
  removeUnknown?: boolean;
}

function sha1OfInstalled(local: InstalledMod, mod: ModEntry): boolean {
  return local.sha1.toLowerCase() === mod.file.hashes.sha1?.toLowerCase();
}

/** Build the plan. Never throws on malformed entries — those are skipped with a reason. */
export function planSync(
  manifest: Manifest,
  local: InstalledMod[],
  opts: PlanSyncOptions = {},
): SyncPlan {
  const removeUnknown = opts.removeUnknown !== false;
  const byFilename = new Map(local.map((l) => [l.filename, l]));
  const bySha1 = new Map(local.map((l) => [l.sha1.toLowerCase(), l]));

  const downloads: SyncAction[] = [];
  const removals: SyncAction[] = [];
  const unchanged: SyncAction[] = [];
  const skipped: SyncAction[] = [];

  const manifestFiles = new Set<string>();

  for (const mod of manifest.mods) {
    if (mod.side === "server") {
      // Server-only mods are NEVER installed on the client.
      skipped.push({
        kind: "keep",
        modId: mod.modId,
        filename: mod.file.filename,
        side: mod.side,
        reason: "side=server (server-only; not installed on the client)",
      });
      continue;
    }
    const fname = mod.file.filename;
    manifestFiles.add(fname);
    const inst = byFilename.get(fname);
    if (inst && inst.modId === mod.modId && sha1OfInstalled(inst, mod)) {
      unchanged.push({
        kind: "keep",
        modId: mod.modId,
        filename: fname,
        side: mod.side,
        reason: "already installed and up to date",
      });
      continue;
    }
    downloads.push({
      kind: "download",
      modId: mod.modId,
      filename: fname,
      url: mod.file.url,
      sha1: mod.file.hashes.sha1,
      size: mod.file.size,
      side: mod.side,
      reason: inst
        ? `installed ${inst.modId ?? "unknown mod"} has different content; replacing`
        : "not installed yet",
    });
    // If a different file occupies the manifest slot with a different name, remove it.
    if (inst && inst.filename !== fname) {
      removals.push({
        kind: "remove",
        modId: mod.modId,
        filename: inst.filename,
        side: mod.side,
        reason: `superseded by ${fname}`,
      });
    }
  }

  if (removeUnknown) {
    for (const inst of local) {
      if (manifestFiles.has(inst.filename)) continue;
      removals.push({
        kind: "remove",
        filename: inst.filename,
        side: "both",
        reason: "file present locally but not in the server manifest",
      });
    }
  }

  return {
    downloads,
    removals,
    unchanged,
    skipped,
    restartRequired: downloads.length > 0 || removals.length > 0,
  };
}
