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
  DetectedManifest,
  ExecutionOutcome,
  ExecutionRequest,
  Executor,
  ExperimentRepository,
  IdGenerator,
  ProjectRepository,
  ProjectScan,
  ProjectScanner,
  RunRepository,
} from './application/ports.ts';
export {
  ProjectImportService,
  type ImportProjectCommand,
  type ImportProjectResult,
  type ProjectImportDeps,
} from './application/project-import-service.ts';
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
export {
  DEFAULT_SCANNER_LIMITS,
  EXCLUDED_DIRECTORY_NAMES,
  LocalProjectScanner,
  MANIFEST_ECOSYSTEMS,
  snapshotDigest,
  type ScannerHooks,
  type ScannerLimits,
} from './infrastructure/fs/scanner.ts';
export {
  acquireFileLock,
  releaseLock,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STALE_LOCK_MS,
  type LockHandle,
  type LockOptions,
} from './infrastructure/fs/file-lock.ts';
export {
  JsonProjectRepository,
  type JsonProjectRepositoryOptions,
} from './infrastructure/fs/json-project-repository.ts';
export {
  HOME_ENV_VAR,
  projectStorageFilePath,
  resolveVoldbaseHome,
} from './infrastructure/fs/paths.ts';
export {
  documentToProjects,
  migrateStorageDocument,
  projectToStored,
  projectsToDocument,
  STORAGE_FILE_NAME,
  STORAGE_MIGRATIONS,
  STORAGE_SCHEMA_VERSION,
  storedToProject,
  type StorageDocumentV1,
  type StorageMigration,
  type StoredProject,
} from './infrastructure/fs/storage-schema.ts';
export { RandomIdGenerator, SystemClock } from './infrastructure/ids.ts';
