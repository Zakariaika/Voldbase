/**
 * Public module surface.
 *
 * Only what a consumer (CLI, future server) is meant to use is exported here.
 * Infrastructure adapters are exported deliberately for Phase 0 so tests and
 * the upcoming CLI can share them; they will move behind a composition root in
 * Phase 1.
 */

export { DomainError, invariant } from './domain/errors.ts';
export {
  asArtifactId,
  asExperimentId,
  asProjectId,
  asRunId,
  type ArtifactId,
  type ExperimentId,
  type ProjectId,
  type RunId,
} from './domain/ids.ts';
export {
  RESULT_STATUSES,
  RESULT_STATUS_DESCRIPTIONS,
  isResultStatus,
  requiresEvidence,
  type ResultStatus,
} from './domain/result.ts';
export { canonicalize, contentHash, isSha256Hex, sha256Hex } from './domain/integrity.ts';
export { createEvidenceRef, type EvidenceRef } from './domain/evidence.ts';
export {
  assertProjectSnapshotCompatible,
  cloneProject,
  createProject,
  type DependencySnapshot,
  type Project,
  type ProjectSource,
  type ProjectSourceKind,
} from './domain/project.ts';
export {
  createExperiment,
  experimentDefinitionHash,
  type Determinism,
  type Experiment,
  type ExperimentStep,
} from './domain/experiment.ts';
export {
  cancelRun,
  completeRun,
  createRun,
  isTerminal,
  startRun,
  type EnvironmentManifest,
  type Run,
  type RunState,
} from './domain/run.ts';
export {
  asRevision,
  isFloatingRevision,
  isRevision,
  revisionKind,
  type RevisionId,
  type RevisionKind,
} from './domain/revision.ts';
export type {
  ArtifactStore,
  Clock,
  ExecutionOutcome,
  ExecutionRequest,
  Executor,
  ExperimentRepository,
  IdGenerator,
  ProjectRepository,
  RunRepository,
} from './application/ports.ts';
export {
  RunService,
  type CreateRunCommand,
  type RecordOutcomeCommand,
  type RunServiceDeps,
} from './application/run-service.ts';
export {
  FixedClock,
  InMemoryExperimentRepository,
  InMemoryProjectRepository,
  InMemoryRunRepository,
  SequentialIdGenerator,
} from './infrastructure/memory/in-memory.ts';
