/** Server-Sent Events client for the main process (the renderer is sandboxed
 *  and file://-origin, so cross-origin EventSource cannot be used there).
 *  Reconnects with backoff and forwards parsed events over IPC. */
export type SseHandler = (event: string, data: string) => void;

export interface SseOptions {
  url: string;
  headers?: Record<string, string>;
  onEvent: SseHandler;
  onError?: (msg: string) => void;
}

export class SseStream {
  private ctrl: AbortController | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private opts: SseOptions) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.ctrl?.abort();
    this.ctrl = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.ctrl = new AbortController();
      try {
        const resp = await fetch(this.opts.url, { headers: this.opts.headers, signal: this.ctrl.signal });
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
        this.attempt = 0;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // sse_starlette frames events with CRLF; other servers use LF. Handle both.
          for (;;) {
            const lf = buf.indexOf("\n\n");
            const crlf = buf.indexOf("\r\n\r\n");
            if (lf === -1 && crlf === -1) break;
            const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
            const end = useCrlf ? crlf : lf;
            const chunk = buf.slice(0, end);
            buf = buf.slice(end + (useCrlf ? 4 : 2));
            this.dispatch(chunk);
          }
        }
      } catch (e) {
        if (this.stopped) return;
        this.opts.onError?.(String((e as Error)?.message ?? e));
      }
      if (this.stopped) return;
      this.attempt++;
      const wait = Math.min(15000, 750 * 2 ** Math.min(this.attempt, 4));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private dispatch(chunk: string): void {
    let event = "message";
    const data: string[] = [];
    for (const raw of chunk.split(/\r?\n/)) {
      if (!raw || raw.startsWith(":")) continue;
      const colon = raw.indexOf(":");
      const field = colon === -1 ? raw : raw.slice(0, colon);
      let value = colon === -1 ? "" : raw.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) this.opts.onEvent(event, data.join("\n"));
  }
}
