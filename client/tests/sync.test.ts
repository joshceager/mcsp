import { describe, expect, it } from "vitest";
import { planSync } from "../src/shared/sync";
import { validateManifest } from "../src/shared/manifest-validate";
import type { InstalledMod, Manifest, ModEntry } from "../src/shared/types";

function jar(name: string, sha1: string): ModEntry {
  return {
    modId: name.replace(/[^a-z0-9_-]/g, ""),
    name,
    version: "1.0.0",
    side: "both",
    file: { url: `http://cdn.test/${name}.jar`, filename: `${name}.jar`, size: 1234, hashes: { sha1 } },
  };
}

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);

const manifest: Manifest = {
  formatVersion: 1,
  loader: "neoforge",
  loaderVersion: "21.1.90",
  minecraftVersion: "1.21.1",
  mods: [
    jar("both-mod", shaA),
    { ...jar("client-mod", shaB), side: "client" },
    { ...jar("server-mod", shaC), side: "server" },
  ],
};

describe("planSync side filtering (approved rule: client NEVER installs side=server)", () => {
  it("skips server-only mods entirely", () => {
    const plan = planSync(manifest, []);
    expect(plan.skipped.map((s) => s.modId)).toEqual(["server-mod"]);
    expect(plan.downloads.map((d) => d.modId)).toEqual(["both-mod", "client-mod"]);
    expect(plan.removals).toHaveLength(0);
  });

  it("downloads client+both mods and marks restart required", () => {
    const plan = planSync(manifest, []);
    expect(plan.downloads).toHaveLength(2);
    expect(plan.unchanged).toHaveLength(0);
    expect(plan.restartRequired).toBe(true);
  });

  it("keeps up-to-date mods without re-downloading", () => {
    const local: InstalledMod[] = [
      { filename: "both-mod.jar", sha1: shaA, size: 1234, modId: "both-mod" },
      { filename: "client-mod.jar", sha1: shaB, size: 1234, modId: "client-mod" },
    ];
    const plan = planSync(manifest, local);
    expect(plan.downloads).toHaveLength(0);
    expect(plan.unchanged).toHaveLength(2);
    expect(plan.restartRequired).toBe(false);
  });

  it("re-downloads when the local sha differs", () => {
    const local: InstalledMod[] = [
      { filename: "both-mod.jar", sha1: shaB, size: 1234, modId: "both-mod" },
    ];
    const plan = planSync(manifest, local);
    // both-mod: local sha differs -> re-download; client-mod: not installed -> download
    expect(plan.downloads.map((d) => d.modId)).toEqual(["both-mod", "client-mod"]);
  });

  it("removes local files that are no longer in the manifest", () => {
    const local: InstalledMod[] = [
      { filename: "both-mod.jar", sha1: shaA, size: 1234, modId: "bothmod" },
      { filename: "old-removed.jar", sha1: shaB, size: 1, modId: "old-removed" },
      { filename: "server-mod.jar", sha1: shaC, size: 1, modId: "server-mod" },
    ];
    const plan = planSync(manifest, local);
    const removed = plan.removals.map((r) => r.filename);
    expect(removed).toContain("old-removed.jar");
    // server-only mods on disk get swept too (client must not keep them)
    expect(removed).toContain("server-mod.jar");
  });
});

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const v = validateManifest(manifest);
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
  });

  it("rejects traversal filenames and missing sha1", () => {
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.mods[0].file.filename = "../../evil.jar";
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(/unsafe/);
  });

  it("rejects duplicate modIds", () => {
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.mods.push(jar("both-mod", shaC));
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(/duplicate/);
  });

  it("rejects non-http urls", () => {
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.mods[0].file.url = "file:///etc/passwd";
    const v = validateManifest(bad);
    expect(v.ok).toBe(false);
    expect(v.problems.join("\n")).toMatch(/http/);
  });
});
