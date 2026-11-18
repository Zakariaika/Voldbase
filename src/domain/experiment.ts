/**
 * Experiment — a defined, falsifiable verification procedure for a project.
 *
 * Editing an experiment bumps `definitionVersion` but never rewrites existing
 * runs, which pin the definition hash they executed against (ADR-0006).
 */

import { invariant } from './errors.ts';
import { contentHash } from './integrity.ts';
import type { ExperimentId, ProjectId } from './ids.ts';

export type Determinism = 'deterministic' | 'statistical' | 'unknown';

export interface ExperimentStep {
  /** Zero-based, contiguous across the step list. */
  readonly index: number;
  readonly description: string;
  /** A command the executor would run. Absent for manual/observational steps. */
  readonly command?: string;
}

export interface Experiment {
  readonly id: ExperimentId;
  readonly projectId: ProjectId;
  readonly name: string;
  /** The falsifiable claim under test. */
  readonly hypothesis: string;
  readonly steps: readonly ExperimentStep[];
  readonly determinism: Determinism;
  /** Observations that would count as `PASS`. May not be empty. */
  readonly expectedObservations: readonly string[];
  readonly definitionVersion: number;
  readonly createdAt: Date;
}

export interface CreateExperimentInput {
  id: ExperimentId;
  projectId: ProjectId;
  name: string;
  hypothesis: string;
  steps: readonly ExperimentStep[];
  determinism?: Determinism;
  expectedObservations: readonly string[];
  definitionVersion?: number;
  createdAt?: Date;
}

export function createExperiment(input: CreateExperimentInput): Experiment {
  invariant(
    typeof input.name === 'string' && input.name.trim() !== '',
    'invalid_experiment_name',
    'Experiment name must be a non-empty string',
  );
  invariant(
    typeof input.hypothesis === 'string' && input.hypothesis.trim() !== '',
    'invalid_experiment_hypothesis',
    'Experiment hypothesis must be a non-empty string',
  );
  invariant(
    input.steps.length > 0,
    'empty_experiment_steps',
    'An experiment requires at least one step',
  );
  input.steps.forEach((step, position) => {
    invariant(
      step.index === position,
      'non_contiguous_experiment_steps',
      `Experiment step at position ${position} must have index ${position}, received ${step.index}`,
    );
    invariant(
      typeof step.description === 'string' && step.description.trim() !== '',
      'invalid_experiment_step',
      `Experiment step ${position} requires a description`,
    );
  });
  invariant(
    input.expectedObservations.length > 0,
    'empty_expectations',
    'An experiment requires at least one expected observation to be falsifiable',
  );

  const determinism = input.determinism ?? 'unknown';

  return {
    id: input.id,
    projectId: input.projectId,
    name: input.name,
    hypothesis: input.hypothesis,
    steps: input.steps,
    determinism,
    expectedObservations: input.expectedObservations,
    definitionVersion: input.definitionVersion ?? 1,
    createdAt: input.createdAt ?? new Date(),
  };
}

/**
 * Deep copy of an experiment.
 *
 * `readonly` is a compile-time promise only: a caller still holds references to
 * `steps`, `expectedObservations` and `createdAt`, and could mutate them after
 * handing the experiment over. Adapters that store or return an experiment must
 * copy it, or the stored definition can drift without passing through a guard.
 */
export function cloneExperiment(experiment: Experiment): Experiment {
  return {
    id: experiment.id,
    projectId: experiment.projectId,
    name: experiment.name,
    hypothesis: experiment.hypothesis,
    steps: experiment.steps.map((step) =>
      step.command === undefined
        ? { index: step.index, description: step.description }
        : { index: step.index, description: step.description, command: step.command },
    ),
    determinism: experiment.determinism,
    expectedObservations: [...experiment.expectedObservations],
    definitionVersion: experiment.definitionVersion,
    createdAt: new Date(experiment.createdAt.getTime()),
  };
}

/**
 * Stable hash of an experiment's executable definition.
 *
 * Deliberately excludes `id`, `createdAt` and `definitionVersion`: the same
 * procedure must hash the same when re-created, while a changed step or
 * expectation must not.
 */
export function experimentDefinitionHash(experiment: Experiment): string {
  return contentHash({
    projectId: experiment.projectId,
    name: experiment.name,
    hypothesis: experiment.hypothesis,
    determinism: experiment.determinism,
    steps: experiment.steps.map((step) => ({
      index: step.index,
      description: step.description,
      command: step.command ?? null,
    })),
    expectedObservations: experiment.expectedObservations,
  });
}
