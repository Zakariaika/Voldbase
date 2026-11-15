/**
 * Durable local project storage (Phase 1).
 *
 * One JSON document holds every imported project. Writes are atomic — serialized
 * to a temporary file in the same directory, then renamed over the target — so a
 * crash leaves either the previous file or the new one, never a half-written
 * document. The in-memory map is only updated after the write succeeds.
 *
 * Atomic replacement alone does not prevent lost updates, so every write is also
 * guarded by an exclusive lock file and re-reads the document from disk under that
 * lock (ADR-0011).
 *
 * The whole document is rewritten on every save. That is appropriate at V0.1
 * scale (tens to hundreds of projects) and keeps the format inspectable; a
 * record-per-project layout can replace this behind the same port.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { ProjectRepository } from '../../application/ports.ts';
import { DomainError } from '../../domain/errors.ts';
import type { ProjectId } from '../../domain/ids.ts';
import {
  assertProjectSnapshotCompatible,
  cloneProject,
  type Project,
} from '../../domain/project.ts';
import {
  documentToProjects,
  projectsToDocument,
  STORAGE_SCHEMA_VERSION,
} from './storage-schema.ts';
import { acquireFileLock, type LockOptions } from './file-lock.ts';

export interface JsonProjectRepositoryOptions {
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

export class JsonProjectRepository implements ProjectRepository {
  readonly #filePath: string;
  readonly #lockOptions: LockOptions;
  #projects: Map<ProjectId, Project> | undefined;

  constructor(options: JsonProjectRepositoryOptions) {
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

  async save(project: Project): Promise<void> {
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
      const existing = current.get(project.id);

      if (existing !== undefined) {
        // Same guard as the in-memory adapter: content may not change under an id.
        assertProjectSnapshotCompatible(existing, project);
      }

      const next = new Map(current);
      next.set(project.id, {
        ...cloneProject(project),
        // Content is unchanged on an accepted re-save, so keep the provenance.
        ...(existing === undefined ? {} : { createdAt: existing.createdAt }),
      });

      await this.#persist(next);
      this.#projects = next;
    } finally {
      // Runs on success and on failure: a crash between lock and rename must not
      // leave this process holding the store.
      await lock.release();
    }
  }

  async findById(id: ProjectId): Promise<Project | undefined> {
    const stored = (await this.#load()).get(id);
    return stored === undefined ? undefined : cloneProject(stored);
  }

  async list(): Promise<Project[]> {
    const projects = [...(await this.#load()).values()].map(cloneProject);
    return projects.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  async #load(): Promise<Map<ProjectId, Project>> {
    if (this.#projects !== undefined) {
      return this.#projects;
    }
    const projects = await this.#readFromDisk();
    this.#projects = projects;
    return projects;
  }

  /** Read and validate the document from disk, bypassing the cache. */
  async #readFromDisk(): Promise<Map<ProjectId, Project>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return new Map<ProjectId, Project>();
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

    const projects = new Map<ProjectId, Project>();
    for (const project of documentToProjects(parsed)) {
      projects.set(project.id, project);
    }
    return projects;
  }

  async #persist(projects: ReadonlyMap<ProjectId, Project>): Promise<void> {
    const document = projectsToDocument(
      [...projects.values()].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
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
export { STORAGE_SCHEMA_VERSION };
