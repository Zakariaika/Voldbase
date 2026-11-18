/**
 * Versioned on-disk representation of experiments and runs (Phase 2C).
 *
 * Experiments and runs live in their own documents, independent of
 * `projects.json` and `analyses.json`: a corrupted experiment or run file must
 * never be able to damage or block project or analysis data.
 *
 * Everything read from disk is rebuilt through the domain constructors, so a
 * hand-edited file cannot smuggle an invalid definition, a non-contiguous step
 * list, an impossible lifecycle or malformed evidence into the application.
 * Nothing is repaired silently: a record that fails validation is reported as
 * `storage_corrupted` and the file is left untouched.
 *
 * Writes are validated the same way: a candidate record is serialized and
 * rehydrated before `#persist`, so a record the loader would reject can never
 * reach the document.
 */

import { createEvidenceRef, type EvidenceRef } from '../../domain/evidence.ts';
import {
  createExperiment,
  type Determinism,
  type Experiment,
  type ExperimentStep,
} from '../../domain/experiment.ts';
import { DomainError } from '../../domain/errors.ts';
import { asArtifactId, asExperimentId, asProjectId, asRunId } from '../../domain/ids.ts';
import { isResultStatus, type ResultStatus } from '../../domain/result.ts';
import {
  cancelRun,
  completeRun,
  createRun,
  startRun,
  type EnvironmentManifest,
  type Run,
  type RunState,
} from '../../domain/run.ts';

/** Schema version written by this build. Bump when the document shape changes. */
export const EXPERIMENT_STORAGE_SCHEMA_VERSION = 1;

/** Schema version written by this build. Bump when the document shape changes. */
export const RUN_STORAGE_SCHEMA_VERSION = 1;

/** File name of the experiment store inside the VOLDBASE home directory. */
export const EXPERIMENTS_FILE_NAME = 'experiments.json';

/** File name of the run store inside the VOLDBASE home directory. */
export const RUNS_FILE_NAME = 'runs.json';

export interface StoredExperimentStep {
  readonly index: number;
  readonly description: string;
  readonly command?: string;
}

export interface StoredExperiment {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly hypothesis: string;
  readonly steps: readonly StoredExperimentStep[];
  readonly determinism: string;
  readonly expectedObservations: readonly string[];
  readonly definitionVersion: number;
  readonly createdAt: string;
}

export interface ExperimentsDocumentV1 {
  readonly schemaVersion: 1;
  readonly experiments: readonly StoredExperiment[];
}

export interface StoredRun {
  readonly id: string;
  readonly projectId: string;
  readonly projectRevision: string;
  readonly experimentId: string;
  readonly experimentDefinitionHash: string;
  readonly environment: EnvironmentManifest;
  readonly state: string;
  readonly result?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly evidence: readonly EvidenceRef[];
  readonly notes?: string;
}

export interface RunsDocumentV1 {
  readonly schemaVersion: 1;
  readonly runs: readonly StoredRun[];
}

const DETERMINISMS: readonly Determinism[] = ['deterministic', 'statistical', 'unknown'];

const RUN_STATES: readonly RunState[] = ['queued', 'running', 'completed', 'failed', 'cancelled'];

type Fail = (detail: string) => DomainError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function experimentCorrupted(detail: string): DomainError {
  return new DomainError('storage_corrupted', `Stored experiment data is invalid: ${detail}`);
}

function runCorrupted(detail: string): DomainError {
  return new DomainError('storage_corrupted', `Stored run data is invalid: ${detail}`);
}

/**
 * Reject duplicate ids outright.
 *
 * A document with two records under the same id cannot be represented by the
 * repository's map without silently dropping one of them, so the duplicate is
 * reported as corruption instead of resolving it by position.
 */
function assertUniqueIds<T>(
  records: readonly T[],
  idOf: (record: T) => string,
  kind: string,
  fail: Fail,
): void {
  const seen = new Set<string>();
  for (const record of records) {
    const id = idOf(record);
    if (seen.has(id)) {
      throw fail(`duplicate ${kind} id '${id}'`);
    }
    seen.add(id);
  }
}

function requireText(value: unknown, field: string, fail: Fail): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, field: string, fail: Fail): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(`${field} must be a non-empty string when present`);
  }
  return value;
}

function requireInteger(value: unknown, field: string, fail: Fail, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw fail(`${field} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string, fail: Fail): Date {
  if (typeof value !== 'string') {
    throw fail(`${field} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw fail(`${field} is not a valid ISO timestamp`);
  }
  return date;
}

function readSteps(value: unknown, context: string): ExperimentStep[] {
  if (!Array.isArray(value)) {
    throw experimentCorrupted(`${context} has no steps array`);
  }
  return value.map((entry, position) => {
    if (!isRecord(entry)) {
      throw experimentCorrupted(`${context} step #${position + 1} is not an object`);
    }
    const index = requireInteger(
      entry.index,
      `${context} step #${position + 1} index`,
      experimentCorrupted,
      0,
    );
    const description = requireText(
      entry.description,
      `${context} step #${position + 1} description`,
      experimentCorrupted,
    );
    const command = optionalText(
      entry.command,
      `${context} step #${position + 1} command`,
      experimentCorrupted,
    );
    return command === undefined
      ? { index, description }
      : { index, description, command };
  });
}

function readDeterminism(value: unknown, context: string): Determinism {
  if (typeof value !== 'string' || !DETERMINISMS.includes(value as Determinism)) {
    throw experimentCorrupted(
      `${context} determinism must be one of ${DETERMINISMS.join(', ')}`,
    );
  }
  return value as Determinism;
}

function readObservations(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw experimentCorrupted(`${context} has no expectedObservations array`);
  }
  return value.map((entry, position) =>
    requireText(entry, `${context} expected observation #${position + 1}`, experimentCorrupted),
  );
}

/** Rebuild a domain experiment from its stored form, validating every invariant. */
export function storedToExperiment(value: unknown, context = 'experiment'): Experiment {
  if (!isRecord(value)) {
    throw experimentCorrupted(`${context} is not an object`);
  }
  const id = requireText(value.id, `${context} id`, experimentCorrupted);
  const projectId = requireText(value.projectId, `${context} projectId`, experimentCorrupted);
  const name = requireText(value.name, `${context} name`, experimentCorrupted);
  const hypothesis = requireText(value.hypothesis, `${context} hypothesis`, experimentCorrupted);
  const steps = readSteps(value.steps, context);
  const determinism = readDeterminism(value.determinism, context);
  const expectedObservations = readObservations(value.expectedObservations, context);
  const definitionVersion = requireInteger(
    value.definitionVersion,
    `${context} definitionVersion`,
    experimentCorrupted,
    1,
  );
  const createdAt = requireTimestamp(value.createdAt, `${context} createdAt`, experimentCorrupted);

  try {
    return createExperiment({
      id: asExperimentId(id),
      projectId: asProjectId(projectId),
      name,
      hypothesis,
      steps,
      determinism,
      expectedObservations,
      definitionVersion,
      createdAt,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw experimentCorrupted(`${context}: ${error.message}`);
    }
    throw error;
  }
}

export function experimentToStored(experiment: Experiment): StoredExperiment {
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
    createdAt: experiment.createdAt.toISOString(),
  };
}

function readEnvironment(value: unknown, context: string): EnvironmentManifest {
  if (!isRecord(value)) {
    throw runCorrupted(`${context} environment is not an object`);
  }
  const os = requireText(value.os, `${context} environment os`, runCorrupted);
  const arch = requireText(value.arch, `${context} environment arch`, runCorrupted);
  const runtime = requireText(value.runtime, `${context} environment runtime`, runCorrupted);
  const runtimeVersion = requireText(
    value.runtimeVersion,
    `${context} environment runtimeVersion`,
    runCorrupted,
  );
  const lockfileDigest = optionalText(
    value.lockfileDigest,
    `${context} environment lockfileDigest`,
    runCorrupted,
  );
  const containerImageDigest = optionalText(
    value.containerImageDigest,
    `${context} environment containerImageDigest`,
    runCorrupted,
  );

  return {
    os,
    arch,
    runtime,
    runtimeVersion,
    ...(lockfileDigest === undefined ? {} : { lockfileDigest }),
    ...(containerImageDigest === undefined ? {} : { containerImageDigest }),
  };
}

function readEvidence(value: unknown, context: string): EvidenceRef[] {
  if (!Array.isArray(value)) {
    throw runCorrupted(`${context} has no evidence array`);
  }
  return value.map((entry, position) => {
    const label = `${context} evidence #${position + 1}`;
    if (!isRecord(entry)) {
      throw runCorrupted(`${label} is not an object`);
    }
    const artifactId = requireText(entry.artifactId, `${label} artifactId`, runCorrupted);
    const sha256 = requireText(entry.sha256, `${label} sha256`, runCorrupted);
    const mediaType = requireText(entry.mediaType, `${label} mediaType`, runCorrupted);
    const bytes = requireInteger(entry.bytes, `${label} bytes`, runCorrupted, 0);
    const description = optionalText(entry.description, `${label} description`, runCorrupted);

    try {
      return createEvidenceRef({
        artifactId: asArtifactId(artifactId),
        sha256,
        mediaType,
        bytes,
        ...(description === undefined ? {} : { description }),
      });
    } catch (error) {
      if (error instanceof DomainError) {
        throw runCorrupted(`${label}: ${error.message}`);
      }
      throw error;
    }
  });
}

function readRunState(value: unknown, context: string): RunState {
  if (typeof value !== 'string' || !RUN_STATES.includes(value as RunState)) {
    throw runCorrupted(`${context} state must be one of ${RUN_STATES.join(', ')}`);
  }
  return value as RunState;
}

function readOptionalTimestamp(value: unknown, field: string): Date | undefined {
  return value === undefined ? undefined : requireTimestamp(value, field, runCorrupted);
}

/**
 * Rebuild a domain run from its stored form.
 *
 * The record is replayed through `createRun`/`startRun`/`completeRun`/`cancelRun`
 * rather than assembled by hand, so the stored lifecycle must satisfy exactly the
 * same transition invariants as a live run (including the evidence requirement
 * for `PASS` and `FAIL`). A stored state that the domain could never have
 * produced is reported as corruption.
 */
export function storedToRun(value: unknown, context = 'run'): Run {
  if (!isRecord(value)) {
    throw runCorrupted(`${context} is not an object`);
  }
  const id = requireText(value.id, `${context} id`, runCorrupted);
  const projectId = requireText(value.projectId, `${context} projectId`, runCorrupted);
  const projectRevision = requireText(
    value.projectRevision,
    `${context} projectRevision`,
    runCorrupted,
  );
  const experimentId = requireText(value.experimentId, `${context} experimentId`, runCorrupted);
  const experimentDefinitionHash = requireText(
    value.experimentDefinitionHash,
    `${context} experimentDefinitionHash`,
    runCorrupted,
  );
  const environment = readEnvironment(value.environment, context);
  const state = readRunState(value.state, context);
  const evidence = readEvidence(value.evidence, context);
  const notes = optionalText(value.notes, `${context} notes`, runCorrupted);
  const startedAt = readOptionalTimestamp(value.startedAt, `${context} startedAt`);
  const finishedAt = readOptionalTimestamp(value.finishedAt, `${context} finishedAt`);

  if (value.result !== undefined && !isResultStatus(value.result)) {
    throw runCorrupted(`${context} result is not a recognized result status`);
  }
  const result = value.result as ResultStatus | undefined;

  if (state === 'queued') {
    if (startedAt !== undefined || finishedAt !== undefined || result !== undefined) {
      throw runCorrupted(`${context} is queued but already records an execution`);
    }
    if (evidence.length > 0 || notes !== undefined) {
      throw runCorrupted(`${context} is queued but records evidence or notes`);
    }
  } else if (state === 'running') {
    if (startedAt === undefined) {
      throw runCorrupted(`${context} is running but has no startedAt`);
    }
    if (finishedAt !== undefined || result !== undefined) {
      throw runCorrupted(`${context} is running but records a verdict`);
    }
    if (evidence.length > 0 || notes !== undefined) {
      throw runCorrupted(`${context} is running but records evidence or notes`);
    }
  } else if (state === 'cancelled') {
    if (finishedAt === undefined) {
      throw runCorrupted(`${context} is cancelled but has no finishedAt`);
    }
    if (result !== undefined) {
      throw runCorrupted(`${context} is cancelled but records a verdict`);
    }
  } else {
    if (startedAt === undefined || finishedAt === undefined) {
      throw runCorrupted(`${context} is ${state} without a complete execution window`);
    }
    if (result === undefined) {
      throw runCorrupted(`${context} is ${state} but records no result`);
    }
  }

  let rebuilt: Run;
  try {
    const base = createRun({
      id: asRunId(id),
      projectId: asProjectId(projectId),
      projectRevision,
      experimentId: asExperimentId(experimentId),
      experimentDefinitionHash,
      environment,
    });

    if (state === 'queued') {
      rebuilt = base;
    } else if (state === 'running') {
      rebuilt = startRun(base, startedAt as Date);
    } else if (state === 'cancelled') {
      const started = startedAt === undefined ? base : startRun(base, startedAt);
      rebuilt = cancelRun(started, finishedAt as Date);
    } else {
      rebuilt = completeRun(startRun(base, startedAt as Date), {
        result: result as ResultStatus,
        finishedAt: finishedAt as Date,
        ...(evidence.length === 0 ? {} : { evidence }),
        ...(notes === undefined ? {} : { notes }),
      });
    }
  } catch (error) {
    if (error instanceof DomainError) {
      throw runCorrupted(`${context}: ${error.message}`);
    }
    throw error;
  }

  if (rebuilt.state !== state) {
    throw runCorrupted(
      `${context} records state ${state} with a result the domain would have stored as ` +
        `${rebuilt.state}`,
    );
  }
  return rebuilt;
}

export function runToStored(run: Run): StoredRun {
  return {
    id: run.id,
    projectId: run.projectId,
    projectRevision: run.projectRevision,
    experimentId: run.experimentId,
    experimentDefinitionHash: run.experimentDefinitionHash,
    environment: {
      os: run.environment.os,
      arch: run.environment.arch,
      runtime: run.environment.runtime,
      runtimeVersion: run.environment.runtimeVersion,
      ...(run.environment.lockfileDigest === undefined
        ? {}
        : { lockfileDigest: run.environment.lockfileDigest }),
      ...(run.environment.containerImageDigest === undefined
        ? {}
        : { containerImageDigest: run.environment.containerImageDigest }),
    },
    state: run.state,
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt.toISOString() }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt.toISOString() }),
    evidence: run.evidence.map((item) => ({
      artifactId: item.artifactId,
      sha256: item.sha256,
      mediaType: item.mediaType,
      bytes: item.bytes,
      ...(item.description === undefined ? {} : { description: item.description }),
    })),
    ...(run.notes === undefined ? {} : { notes: run.notes }),
  };
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Report a candidate record that cannot be serialized and read back.
 *
 * A distinct code is used deliberately: `storage_corrupted` describes a document
 * already on disk, and a caller may react to it by discarding that file. Here the
 * stored document is intact and only the new record was refused.
 */
function notStorable(context: string, error: unknown): DomainError {
  const detail =
    error instanceof DomainError
      ? error.message.replace(/^Stored (?:experiment|run) data is invalid: /, '')
      : describeFailure(error);
  return new DomainError(
    'invalid_storage_record',
    `${context} cannot be stored: ${detail}`,
  );
}

/**
 * Validate a candidate experiment through the same path a reader takes.
 *
 * Serializing and re-reading the record proves it would survive `#persist` and a
 * later load unchanged; without this, a caller could write a record that makes the
 * whole document unreadable.
 */
export function assertStorableExperiment(experiment: Experiment): void {
  const context = `experiment '${String(experiment.id)}'`;
  try {
    storedToExperiment(experimentToStored(experiment));
  } catch (error) {
    throw notStorable(context, error);
  }
}

/**
 * Validate a candidate run through the same path a reader takes.
 *
 * The rehydration replays the run's lifecycle, so an impossible state (a
 * completed run without a verdict, a queued run holding evidence, ...) is refused
 * before it can reach the document.
 */
export function assertStorableRun(run: Run): void {
  const context = `run '${String(run.id)}'`;
  try {
    storedToRun(runToStored(run));
  } catch (error) {
    throw notStorable(context, error);
  }
}

function detectVersion(raw: unknown, fail: Fail): number {
  if (isRecord(raw) && typeof raw.schemaVersion === 'number' && Number.isInteger(raw.schemaVersion)) {
    return raw.schemaVersion;
  }
  throw fail('document has no integer schemaVersion');
}

/**
 * Read an experiment document at any supported version.
 *
 * There is no legacy layout for experiments yet, so version 1 is the only
 * accepted shape; anything newer is refused rather than guessed at.
 */
export function migrateExperimentsDocument(raw: unknown): ExperimentsDocumentV1 {
  const version = detectVersion(raw, experimentCorrupted);
  if (version > EXPERIMENT_STORAGE_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `Experiment storage schema version ${version} is newer than this build supports ` +
        `(${EXPERIMENT_STORAGE_SCHEMA_VERSION}); upgrade VOLDBASE to read it`,
    );
  }
  if (version < EXPERIMENT_STORAGE_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `No migration path from experiment storage schema version ${version}`,
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw.experiments)) {
    throw experimentCorrupted('document has no experiments array');
  }
  const experiments = raw.experiments.map((entry, index) =>
    experimentToStored(storedToExperiment(entry, `experiment #${index + 1}`)),
  );
  assertUniqueIds(experiments, (experiment) => experiment.id, 'experiment', experimentCorrupted);
  return {
    schemaVersion: 1,
    experiments,
  };
}

/**
 * Read a run document at any supported version.
 *
 * As with experiments, version 1 is the only accepted shape; a document written
 * by a newer build is refused rather than guessed at.
 */
export function migrateRunsDocument(raw: unknown): RunsDocumentV1 {
  const version = detectVersion(raw, runCorrupted);
  if (version > RUN_STORAGE_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `Run storage schema version ${version} is newer than this build supports ` +
        `(${RUN_STORAGE_SCHEMA_VERSION}); upgrade VOLDBASE to read it`,
    );
  }
  if (version < RUN_STORAGE_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `No migration path from run storage schema version ${version}`,
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw.runs)) {
    throw runCorrupted('document has no runs array');
  }
  const runs = raw.runs.map((entry, index) =>
    runToStored(storedToRun(entry, `run #${index + 1}`)),
  );
  assertUniqueIds(runs, (run) => run.id, 'run', runCorrupted);
  return {
    schemaVersion: 1,
    runs,
  };
}

export function documentToExperiments(raw: unknown): Experiment[] {
  return migrateExperimentsDocument(raw).experiments.map((entry) => storedToExperiment(entry));
}

export function experimentsToDocument(
  experiments: readonly Experiment[],
): ExperimentsDocumentV1 {
  return {
    schemaVersion: 1,
    experiments: experiments.map(experimentToStored),
  };
}

export function documentToRuns(raw: unknown): Run[] {
  return migrateRunsDocument(raw).runs.map((entry) => storedToRun(entry));
}

export function runsToDocument(runs: readonly Run[]): RunsDocumentV1 {
  return {
    schemaVersion: 1,
    runs: runs.map(runToStored),
  };
}
