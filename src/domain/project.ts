/**
 * Project — a pinned snapshot of a software or AI repository.
 *
 * A project is a snapshot, never a live pointer: the revision is fixed so that
 * a verdict recorded later can still name exactly what was examined.
 */

import { DomainError, invariant } from './errors.ts';
import type { ProjectId } from './ids.ts';
import { contentHash } from './integrity.ts';
import { asRevision, type RevisionId } from './revision.ts';

export { isFloatingRevision } from './revision.ts';

export type ProjectSourceKind = 'github' | 'local';

export interface ProjectSource {
  readonly kind: ProjectSourceKind;
  /** Repository URL for `github`, absolute path for `local`. */
  readonly location: string;
  /** Requested ref, if the user specified one (resolved into `revision`). */
  readonly ref?: string;
}

export interface DependencySnapshot {
  /** e.g. `npm`, `pypi`, `cargo`, `go`. */
  readonly ecosystem: string;
  /** Path to the manifest that produced this snapshot. */
  readonly manifestPath: string;
  /** Digest of the manifest (or lockfile) contents at the pinned revision. */
  readonly digest: string;
}

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly source: ProjectSource;
  /** Pinned revision: a full Git commit SHA or a SHA-256 content digest. */
  readonly revision: RevisionId;
  readonly dependencies: readonly DependencySnapshot[];
  /** Observed, non-secret configuration only. */
  readonly configuration: Readonly<Record<string, string>>;
  readonly createdAt: Date;
}

export interface CreateProjectInput {
  id: ProjectId;
  name: string;
  source: ProjectSource;
  revision: string;
  dependencies?: readonly DependencySnapshot[];
  configuration?: Readonly<Record<string, string>>;
  createdAt?: Date;
}

export function createProject(input: CreateProjectInput): Project {
  invariant(
    typeof input.name === 'string' && input.name.trim() !== '',
    'invalid_project_name',
    'Project name must be a non-empty string',
  );
  invariant(
    input.source.kind === 'github' || input.source.kind === 'local',
    'invalid_project_source',
    "Project source kind must be 'github' or 'local'",
  );
  invariant(
    typeof input.source.location === 'string' && input.source.location.trim() !== '',
    'invalid_project_location',
    'Project source location must be a non-empty string',
  );
  // Rejects floating refs, empty values and malformed identifiers.
  const revision = asRevision(input.revision);

  return cloneProject({
    id: input.id,
    name: input.name,
    source: input.source,
    revision,
    dependencies: input.dependencies ?? [],
    configuration: input.configuration ?? {},
    createdAt: input.createdAt ?? new Date(),
  });
}

/**
 * Deep copy of a project.
 *
 * `readonly` is a compile-time promise only: at runtime a caller still holds
 * references to the nested `source`, `dependencies` entries, `configuration` and
 * `createdAt`, and could mutate them after handing the project over. Any adapter
 * that stores or returns a snapshot must copy it, or the stored snapshot can
 * drift without ever passing through `assertProjectSnapshotCompatible`. The
 * strings and the branded revision are primitive and need no copy.
 */
export function cloneProject(project: Project): Project {
  return {
    id: project.id,
    name: project.name,
    source: { ...project.source },
    revision: project.revision,
    dependencies: project.dependencies.map((item) => ({ ...item })),
    configuration: { ...project.configuration },
    createdAt: new Date(project.createdAt.getTime()),
  };
}

/**
 * Source identity includes the requested ref.
 *
 * `main` and `v1.0.0` name different upstream states even when they currently
 * resolve to the same revision, so swapping the ref changes what the snapshot
 * claims to have been taken from.
 */
function isSameSource(left: ProjectSource, right: ProjectSource): boolean {
  return left.kind === right.kind && left.location === right.location && left.ref === right.ref;
}

function describeSource(source: ProjectSource): string {
  const base = `${source.kind}:${source.location}`;
  return source.ref === undefined ? base : `${base}@${source.ref}`;
}

/**
 * Canonical, order-insensitive digest of a dependency list.
 *
 * Dependencies are a set-like collection: re-importing the same manifests in a
 * different order is not a content change, so ordering must not affect the
 * comparison.
 */
function dependenciesDigest(dependencies: readonly DependencySnapshot[]): string {
  const keys = dependencies
    .map((item) => `${item.ecosystem}\u0000${item.manifestPath}\u0000${item.digest}`)
    .sort();
  return contentHash(keys);
}

/**
 * Guard that makes a project snapshot fully immutable.
 *
 * A run records the revision it verified, so silently re-pointing the same
 * project id at different code would detach every historical verdict from what
 * was actually examined. The same reasoning applies to every other recorded
 * observation about the snapshot: source ref, name, dependency digests and
 * configuration are part of what was verified, not mutable metadata.
 *
 * `createdAt` is deliberately excluded. It is provenance rather than content, and
 * excluding it keeps an identical re-save idempotent; adapters preserve the
 * original value when they accept one.
 *
 * Re-registering the source at a new revision — or with different recorded
 * observations — is the supported path, and it produces a new project id.
 */
export function assertProjectSnapshotCompatible(existing: Project, next: Project): void {
  if (existing.id !== next.id) {
    throw new DomainError(
      'project_id_mismatch',
      `Cannot compare snapshots for different projects (${existing.id} vs ${next.id})`,
    );
  }
  if (existing.revision !== next.revision) {
    throw new DomainError(
      'project_snapshot_immutable',
      `Project ${existing.id} is pinned to revision ${existing.revision} and cannot be ` +
        `re-pointed to ${next.revision}; register a new project instead`,
    );
  }
  if (!isSameSource(existing.source, next.source)) {
    throw new DomainError(
      'project_identity_immutable',
      `Project ${existing.id} belongs to ${describeSource(existing.source)} ` +
        `and cannot be re-pointed to ${describeSource(next.source)}`,
    );
  }
  if (existing.name !== next.name) {
    throw new DomainError(
      'project_name_immutable',
      `Project ${existing.id} is named '${existing.name}' and cannot change to ` +
        `'${next.name}'; register a new project instead`,
    );
  }
  if (dependenciesDigest(existing.dependencies) !== dependenciesDigest(next.dependencies)) {
    throw new DomainError(
      'project_dependencies_immutable',
      `Project ${existing.id} has a recorded dependency snapshot that cannot be replaced; ` +
        'register a new project instead',
    );
  }
  if (contentHash(existing.configuration) !== contentHash(next.configuration)) {
    throw new DomainError(
      'project_configuration_immutable',
      `Project ${existing.id} has a recorded configuration that cannot change; ` +
        'register a new project instead',
    );
  }
}
