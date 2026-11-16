/**
 * AnalysisSnapshot — the immutable result of static analysis (Phase 2A).
 *
 * An analysis is a *reading* of an imported project revision, never a claim
 * about how the project behaves at runtime. Everything recorded here is either a
 * syntactic fact taken directly from a parsed source file, or an explicitly
 * classified limit of what could be determined statically.
 *
 * The snapshot is content-addressed: `digest` covers every field except the
 * analysis id and the creation timestamp, so the same revision analysed by the
 * same analyzer version with the same settings always produces the same digest,
 * on any machine. That is what makes an analysis reproducible rather than a
 * point-in-time note.
 *
 * Invariants enforced here (and re-enforced when a stored snapshot is loaded):
 * - `projectRevision` is a real pinned revision, not a ref;
 * - file paths are normalized, unique POSIX paths relative to the project root;
 * - findings and import edges may only name files that were analysed;
 * - severities, certainties, rule ids and versions come from fixed vocabularies.
 */

import { DomainError, invariant } from './errors.ts';
import { asAnalysisId, type AnalysisId, type ProjectId } from './ids.ts';
import { canonicalize, isSha256Hex, sha256Hex } from './integrity.ts';
import { asRevision, type RevisionId } from './revision.ts';

/** Version of the snapshot format. Bump when the shape or meaning changes. */
export const ANALYSIS_SCHEMA_VERSION = 1;

/** Version of the analyzer that produced a snapshot. */
export const ANALYZER_VERSION = '1.0.0';

export const ANALYSIS_LANGUAGES = ['javascript', 'typescript'] as const;
export type AnalysisLanguage = (typeof ANALYSIS_LANGUAGES)[number];

export const DECLARATION_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'enum',
  'type-alias',
  'variable',
  'export',
] as const;
export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

export const IMPORT_KINDS = ['static', 'dynamic', 'require', 'export-from'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/**
 * How an import specifier was classified.
 *
 * Only `resolved-relative` means "this names another analysed file". Everything
 * else says something about our ability to see, not about the import itself:
 * `external` is a package or builtin we deliberately do not resolve (no module
 * resolution, no network), `unresolved-relative` is a relative path that matches
 * no analysed file, and `outside-root` is a relative path that climbs above the
 * project root.
 */
export const IMPORT_RESOLUTIONS = [
  'resolved-relative',
  'unresolved-relative',
  'external',
  'outside-root',
] as const;
export type ImportResolution = (typeof IMPORT_RESOLUTIONS)[number];

export const FINDING_SEVERITIES = ['error', 'warning', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * How sure the analyzer is of a finding.
 *
 * `certain` means the evidence is the parsed syntax itself. `conditional` means
 * the statement depends on something a static reader cannot see (a computed
 * string, a runtime path); it is reported as a limit, never as a verdict.
 */
export const FINDING_CERTAINTIES = ['certain', 'conditional'] as const;
export type FindingCertainty = (typeof FINDING_CERTAINTIES)[number];

export interface SourceLocation {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column, counted in UTF-16 code units. */
  readonly column: number;
}

export interface Declaration {
  readonly kind: DeclarationKind;
  readonly name: string;
  /** True when the declaration carries an `export` modifier. */
  readonly exported: boolean;
  readonly location: SourceLocation;
}

export interface ImportEdge {
  /** The specifier exactly as written, never rewritten or normalized. */
  readonly specifier: string;
  readonly kind: ImportKind;
  /** `import type` / `export type` — erased at runtime. */
  readonly typeOnly: boolean;
  readonly resolution: ImportResolution;
  /** Set only for `resolved-relative`: the analysed file it names. */
  readonly resolvedPath?: string;
  readonly location: SourceLocation;
}

export interface AnalyzedFile {
  /** POSIX path relative to the project root. */
  readonly path: string;
  readonly language: AnalysisLanguage;
  readonly size: number;
  /** SHA-256 of the exact bytes that were parsed. */
  readonly digest: string;
  readonly declarations: readonly Declaration[];
  readonly imports: readonly ImportEdge[];
}

export interface Finding {
  /** Stable rule id, `VBnnn`. */
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly certainty: FindingCertainty;
  readonly path: string;
  /** Absent when the finding is about a whole file (e.g. a parse failure). */
  readonly location?: SourceLocation;
  /** One sentence, describing the observation — not a verdict about the code. */
  readonly message: string;
  /** The syntax that produced the finding, quoted for the reader. */
  readonly evidence: string;
}

/** The analysis settings that participate in the digest. */
export interface AnalysisSettings {
  readonly supportedExtensions: readonly string[];
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
  readonly maxSourceFiles: number;
}

export interface AnalysisSummary {
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly declarationCount: number;
  readonly importCount: number;
  readonly resolvedImportCount: number;
  readonly findingCount: number;
  readonly findingsBySeverity: Readonly<Record<FindingSeverity, number>>;
  readonly languages: readonly AnalysisLanguage[];
}

/** Everything the digest covers. */
export interface AnalysisContent {
  readonly schemaVersion: number;
  readonly analyzerVersion: string;
  readonly projectId: ProjectId;
  readonly projectRevision: RevisionId;
  readonly settings: AnalysisSettings;
  readonly files: readonly AnalyzedFile[];
  readonly findings: readonly Finding[];
  readonly summary: AnalysisSummary;
}

export interface AnalysisSnapshot extends AnalysisContent {
  readonly analysisId: AnalysisId;
  readonly createdAt: Date;
  /** SHA-256 of the canonicalized content (everything except id and timestamp). */
  readonly digest: string;
}

export interface CreateAnalysisSnapshotInput {
  analysisId: AnalysisId | string;
  projectId: ProjectId | string;
  projectRevision: string;
  analyzerVersion: string;
  schemaVersion: number;
  settings: AnalysisSettings;
  files: readonly AnalyzedFile[];
  findings: readonly Finding[];
  createdAt?: Date;
}

const RULE_ID_PATTERN = /^VB\d{3}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A POSIX path relative to the project root: no absolute paths, no Windows
 * separators, no `.`/`..` segments and no empty segments.
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\\')) {
    return false;
  }
  if (value.startsWith('/')) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareLocations(left: SourceLocation | undefined, right: SourceLocation | undefined): number {
  const leftLine = left?.line ?? 0;
  const rightLine = right?.line ?? 0;
  if (leftLine !== rightLine) return leftLine - rightLine;
  const leftColumn = left?.column ?? 0;
  const rightColumn = right?.column ?? 0;
  return leftColumn - rightColumn;
}

function compareDeclarations(left: Declaration, right: Declaration): number {
  return (
    compareLocations(left.location, right.location) ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(left.name, right.name)
  );
}

function compareImports(left: ImportEdge, right: ImportEdge): number {
  return compareLocations(left.location, right.location) || compareStrings(left.specifier, right.specifier);
}

function compareFindings(left: Finding, right: Finding): number {
  return (
    compareStrings(left.ruleId, right.ruleId) ||
    compareStrings(left.path, right.path) ||
    compareLocations(left.location, right.location) ||
    compareStrings(left.message, right.message)
  );
}

/**
 * Canonical ordering of an analysis.
 *
 * Ordering is part of the contract, not an implementation detail: the digest is
 * only reproducible if two analyzers that saw the same code agree on the order,
 * and a stored snapshot must not depend on directory iteration order.
 */
export function normalizeAnalysisContent(
  content: Omit<AnalysisContent, 'summary'>,
): Omit<AnalysisContent, 'summary'> {
  const files = content.files
    .map((file) => ({
      ...file,
      declarations: [...file.declarations].sort(compareDeclarations),
      imports: [...file.imports].sort(compareImports),
    }))
    .sort((left, right) => compareStrings(left.path, right.path));
  return {
    schemaVersion: content.schemaVersion,
    analyzerVersion: content.analyzerVersion,
    projectId: content.projectId,
    projectRevision: content.projectRevision,
    settings: {
      ...content.settings,
      supportedExtensions: [...content.settings.supportedExtensions].sort(compareStrings),
    },
    files,
    findings: [...content.findings].sort(compareFindings),
  };
}

export function summarizeAnalysis(
  files: readonly AnalyzedFile[],
  findings: readonly Finding[],
): AnalysisSummary {
  const languages = new Set<AnalysisLanguage>();
  let declarationCount = 0;
  let importCount = 0;
  let resolvedImportCount = 0;
  for (const file of files) {
    languages.add(file.language);
    declarationCount += file.declarations.length;
    importCount += file.imports.length;
    resolvedImportCount += file.imports.filter(
      (edge) => edge.resolution === 'resolved-relative',
    ).length;
  }

  const findingsBySeverity: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    findingsBySeverity[finding.severity] += 1;
  }

  return {
    fileCount: files.length,
    sourceFileCount: files.length,
    declarationCount,
    importCount,
    resolvedImportCount,
    findingCount: findings.length,
    findingsBySeverity,
    languages: [...languages].sort(compareStrings),
  };
}

/** Digest of the analysis content: canonical JSON, SHA-256. */
export function analysisContentDigest(content: AnalysisContent): string {
  return sha256Hex(canonicalize(content));
}

function checkLocation(location: SourceLocation, context: string): void {
  invariant(
    isRecord(location) &&
      Number.isInteger(location.line) &&
      Number.isInteger(location.column) &&
      (location.line as number) >= 1 &&
      (location.column as number) >= 1,
    'invalid_analysis_snapshot',
    `${context} must have a positive 1-based line and column`,
  );
}

function checkDeclaration(declaration: Declaration, context: string): void {
  invariant(
    isRecord(declaration) && DECLARATION_KINDS.includes(declaration.kind),
    'invalid_analysis_snapshot',
    `${context} has an unknown declaration kind`,
  );
  invariant(
    typeof declaration.name === 'string' && declaration.name !== '',
    'invalid_analysis_snapshot',
    `${context} must have a non-empty name`,
  );
  invariant(
    typeof declaration.exported === 'boolean',
    'invalid_analysis_snapshot',
    `${context} must record whether it is exported`,
  );
  checkLocation(declaration.location, `${context} location`);
}

function checkImport(edge: ImportEdge, context: string): void {
  invariant(
    isRecord(edge) && IMPORT_KINDS.includes(edge.kind),
    'invalid_analysis_snapshot',
    `${context} has an unknown import kind`,
  );
  invariant(
    IMPORT_RESOLUTIONS.includes(edge.resolution),
    'invalid_analysis_snapshot',
    `${context} has an unknown resolution`,
  );
  invariant(
    typeof edge.specifier === 'string' && edge.specifier !== '',
    'invalid_analysis_snapshot',
    `${context} must keep the original specifier`,
  );
  invariant(
    typeof edge.typeOnly === 'boolean',
    'invalid_analysis_snapshot',
    `${context} must record whether it is type-only`,
  );
  checkLocation(edge.location, `${context} location`);
  if (edge.resolution === 'resolved-relative') {
    invariant(
      isSafeRelativePath(edge.resolvedPath),
      'invalid_analysis_snapshot',
      `${context} resolved without naming a relative path`,
    );
  } else {
    invariant(
      edge.resolvedPath === undefined,
      'invalid_analysis_snapshot',
      `${context} must not claim a resolved path when it is not resolved`,
    );
  }
}

function checkFinding(finding: Finding, paths: ReadonlySet<string>): void {
  invariant(
    isRecord(finding) && typeof finding.ruleId === 'string' && RULE_ID_PATTERN.test(finding.ruleId),
    'invalid_analysis_snapshot',
    'A finding must carry a stable VBnnn rule id',
  );
  invariant(
    FINDING_SEVERITIES.includes(finding.severity),
    'invalid_analysis_snapshot',
    `Finding ${finding.ruleId} has an unknown severity`,
  );
  invariant(
    FINDING_CERTAINTIES.includes(finding.certainty),
    'invalid_analysis_snapshot',
    `Finding ${finding.ruleId} has an unknown certainty`,
  );
  invariant(
    paths.has(finding.path),
    'invalid_analysis_snapshot',
    `Finding ${finding.ruleId} refers to ${String(finding.path)}, which was not analysed`,
  );
  if (finding.location !== undefined) {
    checkLocation(finding.location, `Finding ${finding.ruleId} location`);
  }
  invariant(
    typeof finding.message === 'string' && finding.message.trim() !== '',
    'invalid_analysis_snapshot',
    `Finding ${finding.ruleId} has no explanation`,
  );
  invariant(
    typeof finding.evidence === 'string',
    'invalid_analysis_snapshot',
    `Finding ${finding.ruleId} has no evidence`,
  );
}

/**
 * Build a validated snapshot.
 *
 * Content is normalized first, so callers cannot make the digest depend on
 * insertion order, and the summary is always recomputed from the files and
 * findings rather than trusted.
 */
export function createAnalysisSnapshot(input: CreateAnalysisSnapshotInput): AnalysisSnapshot {
  const analysisId = asAnalysisId(String(input.analysisId));
  invariant(
    typeof input.projectId === 'string' && input.projectId.trim() !== '',
    'invalid_analysis_snapshot',
    'An analysis needs the project id it belongs to',
  );
  const projectRevision = asRevision(input.projectRevision);
  invariant(
    typeof input.analyzerVersion === 'string' && VERSION_PATTERN.test(input.analyzerVersion),
    'invalid_analysis_snapshot',
    `Analyzer version must look like 1.2.3, received '${String(input.analyzerVersion)}'`,
  );
  invariant(
    input.schemaVersion === ANALYSIS_SCHEMA_VERSION,
    'analysis_unsupported_schema',
    `Analysis schema version ${String(input.schemaVersion)} is not supported by this build ` +
      `(${ANALYSIS_SCHEMA_VERSION})`,
  );
  invariant(
    isRecord(input.settings) &&
      Array.isArray(input.settings.supportedExtensions) &&
      input.settings.supportedExtensions.every((item: unknown) => typeof item === 'string'),
    'invalid_analysis_snapshot',
    'Analysis settings must list the supported extensions',
  );
  invariant(
    Array.isArray(input.files),
    'invalid_analysis_snapshot',
    'An analysis must record its files',
  );
  invariant(
    Array.isArray(input.findings),
    'invalid_analysis_snapshot',
    'An analysis must record its findings (possibly an empty list)',
  );

  const seenPaths = new Set<string>();
  for (const file of input.files) {
    invariant(
      isSafeRelativePath(file.path),
      'invalid_analysis_snapshot',
      `Analysed file path '${String((file as { path?: unknown } | null)?.path)}' must be a ` +
        'normalized path relative to the project root',
    );
    invariant(
      !seenPaths.has(file.path),
      'invalid_analysis_snapshot',
      `File ${file.path} is recorded twice`,
    );
    seenPaths.add(file.path);
    invariant(
      ANALYSIS_LANGUAGES.includes(file.language),
      'invalid_analysis_snapshot',
      `File ${file.path} has an unknown language`,
    );
    invariant(
      Number.isInteger(file.size) && file.size >= 0,
      'invalid_analysis_snapshot',
      `File ${file.path} has an invalid size`,
    );
    invariant(
      isSha256Hex(file.digest),
      'invalid_analysis_snapshot',
      `File ${file.path} must record the SHA-256 of the bytes that were parsed`,
    );
    invariant(
      Array.isArray(file.declarations) && Array.isArray(file.imports),
      'invalid_analysis_snapshot',
      `File ${file.path} must record declaration and import lists`,
    );
    file.declarations.forEach((declaration: Declaration, index: number) =>
      checkDeclaration(declaration, `${file.path} declaration #${index + 1}`),
    );
    file.imports.forEach((edge: ImportEdge, index: number) =>
      checkImport(edge, `${file.path} import #${index + 1}`),
    );
  }

  for (const file of input.files) {
    for (const edge of file.imports) {
      if (edge.resolvedPath !== undefined) {
        invariant(
          seenPaths.has(edge.resolvedPath),
          'invalid_analysis_snapshot',
          `${file.path} claims to resolve '${edge.specifier}' to ${edge.resolvedPath}, ` +
            'which was not analysed',
        );
      }
    }
  }

  input.findings.forEach((finding) => checkFinding(finding, seenPaths));

  const normalized = normalizeAnalysisContent({
    schemaVersion: input.schemaVersion,
    analyzerVersion: input.analyzerVersion,
    projectId: input.projectId as ProjectId,
    projectRevision,
    settings: {
      supportedExtensions: [...input.settings.supportedExtensions],
      maxFiles: input.settings.maxFiles,
      maxTotalBytes: input.settings.maxTotalBytes,
      maxFileBytes: input.settings.maxFileBytes,
      maxSourceFiles: input.settings.maxSourceFiles,
    },
    files: input.files,
    findings: input.findings,
  });

  const content: AnalysisContent = {
    ...normalized,
    summary: summarizeAnalysis(normalized.files, normalized.findings),
  };

  const createdAt = input.createdAt ?? new Date();
  invariant(
    createdAt instanceof Date && !Number.isNaN(createdAt.getTime()),
    'invalid_analysis_snapshot',
    'An analysis must have a valid creation timestamp',
  );

  return {
    ...content,
    analysisId,
    createdAt: new Date(createdAt.getTime()),
    digest: analysisContentDigest(content),
  };
}

/**
 * Deep copy of a snapshot.
 *
 * `readonly` is a compile-time promise: a repository that stored the caller's
 * object graph would hand back something a caller could still mutate, and an
 * analysis digest that can drift by aliasing is not an integrity guarantee.
 */
export function cloneAnalysisSnapshot(snapshot: AnalysisSnapshot): AnalysisSnapshot {
  return {
    schemaVersion: snapshot.schemaVersion,
    analyzerVersion: snapshot.analyzerVersion,
    analysisId: snapshot.analysisId,
    projectId: snapshot.projectId,
    projectRevision: snapshot.projectRevision,
    settings: {
      ...snapshot.settings,
      supportedExtensions: [...snapshot.settings.supportedExtensions],
    },
    createdAt: new Date(snapshot.createdAt.getTime()),
    digest: snapshot.digest,
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
    summary: {
      ...snapshot.summary,
      findingsBySeverity: { ...snapshot.summary.findingsBySeverity },
      languages: [...snapshot.summary.languages],
    },
  };
}

/**
 * Recompute the digest and compare.
 *
 * A stored snapshot whose content no longer matches its digest was edited or
 * corrupted; it is refused instead of being returned as if it were evidence.
 */
export function assertAnalysisDigest(snapshot: AnalysisSnapshot): void {
  const { analysisId: _analysisId, createdAt: _createdAt, digest, ...content } = snapshot;
  const expected = analysisContentDigest(content as AnalysisContent);
  if (expected !== digest) {
    throw new DomainError(
      'analysis_corrupted',
      `Analysis ${snapshot.analysisId} does not match its recorded digest ` +
        `(${digest}); the stored analysis was modified or corrupted`,
    );
  }
}

/** One-line label used by the CLI and by reports. */
export function describeAnalysisFinding(finding: Finding): string {
  const where =
    finding.location === undefined
      ? finding.path
      : `${finding.path}:${finding.location.line}:${finding.location.column}`;
  return `${finding.severity.toUpperCase()} ${finding.ruleId} ${where} ${finding.message}`;
}
