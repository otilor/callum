import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../bus.js';
import { eventStream } from './sse.js';

async function readUntil(res: Response, text: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  reader.releaseLock();
  return seen;
}

describe('eventStream', () => {
  it('is an event stream that opens with a comment', async () => {
    const res = eventStream(new Bus());
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await readUntil(res, ': connected')).toContain(': connected');
    await res.body!.cancel();
  });

  it('writes a changed event for every scope on the bus', async () => {
    const bus = new Bus();
    const res = eventStream(bus);
    bus.emit('people');
    bus.emit('outbox');
    const seen = await readUntil(res, 'outbox');
    expect(seen).toContain('event: changed\ndata: {"scope":"people"}\n\n');
    expect(seen).toContain('event: changed\ndata: {"scope":"outbox"}\n\n');
    await res.body!.cancel();
  });

  it('pings on a timer', async () => {
    vi.useFakeTimers();
    try {
      const res = eventStream(new Bus(), undefined, 1000);
      const reader = res.body!.getReader();
      await reader.read(); // the opening comment
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(1000);
      expect(new TextDecoder().decode((await next).value)).toBe('event: ping\ndata: {}\n\n');
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops listening when the caller aborts', async () => {
    const bus = new Bus();
    const abort = new AbortController();
    const res = eventStream(bus, abort.signal);
    const reader = res.body!.getReader();
    await reader.read();
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    let heard = 0;
    const off = bus.on(() => heard++);
    bus.emit('people');
    off();
    expect(heard).toBe(1);
  });

  it('unsubscribes when the reader goes away', async () => {
    const bus = new Bus();
    let live = 0;
    const on = bus.on.bind(bus);
    bus.on = (fn) => {
      live++;
      const off = on(fn);
      return () => {
        live--;
        off();
      };
    };
    const res = eventStream(bus);
    expect(live).toBe(1);
    await res.body!.cancel();
    expect(live).toBe(0);
  });
});
