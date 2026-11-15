/**
 * Run — one execution of an experiment, with its environment and evidence.
 *
 * Lifecycle is one-way and separate from the verdict. A terminal run is
 * immutable; corrections are new runs, never edits (ADR-0006).
 */

import type { EvidenceRef } from './evidence.ts';
import { DomainError, invariant } from './errors.ts';
import type { ExperimentId, ProjectId, RunId } from './ids.ts';
import { requiresEvidence, type ResultStatus } from './result.ts';

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface EnvironmentManifest {
  readonly os: string;
  readonly arch: string;
  /** Runtime family, e.g. `node`, `python`, `jvm`. */
  readonly runtime: string;
  readonly runtimeVersion: string;
  /** Digest of the dependency lockfile used, when one exists. */
  readonly lockfileDigest?: string;
  /** Content-addressed runner image digest, when a container was used. */
  readonly containerImageDigest?: string;
}

export interface Run {
  readonly id: RunId;
  readonly projectId: ProjectId;
  readonly experimentId: ExperimentId;
  /** Hash of the experiment definition as it existed when this run was created. */
  readonly experimentDefinitionHash: string;
  readonly environment: EnvironmentManifest;
  readonly state: RunState;
  readonly result?: ResultStatus;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  readonly evidence: readonly EvidenceRef[];
  readonly notes?: string;
}

export interface CreateRunInput {
  id: RunId;
  projectId: ProjectId;
  experimentId: ExperimentId;
  experimentDefinitionHash: string;
  environment: EnvironmentManifest;
}

const TERMINAL_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function createRun(input: CreateRunInput): Run {
  invariant(
    typeof input.experimentDefinitionHash === 'string' &&
      input.experimentDefinitionHash.trim() !== '',
    'missing_definition_hash',
    'A run must pin the experiment definition hash it executes',
  );
  invariant(
    input.environment.os.trim() !== '' &&
      input.environment.arch.trim() !== '' &&
      input.environment.runtime.trim() !== '' &&
      input.environment.runtimeVersion.trim() !== '',
    'incomplete_environment',
    'A run must record os, arch, runtime and runtime version',
  );

  return {
    id: input.id,
    projectId: input.projectId,
    experimentId: input.experimentId,
    experimentDefinitionHash: input.experimentDefinitionHash,
    environment: input.environment,
    state: 'queued',
    evidence: [],
  };
}

export function startRun(run: Run, startedAt: Date): Run {
  if (run.state !== 'queued') {
    throw new DomainError(
      'invalid_run_transition',
      `Only a queued run can start; run ${run.id} is ${run.state}`,
    );
  }
  return { ...run, state: 'running', startedAt };
}

export interface CompleteRunInput {
  result: ResultStatus;
  finishedAt: Date;
  evidence?: readonly EvidenceRef[];
  notes?: string;
}

/**
 * Record a verdict and finish the run.
 *
 * `PASS` and `FAIL` claim that something was observed, so they cannot be
 * recorded without evidence.
 */
export function completeRun(run: Run, input: CompleteRunInput): Run {
  if (run.state !== 'running') {
    throw new DomainError(
      'invalid_run_transition',
      `Only a running run can be completed; run ${run.id} is ${run.state}`,
    );
  }
  if (run.startedAt !== undefined && input.finishedAt.getTime() < run.startedAt.getTime()) {
    throw new DomainError(
      'invalid_run_timestamps',
      'Run cannot finish before it started',
    );
  }

  const evidence = input.evidence ?? run.evidence;

  if (requiresEvidence(input.result) && evidence.length === 0) {
    throw new DomainError(
      'missing_evidence',
      `Result ${input.result} requires at least one evidence reference`,
    );
  }

  return {
    ...run,
    state: input.result === 'BLOCKED' ? 'failed' : 'completed',
    result: input.result,
    finishedAt: input.finishedAt,
    evidence,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

/** Cancel a run that has not reached a terminal state. A cancelled run has no verdict. */
export function cancelRun(run: Run, finishedAt: Date): Run {
  if (isTerminal(run.state)) {
    throw new DomainError(
      'invalid_run_transition',
      `Run ${run.id} is already ${run.state} and cannot be cancelled`,
    );
  }
  return {
    ...run,
    state: 'cancelled',
    finishedAt,
    evidence: run.evidence,
  };
}
