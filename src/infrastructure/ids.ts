/**
 * Identifier and clock adapters for the local CLI.
 *
 * Both are ports (application layer), so tests can substitute deterministic
 * implementations without touching production code.
 */

import { randomUUID } from 'node:crypto';

import type { Clock, IdGenerator } from '../application/ports.ts';

/** Locally generated, collision-resistant project ids: `proj_` + 20 hex chars. */
export class RandomIdGenerator implements IdGenerator {
  readonly #prefix: string;

  constructor(prefix = 'proj') {
    this.#prefix = prefix;
  }

  next(): string {
    return `${this.#prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  }
}

/** Wall-clock time. Injected so tests and reprocessing can fix it. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
