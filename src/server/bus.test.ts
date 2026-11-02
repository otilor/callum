import { describe, expect, it } from 'vitest';
import { Bus } from './bus.js';
import type { Scope } from '../shared/types.js';

describe('Bus', () => {
  it('delivers emitted scopes to listeners', () => {
    const bus = new Bus();
    const seen: Scope[] = [];
    bus.on((s) => seen.push(s));
    bus.emit('people');
    bus.emit('outbox');
    expect(seen).toEqual(['people', 'outbox']);
  });

  it('stops delivery after unsubscribe', () => {
    const bus = new Bus();
    const seen: Scope[] = [];
    const off = bus.on((s) => seen.push(s));
    bus.emit('people');
    off();
    bus.emit('settings');
    expect(seen).toEqual(['people']);
  });
});
