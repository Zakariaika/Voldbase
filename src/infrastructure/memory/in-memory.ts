/**
 * In-memory adapters.
 *
 * Used by tests and by any caller that needs a throwaway store. There is no
 * persistence here: durable local storage arrives in Phase 1 behind the same
 * ports (ADR-0004).
 */

import type { Experiment } from '../../domain/experiment.ts';
import { DomainError } from '../../domain/errors.ts';
import type { ExperimentId, ProjectId, RunId } from '../../domain/ids.ts';
import { assertProjectSnapshotCompatible, type Project } from '../../domain/project.ts';
import { isTerminal, type Run } from '../../domain/run.ts';
import type {
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
      // Content is unchanged, so keep the original provenance.
      this.#byId.set(project.id, { ...project, createdAt: existing.createdAt });
      return;
    }
    this.#byId.set(project.id, project);
  }

  async findById(id: ProjectId): Promise<Project | undefined> {
    return this.#byId.get(id);
  }

  async list(): Promise<Project[]> {
    return [...this.#byId.values()];
  }
}

export class InMemoryExperimentRepository implements ExperimentRepository {
  readonly #byId = new Map<ExperimentId, Experiment>();

  async save(experiment: Experiment): Promise<void> {
    this.#byId.set(experiment.id, experiment);
  }

  async findById(id: ExperimentId): Promise<Experiment | undefined> {
    return this.#byId.get(id);
  }

  async listByProject(projectId: ProjectId): Promise<Experiment[]> {
    return [...this.#byId.values()].filter((item) => item.projectId === projectId);
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
