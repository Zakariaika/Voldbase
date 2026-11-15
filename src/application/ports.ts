/**
 * Ports — every capability the application layer needs from the outside world.
 *
 * Ports are narrow (one capability each) so adapters stay substitutable and the
 * domain remains unreachable from I/O (ADR-0003).
 */

import type { Experiment } from '../domain/experiment.ts';
import type { EvidenceRef } from '../domain/evidence.ts';
import type { ExperimentId, ProjectId, RunId } from '../domain/ids.ts';
import type { Project } from '../domain/project.ts';
import type { RevisionId } from '../domain/revision.ts';
import type { Run } from '../domain/run.ts';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** A new unique identifier for a domain entity. */
  next(): string;
}

export interface ProjectRepository {
  save(project: Project): Promise<void>;
  findById(id: ProjectId): Promise<Project | undefined>;
  list(): Promise<Project[]>;
}

/** A dependency manifest found in an imported project, with its own digest. */
export interface DetectedManifest {
  /** Ecosystem the manifest belongs to: `npm`, `pypi`, `cargo`, `gomod`, `composer`. */
  readonly ecosystem: string;
  /** POSIX-style path relative to the project root. */
  readonly manifestPath: string;
  /** SHA-256 of the manifest file's bytes. */
  readonly digest: string;
}

/**
 * Result of scanning a project directory.
 *
 * `revision` is a `sha256` snapshot digest over the actual file contents, not a
 * Git revision: the point is to describe what was imported, including an
 * uncommitted working tree.
 */
export interface ProjectScan {
  /** Normalized absolute path of the scanned directory. */
  readonly root: string;
  /** Directory name, used when the caller does not supply a name. */
  readonly suggestedName: string;
  readonly revision: RevisionId;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly manifests: readonly DetectedManifest[];
  /** Entries deliberately not part of the snapshot. */
  readonly skipped: {
    readonly symlinks: number;
    readonly excludedDirectories: number;
  };
}

/**
 * Read-only project scanning.
 *
 * Implementations must be deterministic (same tree, same digest), must not
 * follow symbolic links, and must never execute or install anything.
 */
export interface ProjectScanner {
  /**
   * Scan a directory and compute its snapshot revision.
   *
   * @throws DomainError for missing/unreadable paths, empty projects and limit
   * violations — never by returning a partial snapshot silently.
   */
  scan(directoryPath: string): Promise<ProjectScan>;
}

export interface ExperimentRepository {
  save(experiment: Experiment): Promise<void>;
  findById(id: ExperimentId): Promise<Experiment | undefined>;
  listByProject(projectId: ProjectId): Promise<Experiment[]>;
}

export interface RunRepository {
  /**
   * Persist a run.
   *
   * Implementations must reject any attempt to overwrite a run that has reached
   * a terminal state: run history is append-only (ADR-0006).
   */
  save(run: Run): Promise<void>;
  findById(id: RunId): Promise<Run | undefined>;
  listByExperiment(experimentId: ExperimentId): Promise<Run[]>;
}

/** Where content-addressed evidence blobs live. Phase 1: local filesystem. */
export interface ArtifactStore {
  put(bytes: Uint8Array, mediaType: string): Promise<EvidenceRef>;
  read(sha256: string): Promise<Uint8Array | undefined>;
}

export interface ExecutionRequest {
  readonly projectId: ProjectId;
  readonly experimentId: ExperimentId;
  readonly runId: RunId;
  readonly definitionHash: string;
}

export interface ExecutionOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifacts: readonly EvidenceRef[];
}

/**
 * Isolated execution.
 *
 * **Intentionally unimplemented in Phase 0.** No adapter exists, and none may be
 * added until the isolation requirements in ADR-0005 are met and reviewed.
 */
export interface Executor {
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}
