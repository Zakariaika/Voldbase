/**
 * Durable local run storage (Phase 2C).
 *
 * One JSON document holds every run, written atomically and guarded by the same
 * exclusive lock used for projects (ADR-0011): the read-modify-write is re-read
 * under the lock, so two VOLDBASE processes cannot drop each other's records.
 *
 * Run history is append-only: once a run has reached a terminal state
 * (`completed`, `failed` or `cancelled`) it may not be saved again. The check is
 * made against the record re-read from disk under the lock, not against this
 * process's cache, so another process's terminal run is protected too.
 *
 * A corrupted document is reported, never silently replaced (ADR-0009).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { RunRepository } from '../../application/ports.ts';
import { DomainError } from '../../domain/errors.ts';
import type { ExperimentId, RunId } from '../../domain/ids.ts';
import { cloneRun, isTerminal, type Run } from '../../domain/run.ts';
import {
  assertStorableRun,
  documentToRuns,
  runsToDocument,
  RUN_STORAGE_SCHEMA_VERSION,
} from './experiment-run-storage-schema.ts';
import { acquireFileLock, type LockOptions } from './file-lock.ts';

export interface JsonRunRepositoryOptions {
  /** Absolute path of the JSON document to read and write. */
  readonly filePath: string;
  /** Lock tuning; defaults are documented in ADR-0011. */
  readonly lock?: LockOptions;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class JsonRunRepository implements RunRepository {
  readonly #filePath: string;
  readonly #lockOptions: LockOptions;
  #runs: Map<RunId, Run> | undefined;

  constructor(options: JsonRunRepositoryOptions) {
    if (typeof options.filePath !== 'string' || options.filePath.trim() === '') {
      throw new DomainError('invalid_storage_path', 'A storage file path is required');
    }
    this.#filePath = path.resolve(options.filePath);
    this.#lockOptions = options.lock ?? {};
  }

  /** Absolute path of the backing document (useful for diagnostics). */
  get filePath(): string {
    return this.#filePath;
  }

  async save(run: Run): Promise<void> {
    const directory = path.dirname(this.#filePath);
    try {
      // The directory must exist before the lock file can be created.
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new DomainError(
        'storage_write_failed',
        `Cannot prepare ${directory}: ${describe(error)}`,
      );
    }

    // Exclusive across processes: the read-modify-write below must not interleave
    // with another VOLDBASE process doing the same (ADR-0011).
    const lock = await acquireFileLock(`${this.#filePath}.lock`, this.#lockOptions);
    try {
      // Re-read under the lock: the terminal-state decision must be based on what
      // is actually stored, not on a cache another process may have superseded.
      const current = await this.#readFromDisk();
      const existing = current.get(run.id);
      if (existing !== undefined && isTerminal(existing.state)) {
        throw new DomainError(
          'immutable_run',
          `Run ${run.id} is ${existing.state} and cannot be modified; record a new run instead`,
        );
      }

      // Refuse an invalid record before it can reach the document. Validation runs
      // after the immutability guard so that mutating a terminal run is still
      // reported as `immutable_run`, the more specific rule.
      assertStorableRun(run);

      const next = new Map(current);
      // Store a copy: `readonly` is compile-time only, so keeping the caller's
      // object graph would let them mutate the stored record afterwards.
      next.set(run.id, cloneRun(run));

      await this.#persist(next);
      this.#runs = next;
    } finally {
      await lock.release();
    }
  }

  async findById(id: RunId): Promise<Run | undefined> {
    const stored = (await this.#load()).get(id);
    return stored === undefined ? undefined : cloneRun(stored);
  }

  async listByExperiment(experimentId: ExperimentId): Promise<Run[]> {
    return [...(await this.#load()).values()]
      .filter((run) => run.experimentId === experimentId)
      .map(cloneRun)
      .sort((left, right) => compareIds(left.id, right.id));
  }

  async #load(): Promise<Map<RunId, Run>> {
    if (this.#runs !== undefined) {
      return this.#runs;
    }
    const runs = await this.#readFromDisk();
    this.#runs = runs;
    return runs;
  }

  /** Read and validate the document from disk, bypassing the cache. */
  async #readFromDisk(): Promise<Map<RunId, Run>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return new Map<RunId, Run>();
      }
      throw new DomainError(
        'storage_unreadable',
        `Cannot read ${this.#filePath}: ${describe(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DomainError(
        'storage_corrupted',
        `${this.#filePath} is not valid JSON; restore it from a backup or remove it to start over`,
      );
    }

    const runs = new Map<RunId, Run>();
    for (const run of documentToRuns(parsed)) {
      runs.set(run.id, run);
    }
    return runs;
  }

  async #persist(runs: ReadonlyMap<RunId, Run>): Promise<void> {
    const document = runsToDocument(
      [...runs.values()].sort((left, right) => compareIds(left.id, right.id)),
    );
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    const directory = path.dirname(this.#filePath);
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.#filePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new DomainError(
        'storage_write_failed',
        `Cannot write ${this.#filePath}: ${describe(error)}`,
      );
    }
  }
}

/** Schema version written by this build; re-exported for callers that inspect files. */
export { RUN_STORAGE_SCHEMA_VERSION };
