/**
 * Durable local analysis storage (Phase 2A).
 *
 * One JSON document holds every analysis, written atomically and guarded by the
 * same exclusive lock used for projects (ADR-0011): the read-modify-write is
 * re-read under the lock, so two VOLDBASE processes cannot drop each other's
 * records.
 *
 * Analyses are immutable and content-addressed. Saving an id that already exists
 * is a no-op when the content is identical and is refused otherwise: an analysis
 * that could be rewritten would stop being evidence of what was analysed.
 *
 * A corrupted document is reported, never silently replaced (ADR-0009).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { AnalysisRepository } from '../../application/ports.ts';
import { cloneAnalysisSnapshot, type AnalysisSnapshot } from '../../domain/analysis.ts';
import { DomainError } from '../../domain/errors.ts';
import type { AnalysisId, ProjectId } from '../../domain/ids.ts';
import {
  analysesToDocument,
  documentToAnalyses,
  ANALYSES_STORAGE_SCHEMA_VERSION,
} from './analysis-storage-schema.ts';
import { acquireFileLock, type LockOptions } from './file-lock.ts';

export interface JsonAnalysisRepositoryOptions {
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

export class JsonAnalysisRepository implements AnalysisRepository {
  readonly #filePath: string;
  readonly #lockOptions: LockOptions;
  #analyses: Map<AnalysisId, AnalysisSnapshot> | undefined;

  constructor(options: JsonAnalysisRepositoryOptions) {
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

  async save(snapshot: AnalysisSnapshot): Promise<void> {
    const directory = path.dirname(this.#filePath);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new DomainError('storage_write_failed', `Cannot prepare ${directory}: ${describe(error)}`);
    }

    const lock = await acquireFileLock(`${this.#filePath}.lock`, this.#lockOptions);
    try {
      const current = await this.#readFromDisk();
      const existing = current.get(snapshot.analysisId);
      if (existing !== undefined) {
        if (existing.digest !== snapshot.digest) {
          throw new DomainError(
            'analysis_immutable',
            `Analysis ${snapshot.analysisId} already exists with different content; an ` +
              'analysis is immutable — run a new analysis instead',
          );
        }
        return;
      }

      const next = new Map(current);
      next.set(snapshot.analysisId, cloneAnalysisSnapshot(snapshot));
      await this.#writeToDisk(next);
      this.#analyses = next;
    } finally {
      await lock.release();
    }
  }

  async findById(id: AnalysisId): Promise<AnalysisSnapshot | undefined> {
    const stored = (await this.#load()).get(id);
    return stored === undefined ? undefined : cloneAnalysisSnapshot(stored);
  }

  async listByProject(projectId: ProjectId): Promise<AnalysisSnapshot[]> {
    return [...(await this.#load()).values()]
      .filter((snapshot) => snapshot.projectId === projectId)
      .map(cloneAnalysisSnapshot)
      .sort((left, right) => compareIds(left.analysisId, right.analysisId));
  }

  async #load(): Promise<Map<AnalysisId, AnalysisSnapshot>> {
    if (this.#analyses !== undefined) {
      return this.#analyses;
    }
    const analyses = await this.#readFromDisk();
    this.#analyses = analyses;
    return analyses;
  }

  /** Read and validate the document from disk, bypassing the cache. */
  async #readFromDisk(): Promise<Map<AnalysisId, AnalysisSnapshot>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return new Map<AnalysisId, AnalysisSnapshot>();
      }
      throw new DomainError('storage_unreadable', `Cannot read ${this.#filePath}: ${describe(error)}`);
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

    const analyses = new Map<AnalysisId, AnalysisSnapshot>();
    for (const snapshot of documentToAnalyses(parsed)) {
      analyses.set(snapshot.analysisId, snapshot);
    }
    return analyses;
  }

  async #writeToDisk(analyses: ReadonlyMap<AnalysisId, AnalysisSnapshot>): Promise<void> {
    const document = analysesToDocument(
      [...analyses.values()].sort((left, right) => compareIds(left.analysisId, right.analysisId)),
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
      throw new DomainError('storage_write_failed', `Cannot write ${this.#filePath}: ${describe(error)}`);
    }
  }
}

/** Schema version written by this build; re-exported for callers that inspect files. */
export { ANALYSES_STORAGE_SCHEMA_VERSION };
