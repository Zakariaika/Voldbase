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
  asAnalysisId,
  asArtifactId,
  asExperimentId,
  asProjectId,
  asRunId,
  type AnalysisId,
  type ArtifactId,
  type ExperimentId,
  type ProjectId,
  type RunId,
} from './domain/ids.ts';
export {
  ANALYSIS_LANGUAGES,
  ANALYSIS_SCHEMA_VERSION,
  ANALYZER_VERSION,
  analysisContentDigest,
  assertAnalysisDigest,
  cloneAnalysisSnapshot,
  createAnalysisSnapshot,
  DECLARATION_KINDS,
  describeAnalysisFinding,
  FINDING_CERTAINTIES,
  FINDING_SEVERITIES,
  IMPORT_KINDS,
  IMPORT_RESOLUTIONS,
  isSafeRelativePath,
  normalizeAnalysisContent,
  summarizeAnalysis,
  type AnalysisContent,
  type AnalysisLanguage,
  type AnalysisSettings,
  type AnalysisSnapshot,
  type AnalysisSummary,
  type AnalyzedFile,
  type CreateAnalysisSnapshotInput,
  type Declaration,
  type DeclarationKind,
  type Finding,
  type FindingCertainty,
  type FindingSeverity,
  type ImportEdge,
  type ImportKind,
  type ImportResolution,
  type SourceLocation,
} from './domain/analysis.ts';
export {
  ARCHITECTURE_ENGINE_VERSION,
  ARCHITECTURE_RULES,
  ARCHITECTURE_SCHEMA_VERSION,
  architectureContentDigest,
  assertArchitectureDigest,
  cloneArchitectureSnapshot,
  computeArchitectureMetrics,
  createArchitectureSnapshot,
  DEFAULT_ARCHITECTURE_LIMITS,
  DEFAULT_ARCHITECTURE_THRESHOLDS,
  describeArchitectureFinding,
  isArchitectureModuleId,
  normalizeArchitectureContent,
  ROOT_MODULE_ID,
  summarizeArchitecture,
  type ArchitectureContent,
  type ArchitectureCycle,
  type ArchitectureEdge,
  type ArchitectureEdgeRef,
  type ArchitectureFinding,
  type ArchitectureLimits,
  type ArchitectureMetrics,
  type ArchitectureModule,
  type ArchitectureNode,
  type ArchitectureSnapshot,
  type ArchitectureSummary,
  type ArchitectureThresholds,
  type CreateArchitectureSnapshotInput,
} from './domain/architecture.ts';
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
  assertExperimentRevisionIntegrity,
  cloneExperiment,
  createExperiment,
  experimentDefinitionHash,
  reviseExperiment,
  type Determinism,
  type Experiment,
  type ExperimentDefinitionChanges,
  type ExperimentStep,
} from './domain/experiment.ts';
export {
  cancelRun,
  cloneRun,
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
  AnalysisLimits,
  AnalysisRepository,
  AnalyzerResult,
  ArtifactStore,
  Clock,
  DetectedManifest,
  ExecutionOutcome,
  ExecutionRequest,
  Executor,
  ExperimentRepository,
  IdGenerator,
  ProjectAnalyzer,
  ProjectRepository,
  ProjectScan,
  ProjectScanner,
  RunRepository,
} from './application/ports.ts';
export {
  buildArchitecture,
  findCycleComponents,
  moduleIdForPath,
  type BuildArchitectureOptions,
} from './application/architecture-builder.ts';
export {
  ArchitectureService,
  type ArchitectureServiceDeps,
  type BuildArchitectureCommand,
  type BuildArchitectureResult,
} from './application/architecture-service.ts';
export {
  ProjectAnalysisService,
  type AnalyzeProjectCommand,
  type AnalyzeProjectResult,
  type ProjectAnalysisDeps,
} from './application/analyze-project-service.ts';
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
  InMemoryAnalysisRepository,
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
  type LockHooks,
  type LockOptions,
} from './infrastructure/fs/file-lock.ts';
export {
  JsonProjectRepository,
  type JsonProjectRepositoryOptions,
} from './infrastructure/fs/json-project-repository.ts';
export {
  collectProjectTree,
  type CollectedTree,
  type TreeLimits,
} from './infrastructure/fs/project-tree.ts';
export {
  assertEntryUnchanged,
  readVerifiedBytes,
  type ChangedCode,
  type ReadHooks,
  type ReadLimits,
} from './infrastructure/fs/safe-read.ts';
export {
  ANALYSIS_RULES as STATIC_ANALYSIS_RULES,
  DEFAULT_ANALYSIS_LIMITS,
  isSupportedSourcePath,
  resolveImportSpecifier,
  TypeScriptStaticAnalyzer,
  type StaticAnalyzerOptions,
} from './infrastructure/fs/typescript-analyzer.ts';
export {
  analysesToDocument,
  analysisToStored,
  ANALYSES_FILE_NAME,
  ANALYSES_STORAGE_SCHEMA_VERSION,
  documentToAnalyses,
  migrateAnalysesDocument,
  storedToAnalysis,
  type AnalysesDocumentV1,
  type StoredAnalysis,
} from './infrastructure/fs/analysis-storage-schema.ts';
export {
  JsonAnalysisRepository,
  type JsonAnalysisRepositoryOptions,
} from './infrastructure/fs/json-analysis-repository.ts';
export {
  documentToExperiments,
  documentToRuns,
  experimentToStored,
  experimentsToDocument,
  EXPERIMENTS_FILE_NAME,
  EXPERIMENT_STORAGE_SCHEMA_VERSION,
  migrateExperimentsDocument,
  migrateRunsDocument,
  runToStored,
  runsToDocument,
  RUNS_FILE_NAME,
  RUN_STORAGE_SCHEMA_VERSION,
  storedToExperiment,
  storedToRun,
  type ExperimentsDocumentV1,
  type RunsDocumentV1,
  type StoredExperiment,
  type StoredExperimentStep,
  type StoredRun,
} from './infrastructure/fs/experiment-run-storage-schema.ts';
export {
  JsonExperimentRepository,
  type JsonExperimentRepositoryOptions,
} from './infrastructure/fs/json-experiment-repository.ts';
export {
  JsonRunRepository,
  type JsonRunRepositoryOptions,
} from './infrastructure/fs/json-run-repository.ts';
export {
  analysisStorageFilePath,
  experimentStorageFilePath,
  HOME_ENV_VAR,
  projectStorageFilePath,
  resolveVoldbaseHome,
  runStorageFilePath,
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
