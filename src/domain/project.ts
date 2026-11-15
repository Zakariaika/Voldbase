/**
 * Project — a pinned snapshot of a software or AI repository.
 *
 * A project is a snapshot, never a live pointer: the revision is fixed so that
 * a verdict recorded later can still name exactly what was examined.
 */

import { DomainError, invariant } from './errors.ts';
import type { ProjectId } from './ids.ts';
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

  return {
    id: input.id,
    name: input.name,
    source: input.source,
    revision,
    dependencies: input.dependencies ?? [],
    configuration: input.configuration ?? {},
    createdAt: input.createdAt ?? new Date(),
  };
}

/**
 * Guard that makes a project snapshot immutable.
 *
 * A run records the revision it verified, so silently re-pointing the same
 * project id at different code would detach every historical verdict from what
 * was actually examined. Re-registering the source at a new revision is the
 * supported path, and it produces a new project id.
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
  if (
    existing.source.kind !== next.source.kind ||
    existing.source.location !== next.source.location
  ) {
    throw new DomainError(
      'project_identity_immutable',
      `Project ${existing.id} belongs to ${existing.source.kind}:${existing.source.location} ` +
        `and cannot be re-pointed to ${next.source.kind}:${next.source.location}`,
    );
  }
}
