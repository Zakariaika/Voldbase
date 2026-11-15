/**
 * Project — a pinned snapshot of a software or AI repository.
 *
 * A project is a snapshot, never a live pointer: the revision is fixed so that
 * a verdict recorded later can still name exactly what was examined.
 */

import { DomainError, invariant } from './errors.ts';
import type { ProjectId } from './ids.ts';

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
  /** Pinned revision: a commit SHA or content digest. Never a floating ref. */
  readonly revision: string;
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

/** Refs that can move; a project must never be pinned to one of these. */
const FLOATING_REFS = new Set(['head', 'main', 'master', 'latest', 'trunk', 'develop']);

export function isFloatingRevision(revision: string): boolean {
  const normalized = revision.trim().toLowerCase();
  return (
    FLOATING_REFS.has(normalized) ||
    normalized.startsWith('refs/heads/') ||
    normalized === ''
  );
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
  if (isFloatingRevision(input.revision)) {
    throw new DomainError(
      'unpinned_revision',
      `Project revision must be pinned to a commit or digest, received '${input.revision}'`,
    );
  }

  return {
    id: input.id,
    name: input.name,
    source: input.source,
    revision: input.revision,
    dependencies: input.dependencies ?? [],
    configuration: input.configuration ?? {},
    createdAt: input.createdAt ?? new Date(),
  };
}
