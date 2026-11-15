/**
 * Durable local project storage (Phase 1).
 *
 * One JSON document holds every imported project. Writes are atomic — serialized
 * to a temporary file in the same directory, then renamed over the target — so a
 * crash leaves either the previous file or the new one, never a half-written
 * document. The in-memory map is only updated after the write succeeds.
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

export interface JsonProjectRepositoryOptions {
  /** Absolute path of the JSON document to read and write. */
  readonly filePath: string;
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
  #projects: Map<ProjectId, Project> | undefined;

  constructor(options: JsonProjectRepositoryOptions) {
    if (typeof options.filePath !== 'string' || options.filePath.trim() === '') {
      throw new DomainError('invalid_storage_path', 'A storage file path is required');
    }
    this.#filePath = path.resolve(options.filePath);
  }

  /** Absolute path of the backing document (useful for diagnostics). */
  get filePath(): string {
    return this.#filePath;
  }

  async save(project: Project): Promise<void> {
    const current = await this.#load();
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

    let raw: string;
    try {
      raw = await fs.readFile(this.#filePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        const empty = new Map<ProjectId, Project>();
        this.#projects = empty;
        return empty;
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
    this.#projects = projects;
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
