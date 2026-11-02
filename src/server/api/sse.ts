import type { Bus } from '../bus.js';

export const PING_EVERY_MS = 25_000;

/**
 * A live event stream. Every bus scope becomes `event: changed` with `{"scope":"people"}`; a comment goes out
 * every 25 seconds so proxies keep the connection open. Ends when the caller aborts or stops reading.
 */
export function eventStream(bus: Bus, signal?: AbortSignal, pingEveryMs: number = PING_EVERY_MS): Response {
  const encoder = new TextEncoder();
  const queued: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let off: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  const push = (text: string) => {
    if (closed) return;
    queued.push(text);
    wake?.();
  };

  const finish = (controller?: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    off?.();
    if (timer) clearInterval(timer);
    wake?.();
    try {
      controller?.close();
    } catch {
      // already closed by the reader
    }
  };

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        // The opening comment makes the browser see the stream as open straight away.
        push(': connected\n\n');
        off = bus.on((scope) => push(`event: changed\ndata: ${JSON.stringify({ scope })}\n\n`));
        timer = setInterval(() => push(': ping\n\n'), pingEveryMs);
        timer.unref();
        if (signal?.aborted) finish(controller);
        else signal?.addEventListener('abort', () => finish(controller), { once: true });
      },
      // Everything that has queued up since the last read goes out together.
      async pull(controller) {
        while (!closed && queued.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        if (queued.length > 0) controller.enqueue(encoder.encode(queued.splice(0).join('')));
        else finish(controller);
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
