import type { Scope } from '../shared/types.js';

export class Bus {
  private listeners = new Set<(scope: Scope) => void>();

  emit(scope: Scope): void {
    for (const fn of [...this.listeners]) fn(scope);
  }

  /** Subscribe to scope changes; returns the unsubscribe function. */
  on(fn: (scope: Scope) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
