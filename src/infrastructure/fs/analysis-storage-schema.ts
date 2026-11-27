/**
 * Versioned on-disk representation of analyses (Phase 2A).
 *
 * Separate from the project store: analyses are derived, append-only records and
 * a corrupted analysis file must never be able to damage or block project data.
 * Everything read from disk is rebuilt through `createAnalysisSnapshot`, so a
 * hand-edited file cannot smuggle an invalid path, rule id or severity into the
 * application — and the recorded digest is re-computed and compared, so a
 * silently edited analysis is refused rather than displayed as evidence.
 */

import {
  ANALYSIS_SCHEMA_VERSION,
  createAnalysisSnapshot,
  type AnalysisSnapshot,
  type AnalyzedFile,
  type Finding,
} from '../../domain/analysis.ts';
import { DomainError } from '../../domain/errors.ts';

/** Schema version written by this build. Bump when the document shape changes. */
export const ANALYSES_STORAGE_SCHEMA_VERSION = 1;

/** File name of the analysis store inside the VOLDBASE home directory. */
export const ANALYSES_FILE_NAME = 'analyses.json';

export interface StoredAnalysis {
  readonly analysisId: string;
  readonly projectId: string;
  readonly projectRevision: string;
  readonly analyzerVersion: string;
  readonly schemaVersion: number;
  readonly digest: string;
  readonly createdAt: string;
  readonly settings: AnalysisSnapshot['settings'];
  readonly files: readonly AnalyzedFile[];
  readonly findings: readonly Finding[];
}

export interface AnalysesDocumentV1 {
  readonly schemaVersion: 1;
  readonly analyses: readonly StoredAnalysis[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function corrupted(detail: string): DomainError {
  return new DomainError('analysis_corrupted', `Stored analysis data is invalid: ${detail}`);
}

/**
 * Rebuild a snapshot from its stored form.
 *
 * The domain constructor validates every field; the digest comparison then proves
 * the content is byte-for-byte what was originally recorded.
 */
export function storedToAnalysis(value: unknown, context = 'analysis'): AnalysisSnapshot {
  if (!isRecord(value)) {
    throw corrupted(`${context} is not an object`);
  }
  const { analysisId, projectId, projectRevision, analyzerVersion, schemaVersion, digest } = value;
  const { createdAt } = value;
  if (typeof analysisId !== 'string' || analysisId.trim() === '') {
    throw corrupted(`${context} has no analysisId`);
  }
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw corrupted(`${context} has no projectId`);
  }
  if (typeof projectRevision !== 'string') {
    throw corrupted(`${context} has no projectRevision`);
  }
  if (typeof analyzerVersion !== 'string') {
    throw corrupted(`${context} has no analyzerVersion`);
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw corrupted(`${context} has no integer schemaVersion`);
  }
  if (schemaVersion > ANALYSIS_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `${context}: Analysis schema version ${schemaVersion} is newer than this build supports ` +
        `(${ANALYSIS_SCHEMA_VERSION}); upgrade VOLDBASE to read it`,
    );
  }
  if (typeof digest !== 'string') {
    throw corrupted(`${context} has no digest`);
  }
  if (typeof createdAt !== 'string') {
    throw corrupted(`${context} has no createdAt`);
  }
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    throw corrupted(`${context} has an invalid createdAt`);
  }
  if (!isRecord(value.settings) || !Array.isArray(value.files) || !Array.isArray(value.findings)) {
    throw corrupted(`${context} is missing settings, files or findings`);
  }
  // Validate the container shape here so the domain constructor only ever sees
  // objects: a null entry must be reported as corruption, not as a TypeError.
  value.files.forEach((file: unknown, index: number) => {
    if (!isRecord(file)) {
      throw corrupted(`${context} file #${index + 1} is not an object`);
    }
    if (!Array.isArray(file.declarations) || !Array.isArray(file.imports)) {
      throw corrupted(`${context} file #${index + 1} has no declaration or import list`);
    }
  });
  value.findings.forEach((finding: unknown, index: number) => {
    if (!isRecord(finding)) {
      throw corrupted(`${context} finding #${index + 1} is not an object`);
    }
  });

  let snapshot: AnalysisSnapshot;
  try {
    snapshot = createAnalysisSnapshot({
      analysisId,
      projectId,
      projectRevision,
      analyzerVersion,
      schemaVersion,
      settings: value.settings as unknown as AnalysisSnapshot['settings'],
      files: value.files as AnalyzedFile[],
      findings: value.findings as Finding[],
      createdAt: created,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw new DomainError('analysis_corrupted', `${context}: ${error.message}`);
    }
    throw error;
  }

  if (snapshot.digest !== digest) {
    throw new DomainError(
      'analysis_corrupted',
      `${context} does not match its recorded digest; the stored analysis was modified or ` +
        'corrupted. Re-run `voldbase analyze` to produce a fresh one.',
    );
  }
  return snapshot;
}

export function analysisToStored(snapshot: AnalysisSnapshot): StoredAnalysis {
  return {
    analysisId: snapshot.analysisId,
    projectId: snapshot.projectId,
    projectRevision: snapshot.projectRevision,
    analyzerVersion: snapshot.analyzerVersion,
    schemaVersion: snapshot.schemaVersion,
    digest: snapshot.digest,
    createdAt: snapshot.createdAt.toISOString(),
    settings: {
      ...snapshot.settings,
      supportedExtensions: [...snapshot.settings.supportedExtensions],
    },
    files: snapshot.files.map((file) => ({
      ...file,
      declarations: file.declarations.map((declaration) => ({
        ...declaration,
        location: { ...declaration.location },
      })),
      imports: file.imports.map((edge) => ({
        ...edge,
        location: { ...edge.location },
        ...(edge.resolvedPath === undefined ? {} : { resolvedPath: edge.resolvedPath }),
      })),
    })),
    findings: snapshot.findings.map((finding) => ({
      ...finding,
      ...(finding.location === undefined ? {} : { location: { ...finding.location } }),
    })),
  };
}

function detectVersion(raw: unknown): number {
  if (isRecord(raw) && typeof raw.schemaVersion === 'number' && Number.isInteger(raw.schemaVersion)) {
    return raw.schemaVersion;
  }
  throw corrupted('document has no integer schemaVersion');
}

/**
 * Read a document at any supported version.
 *
 * There is no legacy layout for analyses yet, so version 1 is the only accepted
 * shape; anything newer is refused rather than guessed at.
 */
export function migrateAnalysesDocument(raw: unknown): AnalysesDocumentV1 {
  const version = detectVersion(raw);
  if (version > ANALYSES_STORAGE_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `Analysis storage schema version ${version} is newer than this build supports ` +
        `(${ANALYSES_STORAGE_SCHEMA_VERSION}); upgrade VOLDBASE to read it`,
    );
  }
  if (version < ANALYSES_STORAGE_SCHEMA_VERSION) {
    throw new DomainError(
      'storage_unsupported_schema',
      `No migration path from analysis storage schema version ${version}`,
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw.analyses)) {
    throw corrupted('document has no analyses array');
  }
  return {
    schemaVersion: 1,
    analyses: raw.analyses.map((entry, index) =>
      analysisToStored(storedToAnalysis(entry, `analysis #${index + 1}`)),
    ),
  };
}

export function documentToAnalyses(raw: unknown): AnalysisSnapshot[] {
  return migrateAnalysesDocument(raw).analyses.map((entry) => storedToAnalysis(entry));
}

export function analysesToDocument(analyses: readonly AnalysisSnapshot[]): AnalysesDocumentV1 {
  return {
    schemaVersion: 1,
    analyses: analyses.map(analysisToStored),
  };
}
