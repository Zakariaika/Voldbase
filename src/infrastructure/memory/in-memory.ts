/**
 * In-memory adapters.
 *
 * Used by tests and by any caller that needs a throwaway store. There is no
 * persistence here: durable local storage arrives in Phase 1 behind the same
 * ports (ADR-0004).
 */

import {
  cloneAnalysisSnapshot,
  type AnalysisSnapshot,
} from '../../domain/analysis.ts';
import {
  assertExperimentRevisionIntegrity,
  cloneExperiment,
  type Experiment,
} from '../../domain/experiment.ts';
import { DomainError } from '../../domain/errors.ts';
import type { AnalysisId, ExperimentId, ProjectId, RunId } from '../../domain/ids.ts';
import {
  assertProjectSnapshotCompatible,
  cloneProject,
  type Project,
} from '../../domain/project.ts';
import { isTerminal, type Run } from '../../domain/run.ts';
import type {
  AnalysisRepository,
  Clock,
  ExperimentRepository,
  IdGenerator,
  ProjectRepository,
  RunRepository,
} from '../../application/ports.ts';

export class InMemoryProjectRepository implements ProjectRepository {
  readonly #byId = new Map<ProjectId, Project>();

  async save(project: Project): Promise<void> {
    const existing = this.#byId.get(project.id);
    if (existing !== undefined) {
      // A snapshot is immutable: re-pointing an id at other content would
      // detach every existing run from the code it verified.
      assertProjectSnapshotCompatible(existing, project);
      // Content is unchanged, so keep the original provenance. The copy stops
      // the caller's object graph from aliasing what is stored.
      this.#byId.set(project.id, {
        ...cloneProject(project),
        createdAt: new Date(existing.createdAt.getTime()),
      });
      return;
    }
    // Store a copy: `readonly` does not survive at runtime, so keeping the
    // caller's references would let them mutate the snapshot behind the guard.
    this.#byId.set(project.id, cloneProject(project));
  }

  async findById(id: ProjectId): Promise<Project | undefined> {
    const stored = this.#byId.get(id);
    // Return a copy for the same reason: a reader must not be able to mutate
    // the stored snapshot through the object it was handed.
    return stored === undefined ? undefined : cloneProject(stored);
  }

  async list(): Promise<Project[]> {
    return [...this.#byId.values()].map(cloneProject);
  }
}

export class InMemoryAnalysisRepository implements AnalysisRepository {
  readonly #byId = new Map<AnalysisId, AnalysisSnapshot>();

  async save(snapshot: AnalysisSnapshot): Promise<void> {
    const existing = this.#byId.get(snapshot.analysisId);
    if (existing !== undefined) {
      if (existing.digest !== snapshot.digest) {
        throw new DomainError(
          'analysis_immutable',
          `Analysis ${snapshot.analysisId} already exists with different content; an analysis ` +
            'is immutable — run a new analysis instead',
        );
      }
      return;
    }
    this.#byId.set(snapshot.analysisId, cloneAnalysisSnapshot(snapshot));
  }

  async findById(id: AnalysisId): Promise<AnalysisSnapshot | undefined> {
    const stored = this.#byId.get(id);
    return stored === undefined ? undefined : cloneAnalysisSnapshot(stored);
  }

  async listByProject(projectId: ProjectId): Promise<AnalysisSnapshot[]> {
    return [...this.#byId.values()]
      .filter((snapshot) => snapshot.projectId === projectId)
      .map(cloneAnalysisSnapshot);
  }
}

export class InMemoryExperimentRepository implements ExperimentRepository {
  readonly #byId = new Map<ExperimentId, Experiment>();

  async save(experiment: Experiment): Promise<void> {
    const existing = this.#byId.get(experiment.id);
    if (existing !== undefined) {
      // Every adapter enforces the same revision rule as durable storage.
      assertExperimentRevisionIntegrity(existing, experiment);
    }
    // Store a detached copy: `readonly` is a compile-time promise only, so
    // keeping the caller's references would let it mutate the definition behind
    // the revision guard.
    this.#byId.set(experiment.id, cloneExperiment(experiment));
  }

  async findById(id: ExperimentId): Promise<Experiment | undefined> {
    const stored = this.#byId.get(id);
    // Return a copy: a reader must not be able to mutate stored state through
    // the object it was handed.
    return stored === undefined ? undefined : cloneExperiment(stored);
  }

  async listByProject(projectId: ProjectId): Promise<Experiment[]> {
    return [...this.#byId.values()]
      .filter((item) => item.projectId === projectId)
      .map(cloneExperiment);
  }
}

export class InMemoryRunRepository implements RunRepository {
  readonly #byId = new Map<RunId, Run>();

  async save(run: Run): Promise<void> {
    const existing = this.#byId.get(run.id);
    if (existing !== undefined && isTerminal(existing.state)) {
      throw new DomainError(
        'immutable_run',
        `Run ${run.id} is ${existing.state} and cannot be modified; record a new run instead`,
      );
    }
    this.#byId.set(run.id, run);
  }

  async findById(id: RunId): Promise<Run | undefined> {
    return this.#byId.get(id);
  }

  async listByExperiment(experimentId: ExperimentId): Promise<Run[]> {
    return [...this.#byId.values()].filter((item) => item.experimentId === experimentId);
  }
}

export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date) {
    this.#current = start;
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  advance(milliseconds: number): void {
    this.#current = new Date(this.#current.getTime() + milliseconds);
  }
}

/** Deterministic ids for tests, e.g. `run-1`, `run-2`. */
export class SequentialIdGenerator implements IdGenerator {
  readonly #prefix: string;
  #next = 0;

  constructor(prefix = 'id') {
    this.#prefix = prefix;
  }

  next(): string {
    this.#next += 1;
    return `${this.#prefix}-${this.#next}`;
  }
}
