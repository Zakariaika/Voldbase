/**
 * Versioned on-disk representation of projects.
 *
 * The storage schema is deliberately separate from the domain: the domain never
 * sees a file, a path or a version number. Everything read from disk is fed back
 * through `createProject`, so a corrupted or hand-edited file cannot smuggle an
 * invalid revision or a malformed snapshot into the application.
 */

import { DomainError } from '../../domain/errors.ts';
import { asProjectId } from '../../domain/ids.ts';
import {
  createProject,
  type DependencySnapshot,
  type Project,
  type ProjectSource,
  type ProjectSourceKind,
} from '../../domain/project.ts';

/** Schema version written by this build. Bump when the document shape changes. */
export const STORAGE_SCHEMA_VERSION = 1;

/** File name of the project store inside the VOLDBASE home directory. */
export const STORAGE_FILE_NAME = 'projects.json';

export interface StoredSource {
  readonly kind: string;
  readonly location: string;
  readonly ref?: string;
}

export interface StoredProject {
  readonly id: string;
  readonly name: string;
  readonly source: StoredSource;
  readonly revision: string;
  readonly dependencies: readonly DependencySnapshot[];
  readonly configuration: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface StorageDocumentV1 {
  readonly schemaVersion: 1;
  readonly projects: readonly StoredProject[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function corrupted(detail: string): DomainError {
  return new DomainError('storage_corrupted', `Stored project data is invalid: ${detail}`);
}

function readDependencies(value: unknown): DependencySnapshot[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw corrupted('dependencies must be an array');
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw corrupted(`dependency #${index + 1} is not an object`);
    }
    const { ecosystem, manifestPath, digest } = entry;
    if (
      typeof ecosystem !== 'string' ||
      typeof manifestPath !== 'string' ||
      typeof digest !== 'string'
    ) {
      throw corrupted(`dependency #${index + 1} needs ecosystem, manifestPath and digest`);
    }
    return { ecosystem, manifestPath, digest };
  });
}

function readConfiguration(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw corrupted('configuration must be an object');
  }
  const configuration: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== 'string') {
      throw corrupted(`configuration value '${key}' must be a string`);
    }
    configuration[key] = member;
  }
  return configuration;
}

function readSource(value: unknown): ProjectSource {
  if (!isRecord(value)) {
    throw corrupted('source must be an object');
  }
  const { kind, location, ref } = value;
  if (kind !== 'github' && kind !== 'local') {
    throw corrupted(`source kind must be 'github' or 'local', received '${String(kind)}'`);
  }
  if (typeof location !== 'string' || location.trim() === '') {
    throw corrupted('source location must be a non-empty string');
  }
  if (ref !== undefined && typeof ref !== 'string') {
    throw corrupted('source ref must be a string when present');
  }
  const sourceKind: ProjectSourceKind = kind;
  return ref === undefined
    ? { kind: sourceKind, location }
    : { kind: sourceKind, location, ref };
}

/** Rebuild a domain project from its stored form, validating every invariant. */
export function storedToProject(value: unknown, context = 'project'): Project {
  if (!isRecord(value)) {
    throw corrupted(`${context} is not an object`);
  }
  const { id, name, revision, createdAt } = value;
  if (typeof id !== 'string' || id.trim() === '') {
    throw corrupted(`${context} has no id`);
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw corrupted(`${context} has no name`);
  }
  if (typeof revision !== 'string') {
    throw corrupted(`${context} has no revision`);
  }
  if (typeof createdAt !== 'string') {
    throw corrupted(`${context} has no createdAt`);
  }
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    throw corrupted(`${context} has an invalid createdAt`);
  }

  const source = readSource(value.source);
  const dependencies = readDependencies(value.dependencies);
  const configuration = readConfiguration(value.configuration);

  try {
    return createProject({
      id: asProjectId(id),
      name,
      source,
      revision,
      dependencies,
      configuration,
      createdAt: created,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError('storage_corrupted', `${context}: ${error.message}`);
    }
    throw error;
  }
}

export function projectToStored(project: Project): StoredProject {
  return {
    id: project.id,
    name: project.name,
    source:
      project.source.ref === undefined
        ? { kind: project.source.kind, location: project.source.location }
        : {
            kind: project.source.kind,
            location: project.source.location,
            ref: project.source.ref,
          },
    revision: project.revision,
    dependencies: project.dependencies.map((dependency) => ({ ...dependency })),
    configuration: { ...project.configuration },
    createdAt: project.createdAt.toISOString(),
  };
}

export interface StorageMigration {
  readonly from: number;
  readonly to: number;
  readonly description: string;
  migrate(raw: unknown): unknown;
}

/**
 * Ordered migrations. Version 0 is the pre-versioning layout: a bare JSON array
 * of projects. Every migration must produce a document the next step (or the
 * validator) understands.
 */
export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  {
    from: 0,
    to: 1,
    description: 'Wrap the legacy bare project array in a versioned document',
    migrate: (raw) => ({ schemaVersion: 1, projects: Array.isArray(raw) ? raw : [] }),
  },
];

function detectVersion(raw: unknown): number {
  if (Array.isArray(raw)) {
    return 0;
  }
  if (isRecord(raw) && typeof raw.schemaVersion === 'number' && Number.isInteger(raw.schemaVersion)) {
    return raw.schemaVersion;
  }
  throw corrupted('document has no integer schemaVersion');
}

/**
 * Bring any supported document up to `STORAGE_SCHEMA_VERSION`.
 *
 * A file written by a newer build is rejected rather than guessed at: silently
 * dropping fields would corrupt the user's data.
 */
export function migrateStorageDocument(raw: unknown): StorageDocumentV1 {
  let document = raw;
  let version = detectVersion(raw);

  if (version > STORAGE_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `Storage schema version ${version} is newer than this build supports ` +
        `(${STORAGE_SCHEMA_VERSION}); upgrade VOLDBASE to read it`,
    );
  }

  while (version < STORAGE_SCHEMA_VERSION) {
    const migration = STORAGE_MIGRATIONS.find((candidate) => candidate.from === version);
    if (migration === undefined) {
      throw new DomainError(
        'storage_unsupported_schema',
        `No migration path from storage schema version ${version}`,
      );
    }
    document = migration.migrate(document);
    version = migration.to;
  }

  if (!isRecord(document) || !Array.isArray(document.projects)) {
    throw corrupted('document has no projects array');
  }

  return {
    schemaVersion: 1,
    projects: document.projects.map((entry, index) =>
      projectToStored(storedToProject(entry, `project #${index + 1}`)),
    ),
  };
}

export function documentToProjects(raw: unknown): Project[] {
  return migrateStorageDocument(raw).projects.map((entry) => storedToProject(entry));
}

export function projectsToDocument(projects: readonly Project[]): StorageDocumentV1 {
  return {
    schemaVersion: 1,
    projects: projects.map(projectToStored),
  };
}
