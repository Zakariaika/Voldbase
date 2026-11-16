/**
 * Shared fixtures for the Phase 2B architecture tests.
 *
 * Everything here is in-memory: an `AnalysisSnapshot` is built directly, exactly
 * as Phase 2A would have stored it, so the architecture tests never touch a
 * filesystem. That is deliberate — the engine is supposed to work from the
 * analysis alone, and a test that needed real files could not prove it.
 */

import {
  buildArchitecture,
  createAnalysisSnapshot,
  sha256Hex,
  type AnalysisSnapshot,
  type AnalyzedFile,
  type ArchitectureSnapshot,
  type BuildArchitectureOptions,
  type ImportEdge,
  type ImportKind,
} from '../../src/index.ts';

/** A valid pinned project revision for fixtures. */
export const PROJECT_REVISION = sha256Hex('architecture-fixture-revision');

export interface ImportSpec {
  /** Target file path for a resolved relative import. */
  readonly to?: string;
  /** Explicit specifier; defaults to `./<basename of to>` or `pkg`. */
  readonly specifier?: string;
  readonly kind?: ImportKind;
  readonly typeOnly?: boolean;
  /** Force a classification for fixtures that must not become edges. */
  readonly resolution?: 'external' | 'unresolved-relative' | 'outside-root';
}

function defaultSpecifier(target: string): string {
  const base = target.slice(target.lastIndexOf('/') + 1);
  return `./${base.replace(/\.[a-z]+$/, '')}`;
}

function languageOf(filePath: string): AnalyzedFile['language'] {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) ? 'typescript' : 'javascript';
}

/** One analysed file with its import edges, as Phase 2A would record them. */
export function analyzedFile(filePath: string, specs: readonly ImportSpec[] = []): AnalyzedFile {
  const imports: ImportEdge[] = specs.map((spec, index) => {
    const resolution =
      spec.resolution ?? (spec.to === undefined ? 'external' : 'resolved-relative');
    const specifier = spec.specifier ?? (spec.to === undefined ? 'pkg' : defaultSpecifier(spec.to));
    return {
      specifier,
      kind: spec.kind ?? 'static',
      typeOnly: spec.typeOnly ?? false,
      resolution,
      ...(resolution === 'resolved-relative' ? { resolvedPath: spec.to as string } : {}),
      location: { line: index + 1, column: 1 },
    };
  });

  return {
    path: filePath,
    language: languageOf(filePath),
    size: filePath.length,
    digest: sha256Hex(filePath),
    declarations: [],
    imports,
  };
}

export function analysisWith(
  files: readonly AnalyzedFile[],
  analysisId = 'ana-1',
): AnalysisSnapshot {
  return createAnalysisSnapshot({
    analysisId,
    projectId: 'proj-1',
    projectRevision: PROJECT_REVISION,
    analyzerVersion: '1.0.0',
    schemaVersion: 1,
    settings: {
      supportedExtensions: ['.js', '.ts'],
      maxFiles: 20_000,
      maxTotalBytes: 256 * 1024 * 1024,
      maxFileBytes: 8 * 1024 * 1024,
      maxSourceFiles: 5_000,
    },
    files,
    findings: [],
  });
}

/** `{ 'src/a.ts': [{ to: 'src/b.ts' }] }` — paths are the keys. */
export interface GraphSpec {
  readonly [filePath: string]: readonly ImportSpec[];
}

export function filesFromSpec(spec: GraphSpec): AnalyzedFile[] {
  return Object.keys(spec)
    .sort()
    .map((filePath) => analyzedFile(filePath, spec[filePath] ?? []));
}

export function analysisFromSpec(spec: GraphSpec, analysisId = 'ana-1'): AnalysisSnapshot {
  return analysisWith(filesFromSpec(spec), analysisId);
}

export function architectureFromSpec(
  spec: GraphSpec,
  options: BuildArchitectureOptions = {},
): ArchitectureSnapshot {
  return buildArchitecture(analysisFromSpec(spec), options);
}

export function nodeByPath(snapshot: ArchitectureSnapshot, filePath: string) {
  const node = snapshot.nodes.find((candidate) => candidate.path === filePath);
  if (node === undefined) {
    throw new Error(`no node ${filePath}; saw ${snapshot.nodes.map((n) => n.path).join(', ')}`);
  }
  return node;
}

export function moduleById(snapshot: ArchitectureSnapshot, moduleId: string) {
  const module = snapshot.modules.find((candidate) => candidate.id === moduleId);
  if (module === undefined) {
    throw new Error(`no module ${moduleId}; saw ${snapshot.modules.map((m) => m.id).join(', ')}`);
  }
  return module;
}

export function findingsFor(snapshot: ArchitectureSnapshot, ruleId: string) {
  return snapshot.findings.filter((finding) => finding.ruleId === ruleId);
}
