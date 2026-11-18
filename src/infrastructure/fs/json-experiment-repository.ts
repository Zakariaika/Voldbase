/**
 * Durable local experiment storage (Phase 2C).
 *
 * One JSON document holds every experiment, written atomically and guarded by the
 * same exclusive lock used for projects (ADR-0011): the read-modify-write is
 * re-read under the lock, so two VOLDBASE processes cannot drop each other's
 * records.
 *
 * Experiments are editable: a changed definition keeps its id and is expected to
 * bump `definitionVersion`. Runs pin the definition hash they executed, so an
 * edit never rewrites history.
 *
 * A corrupted document is reported, never silently replaced (ADR-0009).
 *
 * The in-process cache is keyed to the identity of the document it was read from,
 * so a file changed by another instance (or by hand) is re-read instead of being
 * served from a stale cache.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { ExperimentRepository } from '../../application/ports.ts';
import { DomainError } from '../../domain/errors.ts';
import {
  assertExperimentRevisionIntegrity,
  cloneExperiment,
  type Experiment,
} from '../../domain/experiment.ts';
import type { ExperimentId, ProjectId } from '../../domain/ids.ts';
import {
  assertStorableExperiment,
  documentToExperiments,
  experimentsToDocument,
  EXPERIMENT_STORAGE_SCHEMA_VERSION,
} from './experiment-run-storage-schema.ts';
import { acquireFileLock, type LockOptions } from './file-lock.ts';

export interface JsonExperimentRepositoryOptions {
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

/**
 * Identity of the document a cache snapshot was read from.
 *
 * This is a change detector, not a content hash: it answers "is this still the
 * same file?" without reading it again, which is what makes a cached read cheap.
 * The inode catches the replace-by-rename every write performs; size and mtime
 * catch an in-place edit.
 */
interface DocumentSignature {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMs: number;
}

function signatureOf(stats: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): DocumentSignature {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedMs: stats.mtimeMs,
  };
}

function sameSignature(
  left: DocumentSignature | undefined,
  right: DocumentSignature | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs
  );
}

export class JsonExperimentRepository implements ExperimentRepository {
  readonly #filePath: string;
  readonly #lockOptions: LockOptions;
  #experiments: Map<ExperimentId, Experiment> | undefined;
  /** Identity of the document {@link #experiments} was read from. */
  #cacheSignature: DocumentSignature | undefined;

  constructor(options: JsonExperimentRepositoryOptions) {
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

  async save(experiment: Experiment): Promise<void> {
    // Refuse an invalid record before any I/O: serializing it would write a
    // document that this repository could no longer read back.
    assertStorableExperiment(experiment);

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
      // Re-read under the lock. Cached state may be stale: another process can
      // have written since this instance last loaded, and saving our cache would
      // silently drop its records.
      const current = await this.#readFromDisk();
      const existing = current.get(experiment.id);
      if (existing !== undefined) {
        // Checked against the record on disk, not the cache: another process may
        // have revised the experiment since this instance last loaded it.
        assertExperimentRevisionIntegrity(existing, experiment);
      }
      const next = new Map(current);
      // Store a copy: `readonly` is compile-time only, so keeping the caller's
      // object graph would let them mutate the stored definition afterwards.
      next.set(experiment.id, cloneExperiment(experiment));

      await this.#persist(next);
      this.#experiments = next;
      // The rename changed the document's identity, and another process may have
      // written again before this line. Invalidate so the next read reloads
      // rather than trusting a signature this write cannot vouch for.
      this.#cacheSignature = undefined;
    } finally {
      // Runs on success and on failure: a crash between lock and rename must not
      // leave this process holding the store.
      await lock.release();
    }
  }

  async findById(id: ExperimentId): Promise<Experiment | undefined> {
    const stored = (await this.#load()).get(id);
    return stored === undefined ? undefined : cloneExperiment(stored);
  }

  async listByProject(projectId: ProjectId): Promise<Experiment[]> {
    return [...(await this.#load()).values()]
      .filter((experiment) => experiment.projectId === projectId)
      .map(cloneExperiment)
      .sort((left, right) => compareIds(left.id, right.id));
  }

  async #load(): Promise<Map<ExperimentId, Experiment>> {
    // Sample the document's identity *before* reading. If it is replaced while
    // the read is in flight, the cache is stored under the older signature and
    // the next read reloads, instead of caching content that is already outdated.
    const signature = await this.#currentSignature();
    if (this.#experiments !== undefined && sameSignature(this.#cacheSignature, signature)) {
      return this.#experiments;
    }
    const experiments = await this.#readFromDisk();
    this.#experiments = experiments;
    this.#cacheSignature = signature;
    return experiments;
  }

  /**
   * Identity of the document on disk, or `undefined` when it does not exist.
   *
   * A stat failure other than `ENOENT` is reported, not treated as a cache hit:
   * "I could not look" is not evidence that the cached snapshot is current.
   */
  async #currentSignature(): Promise<DocumentSignature | undefined> {
    try {
      return signatureOf(await fs.stat(this.#filePath));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw new DomainError(
        'storage_unreadable',
        `Cannot inspect ${this.#filePath}: ${describe(error)}`,
      );
    }
  }

  /** Read and validate the document from disk, bypassing the cache. */
  async #readFromDisk(): Promise<Map<ExperimentId, Experiment>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return new Map<ExperimentId, Experiment>();
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

    const experiments = new Map<ExperimentId, Experiment>();
    for (const experiment of documentToExperiments(parsed)) {
      experiments.set(experiment.id, experiment);
    }
    return experiments;
  }

  async #persist(experiments: ReadonlyMap<ExperimentId, Experiment>): Promise<void> {
    const document = experimentsToDocument(
      [...experiments.values()].sort((left, right) => compareIds(left.id, right.id)),
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
export { EXPERIMENT_STORAGE_SCHEMA_VERSION };
