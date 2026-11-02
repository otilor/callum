import type { Scope } from '../shared/types.js';

export class Bus {
  private listeners = new Set<(scope: Scope) => void>();

  emit(scope: Scope): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(scope);
      } catch {
        // one failing listener must not stop the others or reach the emitter
      }
    }
  }

  /** Subscribe to scope changes; returns the unsubscribe function. */
  on(fn: (scope: Scope) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
