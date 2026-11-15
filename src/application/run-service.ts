/**
 * Run use cases.
 *
 * This is the thinnest useful orchestration: create a run pinned to an
 * experiment definition, start it, and record an outcome. Execution itself is
 * deliberately absent (ADR-0005) — this service records what a caller reports
 * and enforces the invariants around it.
 */

import { experimentDefinitionHash, type Experiment } from '../domain/experiment.ts';
import type { EvidenceRef } from '../domain/evidence.ts';
import { DomainError } from '../domain/errors.ts';
import type { ProjectId, RunId } from '../domain/ids.ts';
import type { ResultStatus } from '../domain/result.ts';
import {
  completeRun,
  createRun,
  startRun,
  type EnvironmentManifest,
  type Run,
} from '../domain/run.ts';
import type {
  Clock,
  ExperimentRepository,
  IdGenerator,
  ProjectRepository,
  RunRepository,
} from './ports.ts';

export interface RunServiceDeps {
  projects: ProjectRepository;
  experiments: ExperimentRepository;
  runs: RunRepository;
  clock: Clock;
  ids: IdGenerator;
}

export interface CreateRunCommand {
  projectId: ProjectId;
  experimentId: string;
  environment: EnvironmentManifest;
}

export interface RecordOutcomeCommand {
  runId: string;
  result: ResultStatus | string;
  evidence?: readonly EvidenceRef[];
  notes?: string;
}

const RESULTS: readonly string[] = ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_TESTED', 'BLOCKED'];

export class RunService {
  readonly #deps: RunServiceDeps;

  constructor(deps: RunServiceDeps) {
    this.#deps = deps;
  }

  async createRun(command: CreateRunCommand): Promise<Run> {
    const project = await this.#deps.projects.findById(command.projectId);
    if (project === undefined) {
      throw new DomainError('project_not_found', `Project ${command.projectId} does not exist`);
    }

    const experiment = await this.#deps.experiments.findById(
      command.experimentId as Experiment['id'],
    );
    if (experiment === undefined) {
      throw new DomainError(
        'experiment_not_found',
        `Experiment ${command.experimentId} does not exist`,
      );
    }
    if (experiment.projectId !== project.id) {
      throw new DomainError(
        'experiment_project_mismatch',
        `Experiment ${experiment.id} does not belong to project ${project.id}`,
      );
    }

    const run = createRun({
      id: this.#deps.ids.next() as RunId,
      projectId: project.id,
      experimentId: experiment.id,
      experimentDefinitionHash: experimentDefinitionHash(experiment),
      environment: command.environment,
    });

    await this.#deps.runs.save(run);
    return run;
  }

  async startRun(runId: string): Promise<Run> {
    const run = await this.#requireRun(runId);
    const started = startRun(run, this.#deps.clock.now());
    await this.#deps.runs.save(started);
    return started;
  }

  async recordOutcome(command: RecordOutcomeCommand): Promise<Run> {
    const run = await this.#requireRun(command.runId);

    if (!RESULTS.includes(command.result)) {
      throw new DomainError(
        'invalid_result_status',
        `'${command.result}' is not a valid result status`,
      );
    }

    const completed = completeRun(run, {
      result: command.result as ResultStatus,
      finishedAt: this.#deps.clock.now(),
      ...(command.evidence === undefined ? {} : { evidence: command.evidence }),
      ...(command.notes === undefined ? {} : { notes: command.notes }),
    });

    await this.#deps.runs.save(completed);
    return completed;
  }

  async #requireRun(runId: string): Promise<Run> {
    const run = await this.#deps.runs.findById(runId as RunId);
    if (run === undefined) {
      throw new DomainError('run_not_found', `Run ${runId} does not exist`);
    }
    return run;
  }
}
