import type { LabEvent } from '@agent-plugin/bridge-runtime-sdk-lab-shared';

import { sanitizeForDisplay } from './sanitize.ts';

type Listener = (event: LabEvent) => void;

export class EventStore {
  readonly #events: LabEvent[] = [];
  readonly #listeners = new Set<Listener>();
  #nextId = 1;

  constructor(private readonly maxEvents = 300) {}

  append(type: string, message: string, meta?: Record<string, unknown>): LabEvent {
    const event: LabEvent = {
      id: this.#nextId,
      at: Date.now(),
      type,
      message,
      meta: sanitizeForDisplay(meta) as Record<string, unknown> | undefined,
    };
    this.#nextId += 1;
    this.#events.push(event);
    while (this.#events.length > this.maxEvents) {
      this.#events.shift();
    }
    for (const listener of this.#listeners) {
      listener(event);
    }
    return event;
  }

  list(): LabEvent[] {
    return [...this.#events];
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
