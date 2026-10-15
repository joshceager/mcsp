/** User-facing error text: never leak HTML bodies, Electron IPC internals or
 *  stack traces into the UI (bugs: "error walls" / raw 404 HTML dumps). */

/** Strip anything that looks like an internals leak from a message. */
export function sanitizeMessage(raw: unknown, max = 400): string {
  let s = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw ?? "");
  // Drop the Electron IPC wrapper: "Error invoking remote method 'x': Error: real"
  s = s.replace(/Error invoking remote method '[^']*':\s*/g, "");
  s = s.replace(/^Error:\s*/, "");
  // HTML payloads are never useful to a human: replace with a short hint.
  if (/<\s*(!doctype|html|body|head|div|p)\b/i.test(s)) {
    const title = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(s)?.[1];
    return `the server returned an HTML page, not the MCSP API${title ? ` ("${title.trim()}")` : ""} — check the URL (it must point at the backend, e.g. http://host:8080)`;
  }
  // Collapse whitespace runs (raw stderr blobs).
  s = s.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s || "unexpected error";
}

/** Turn a listing of stderr/stdout lines into at most `n` meaningful lines. */
export function tailLines(blob: string, n = 6): string[] {
  return String(blob ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n);
}

/** Short, actionable message for a failed installer/JVM run. */
export function summarizeProcessFailure(stdout: string, stderr: string, fallback: string): string {
  const blobby = `${stderr}\n${stdout}`;
  const interesting =
    tailLines(blobby, 40).filter((l) =>
      /error|exception|failed|fatal|cannot|could not|no such|there is no|you need to|unable|denied|missing|invalid|refus|unsupported|not found/i.test(l),
    ).pop() ?? tailLines(blobby, 1)[0];
  return sanitizeMessage(interesting ? `${fallback}: ${interesting}` : fallback);
}
