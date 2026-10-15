import { describe, expect, it } from "vitest";
import { sanitizeMessage, summarizeProcessFailure, tailLines } from "../src/shared/errors";

describe("sanitizeMessage", () => {
  it("strips the Electron IPC wrapper", () => {
    expect(sanitizeMessage("Error invoking remote method 'api:health': Error: cannot reach http://x"))
      .toBe("cannot reach http://x");
  });

  it("never shows a raw HTML page", () => {
    const html = '<!doctype html><html><head><title>Example Domain</title></head><body><p>hi</p></body></html>';
    const out = sanitizeMessage(html);
    expect(out).toContain("returned an HTML page");
    expect(out).toContain("Example Domain");
    expect(out.length).toBeLessThan(200);
    expect(out).not.toContain("<body>");
  });

  it("collapses multi-line installer output and truncates", () => {
    const blob = "line one\n\n   line two   \n" + "x".repeat(900);
    const out = sanitizeMessage(blob);
    expect(out.startsWith("line one line two x")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.endsWith("…")).toBe(true);
  });

  it("has a fallback for empty input", () => {
    expect(sanitizeMessage("")).toBe("unexpected error");
  });
});

describe("summarizeProcessFailure", () => {
  it("picks the most relevant error line instead of dumping stderr", () => {
    const out = summarizeProcessFailure(
      "Outputting log to file\nFound java version 21",
      "There is no minecraft launcher profile in /tmp/x, you need to run the launcher first!",
      "NeoForge installer failed",
    );
    expect(out).toContain("no minecraft launcher profile");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("falls back when nothing looks like an error", () => {
    expect(summarizeProcessFailure("", "", "installer failed")).toBe("installer failed");
  });
});

describe("tailLines", () => {
  it("keeps only the last N non-empty trimmed lines", () => {
    expect(tailLines("a\n\nb\n  c  \n", 2)).toEqual(["b", "c"]);
  });
});
