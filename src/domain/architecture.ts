/**
 * ArchitectureSnapshot — the immutable architectural model derived from one
 * AnalysisSnapshot (Phase 2B).
 *
 * This module is pure: it knows nothing about files, the parser, the graph
 * algorithms or the CLI. It defines what a valid architecture model *is*, how it
 * is canonically ordered, and how it is hashed.
 *
 * What the model may and may not claim:
 * - nodes and edges are facts copied from the analysis: a file exists, and it
 *   imports that other analysed file through a specifier the parser saw;
 * - modules are a *grouping policy* (directory of the file), not an inferred
 *   architecture — nothing here says a directory is a "layer";
 * - metrics are computed from the graph (fan-in, fan-out, cycles); they describe
 *   structure, not quality;
 * - findings carry a `certainty` so a reader can tell a graph fact (`certain`)
 *   from a threshold-based heuristic (`conditional`).
 *
 * The digest covers everything except nothing: unlike an analysis there is no
 * creation timestamp and there is no generated id, because an architecture model
 * is a pure function of its input analysis. Same analysis in, same digest out.
 */

import type { AnalysisLanguage, FindingCertainty, FindingSeverity, ImportKind } from './analysis.ts';
import { DomainError, invariant } from './errors.ts';
import { asAnalysisId, type AnalysisId, type ProjectId } from './ids.ts';
import { canonicalize, isSha256Hex, sha256Hex } from './integrity.ts';
import { asRevision, type RevisionId } from './revision.ts';

/** Version of the architecture model. Bump when the shape or meaning changes. */
export const ARCHITECTURE_SCHEMA_VERSION = 1;

/** Version of the derivation rules (graph, modules, metrics, findings). */
export const ARCHITECTURE_ENGINE_VERSION = '1.0.0';

/**
 * Module id of files that sit directly in the project root.
 *
 * `.` cannot collide with a directory module, because directory modules are
 * normalized relative paths and a relative path never contains a `.` segment.
 */
export const ROOT_MODULE_ID = '.';

/** Stable architecture rule ids. Never renumber; retire a rule instead. */
export const ARCHITECTURE_RULES = {
  circularDependency: 'VA001',
  selfImport: 'VA002',
  highFanOut: 'VA003',
  highFanIn: 'VA004',
  isolatedFile: 'VA005',
  isolatedModule: 'VA006',
  dependencyConcentration: 'VA007',
} as const;

/**
 * Resource bounds for one derivation.
 *
 * Exceeding any of them fails the derivation (`architecture_limit_exceeded`):
 * a report built from a truncated graph would describe a project that does not
 * exist.
 */
export interface ArchitectureLimits {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxModules: number;
  readonly maxFindings: number;
}

/**
 * Thresholds for the heuristic findings.
 *
 * These are signals chosen to be explainable, not universal quality rules: a
 * module with a high fan-in is often a shared utility and often a bottleneck,
 * and the graph cannot tell which. Every finding produced from a threshold is
 * marked `conditional` for exactly that reason.
 */
export interface ArchitectureThresholds {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly concentration: number;
}

export const DEFAULT_ARCHITECTURE_LIMITS: ArchitectureLimits = {
  maxNodes: 5_000,
  maxEdges: 20_000,
  maxModules: 2_000,
  maxFindings: 1_000,
};

export const DEFAULT_ARCHITECTURE_THRESHOLDS: ArchitectureThresholds = {
  fanIn: 10,
  fanOut: 10,
  concentration: 10,
};

/** One analysed source file. */
export interface ArchitectureNode {
  /** POSIX path relative to the project root; also the node's identifier. */
  readonly path: string;
  /** The directory module this file belongs to. */
  readonly moduleId: string;
  readonly language: AnalysisLanguage;
  /** Number of *other* internal files that import this file. */
  readonly fanIn: number;
  /** Number of *other* internal files this file imports. */
  readonly fanOut: number;
  /** No internal imports in either direction at all. */
  readonly isolated: boolean;
}

/**
 * One dependency between two analysed files.
 *
 * Duplicate imports (`import './a'` twice, or a static and a dynamic import of
 * the same file) collapse into a single edge that keeps every distinct kind and
 * specifier, so the graph is a relation rather than a multigraph but no evidence
 * is lost.
 */
export interface ArchitectureEdge {
  readonly from: string;
  readonly to: string;
  /** Distinct import kinds, sorted. */
  readonly kinds: readonly ImportKind[];
  /** Distinct specifiers exactly as written, sorted. */
  readonly specifiers: readonly string[];
  /** How many import statements were merged into this edge. */
  readonly importCount: number;
}

/** A directory grouping, with its cross-module dependency counts. */
export interface ArchitectureModule {
  /** Directory path relative to the project root, or `.` for the root. */
  readonly id: string;
  /** Files in this module, sorted. */
  readonly files: readonly string[];
  /** Number of *other* modules that import at least one file here. */
  readonly fanIn: number;
  /** Number of *other* modules this module imports at least one file from. */
  readonly fanOut: number;
  /** No cross-module edge in either direction (never true for a lone module). */
  readonly isolated: boolean;
}

/**
 * A circular dependency: a strongly connected component of the file graph.
 *
 * A size-1 component is only a cycle when the file imports itself.
 */
export interface ArchitectureCycle {
  /** Files in the cycle, sorted. */
  readonly nodes: readonly string[];
  /** True when the cycle is a single file importing itself. */
  readonly selfLoop: boolean;
}

/** An edge cited as evidence by a finding. */
export interface ArchitectureEdgeRef {
  readonly from: string;
  readonly to: string;
}

/**
 * A structural observation.
 *
 * `nodes` and `modules` name what the finding is about; `evidence` lists the
 * concrete edges that support it. A finding with no evidence is only produced
 * for observations that are themselves node/module facts (isolation).
 */
export interface ArchitectureFinding {
  /** Stable rule id, `VAnnn`. */
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly certainty: FindingCertainty;
  readonly nodes: readonly string[];
  readonly modules: readonly string[];
  readonly message: string;
  readonly evidence: readonly ArchitectureEdgeRef[];
}

export interface ArchitectureMetrics {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly moduleCount: number;
  /** Total import statements represented by the merged edges. */
  readonly internalImportCount: number;
  readonly isolatedFileCount: number;
  readonly isolatedModuleCount: number;
  readonly cycleCount: number;
  /** Number of files in the largest cycle; 0 when there are none. */
  readonly largestCycleSize: number;
  readonly maxFanIn: number;
  readonly maxFanOut: number;
}

export interface ArchitectureSummary {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly moduleCount: number;
  readonly cycleCount: number;
  readonly findingCount: number;
  readonly findingsBySeverity: Readonly<Record<FindingSeverity, number>>;
}

/** Everything the digest covers. */
export interface ArchitectureContent {
  readonly schemaVersion: number;
  readonly engineVersion: string;
  readonly analysisId: AnalysisId;
  /** Digest of the analysis this model was derived from — the provenance link. */
  readonly analysisDigest: string;
  readonly projectId: ProjectId;
  readonly projectRevision: RevisionId;
  readonly limits: ArchitectureLimits;
  readonly thresholds: ArchitectureThresholds;
  readonly nodes: readonly ArchitectureNode[];
  readonly edges: readonly ArchitectureEdge[];
  readonly modules: readonly ArchitectureModule[];
  readonly cycles: readonly ArchitectureCycle[];
  readonly findings: readonly ArchitectureFinding[];
}

export interface ArchitectureSnapshot extends ArchitectureContent {
  readonly metrics: ArchitectureMetrics;
  readonly summary: ArchitectureSummary;
  /** SHA-256 of the canonicalized content. */
  readonly digest: string;
}

export interface CreateArchitectureSnapshotInput {
  analysisId: AnalysisId | string;
  analysisDigest: string;
  projectId: ProjectId | string;
  projectRevision: string;
  schemaVersion?: number;
  engineVersion?: string;
  limits: ArchitectureLimits;
  thresholds: ArchitectureThresholds;
  nodes: readonly ArchitectureNode[];
  edges: readonly ArchitectureEdge[];
  modules: readonly ArchitectureModule[];
  cycles: readonly ArchitectureCycle[];
  findings: readonly ArchitectureFinding[];
}

const RULE_ID_PATTERN = /^VA\d{3}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** A module id: `.` for the root, otherwise a normalized relative directory. */
export function isArchitectureModuleId(value: unknown): value is string {
  if (value === ROOT_MODULE_ID) {
    return true;
  }
  if (typeof value !== 'string' || value === '' || value.includes('\\')) {
    return false;
  }
  if (value.startsWith('/') || value.endsWith('/')) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function compareNode(left: ArchitectureNode, right: ArchitectureNode): number {
  return compareStrings(left.path, right.path);
}

function compareEdge(left: ArchitectureEdge, right: ArchitectureEdge): number {
  return compareStrings(left.from, right.from) || compareStrings(left.to, right.to);
}

function compareModule(left: ArchitectureModule, right: ArchitectureModule): number {
  return compareStrings(left.id, right.id);
}

function compareCycle(left: ArchitectureCycle, right: ArchitectureCycle): number {
  // Largest cycles first, then by their first file: a reader wants the big
  // tangles before the two-file ones, and the order must not depend on discovery.
  if (left.nodes.length !== right.nodes.length) {
    return right.nodes.length - left.nodes.length;
  }
  return compareStrings(left.nodes[0] ?? '', right.nodes[0] ?? '');
}

function compareFindings(left: ArchitectureFinding, right: ArchitectureFinding): number {
  return (
    compareStrings(left.ruleId, right.ruleId) ||
    compareStrings(left.nodes[0] ?? '', right.nodes[0] ?? '') ||
    compareStrings(left.modules[0] ?? '', right.modules[0] ?? '') ||
    compareStrings(left.message, right.message)
  );
}

function compareEdgeRefs(left: ArchitectureEdgeRef, right: ArchitectureEdgeRef): number {
  return compareStrings(left.from, right.from) || compareStrings(left.to, right.to);
}

/**
 * Canonical ordering of an architecture model.
 *
 * Ordering is part of the contract: the digest is only reproducible if two runs
 * over the same analysis agree on it, and a JSON report must be diffable.
 */
export function normalizeArchitectureContent(content: {
  readonly nodes: readonly ArchitectureNode[];
  readonly edges: readonly ArchitectureEdge[];
  readonly modules: readonly ArchitectureModule[];
  readonly cycles: readonly ArchitectureCycle[];
  readonly findings: readonly ArchitectureFinding[];
}): Pick<ArchitectureContent, 'nodes' | 'edges' | 'modules' | 'cycles' | 'findings'> {
  return {
    nodes: [...content.nodes]
      .map((node) => ({ ...node }))
      .sort(compareNode),
    edges: [...content.edges]
      .map((edge) => ({
        ...edge,
        kinds: [...edge.kinds].sort(compareStrings),
        specifiers: [...edge.specifiers].sort(compareStrings),
      }))
      .sort(compareEdge),
    modules: [...content.modules]
      .map((module) => ({ ...module, files: [...module.files].sort(compareStrings) }))
      .sort(compareModule),
    cycles: [...content.cycles]
      .map((cycle) => ({ nodes: [...cycle.nodes].sort(compareStrings), selfLoop: cycle.selfLoop }))
      .sort(compareCycle),
    findings: [...content.findings]
      .map((finding) => ({
        ...finding,
        nodes: [...finding.nodes].sort(compareStrings),
        modules: [...finding.modules].sort(compareStrings),
        evidence: [...finding.evidence].map((ref) => ({ from: ref.from, to: ref.to })).sort(compareEdgeRefs),
      }))
      .sort(compareFindings),
  };
}

/**
 * Metrics are always recomputed from the graph.
 *
 * A caller cannot hand in a count that disagrees with the arrays it also handed
 * in, and a stored model cannot drift from its own content.
 */
export function computeArchitectureMetrics(
  nodes: readonly ArchitectureNode[],
  edges: readonly ArchitectureEdge[],
  modules: readonly ArchitectureModule[],
  cycles: readonly ArchitectureCycle[],
): ArchitectureMetrics {
  let internalImportCount = 0;
  for (const edge of edges) {
    internalImportCount += edge.importCount;
  }
  let largestCycleSize = 0;
  for (const cycle of cycles) {
    largestCycleSize = Math.max(largestCycleSize, cycle.nodes.length);
  }
  let maxFanIn = 0;
  let maxFanOut = 0;
  let isolatedFileCount = 0;
  for (const node of nodes) {
    maxFanIn = Math.max(maxFanIn, node.fanIn);
    maxFanOut = Math.max(maxFanOut, node.fanOut);
    if (node.isolated) {
      isolatedFileCount += 1;
    }
  }
  let isolatedModuleCount = 0;
  for (const module of modules) {
    if (module.isolated) {
      isolatedModuleCount += 1;
    }
  }
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    moduleCount: modules.length,
    internalImportCount,
    isolatedFileCount,
    isolatedModuleCount,
    cycleCount: cycles.length,
    largestCycleSize,
    maxFanIn,
    maxFanOut,
  };
}

export function summarizeArchitecture(
  nodes: readonly ArchitectureNode[],
  edges: readonly ArchitectureEdge[],
  modules: readonly ArchitectureModule[],
  cycles: readonly ArchitectureCycle[],
  findings: readonly ArchitectureFinding[],
): ArchitectureSummary {
  const findingsBySeverity: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    findingsBySeverity[finding.severity] += 1;
  }
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    moduleCount: modules.length,
    cycleCount: cycles.length,
    findingCount: findings.length,
    findingsBySeverity,
  };
}

/** Digest of the architecture content: canonical JSON, SHA-256. */
export function architectureContentDigest(
  content: ArchitectureContent & { metrics: ArchitectureMetrics; summary: ArchitectureSummary },
): string {
  return sha256Hex(canonicalize(content));
}

function checkCount(value: unknown, label: string): void {
  invariant(
    Number.isInteger(value) && (value as number) >= 0,
    'invalid_architecture_snapshot',
    `${label} must be a non-negative integer`,
  );
}

function checkLimit(value: unknown, label: string): void {
  invariant(
    Number.isInteger(value) && (value as number) >= 1,
    'invalid_architecture_snapshot',
    `${label} must be a positive integer`,
  );
}

/**
 * Build a validated architecture model.
 *
 * Every reference is checked against the model itself: an edge may only name
 * existing nodes, a module's files must exist and be assigned to it, a cycle may
 * only contain nodes, and a finding may only name nodes and modules that are in
 * the model. A derived model that refers to something absent is not evidence.
 */
export function createArchitectureSnapshot(
  input: CreateArchitectureSnapshotInput,
): ArchitectureSnapshot {
  invariant(
    typeof input.analysisId === 'string' && input.analysisId.trim() !== '',
    'invalid_architecture_snapshot',
    'An architecture model must record the analysis it was derived from',
  );
  const analysisId = asAnalysisId(String(input.analysisId));
  invariant(
    isSha256Hex(input.analysisDigest),
    'invalid_architecture_snapshot',
    'An architecture model must record the digest of its source analysis',
  );
  invariant(
    typeof input.projectId === 'string' && input.projectId.trim() !== '',
    'invalid_architecture_snapshot',
    'An architecture model must record its project id',
  );
  const projectRevision = asRevision(input.projectRevision);

  const schemaVersion = input.schemaVersion ?? ARCHITECTURE_SCHEMA_VERSION;
  invariant(
    schemaVersion === ARCHITECTURE_SCHEMA_VERSION,
    'architecture_unsupported_schema',
    `Architecture schema version ${String(schemaVersion)} is not supported by this build ` +
      `(${ARCHITECTURE_SCHEMA_VERSION})`,
  );
  const engineVersion = input.engineVersion ?? ARCHITECTURE_ENGINE_VERSION;
  invariant(
    typeof engineVersion === 'string' && VERSION_PATTERN.test(engineVersion),
    'invalid_architecture_snapshot',
    `Architecture engine version must look like 1.2.3, received '${String(engineVersion)}'`,
  );

  invariant(isRecord(input.limits), 'invalid_architecture_snapshot', 'Architecture limits are required');
  for (const key of ['maxNodes', 'maxEdges', 'maxModules', 'maxFindings'] as const) {
    checkLimit(input.limits[key], `Limit ${key}`);
  }
  invariant(
    isRecord(input.thresholds),
    'invalid_architecture_snapshot',
    'Architecture thresholds are required',
  );
  for (const key of ['fanIn', 'fanOut', 'concentration'] as const) {
    checkLimit(input.thresholds[key], `Threshold ${key}`);
  }

  invariant(Array.isArray(input.nodes), 'invalid_architecture_snapshot', 'Nodes must be a list');
  invariant(Array.isArray(input.edges), 'invalid_architecture_snapshot', 'Edges must be a list');
  invariant(Array.isArray(input.modules), 'invalid_architecture_snapshot', 'Modules must be a list');
  invariant(Array.isArray(input.cycles), 'invalid_architecture_snapshot', 'Cycles must be a list');
  invariant(Array.isArray(input.findings), 'invalid_architecture_snapshot', 'Findings must be a list');

  const limits = input.limits;
  invariant(
    input.nodes.length <= limits.maxNodes,
    'architecture_limit_exceeded',
    `Architecture graph has ${input.nodes.length} nodes, above the ${limits.maxNodes}-node limit`,
  );
  invariant(
    input.edges.length <= limits.maxEdges,
    'architecture_limit_exceeded',
    `Architecture graph has ${input.edges.length} edges, above the ${limits.maxEdges}-edge limit`,
  );
  invariant(
    input.modules.length <= limits.maxModules,
    'architecture_limit_exceeded',
    `Architecture graph has ${input.modules.length} modules, above the ` +
      `${limits.maxModules}-module limit`,
  );
  invariant(
    input.findings.length <= limits.maxFindings,
    'architecture_limit_exceeded',
    `Architecture graph has ${input.findings.length} findings, above the ` +
      `${limits.maxFindings}-finding limit`,
  );

  const nodePaths = new Set<string>();
  for (const node of input.nodes) {
    invariant(
      typeof node?.path === 'string' && node.path !== '',
      'invalid_architecture_snapshot',
      'Every node must record a file path',
    );
    invariant(
      !node.path.includes('\\') &&
        !node.path.startsWith('/') &&
        node.path
          .split('/')
          .every((segment: string) => segment !== '' && segment !== '.' && segment !== '..'),
      'invalid_architecture_snapshot',
      `Node path '${node.path}' must be a normalized path relative to the project root`,
    );
    invariant(
      !nodePaths.has(node.path),
      'invalid_architecture_snapshot',
      `Node ${node.path} appears twice`,
    );
    nodePaths.add(node.path);
    invariant(
      isArchitectureModuleId(node.moduleId),
      'invalid_architecture_snapshot',
      `Node ${node.path} has an invalid module id`,
    );
    invariant(
      node.language === 'javascript' || node.language === 'typescript',
      'invalid_architecture_snapshot',
      `Node ${node.path} has an unknown language`,
    );
    checkCount(node.fanIn, `Node ${node.path} fan-in`);
    checkCount(node.fanOut, `Node ${node.path} fan-out`);
    invariant(
      typeof node.isolated === 'boolean',
      'invalid_architecture_snapshot',
      `Node ${node.path} must record whether it is isolated`,
    );
  }

  const edgeKeys = new Set<string>();
  for (const edge of input.edges) {
    invariant(
      typeof edge?.from === 'string' && nodePaths.has(edge.from),
      'invalid_architecture_snapshot',
      `Edge from ${String(edge?.from)} names a file that is not a node`,
    );
    invariant(
      typeof edge.to === 'string' && nodePaths.has(edge.to),
      'invalid_architecture_snapshot',
      `Edge to ${String(edge?.to)} names a file that is not a node`,
    );
    const key = `${edge.from}\u0000${edge.to}`;
    invariant(
      !edgeKeys.has(key),
      'invalid_architecture_snapshot',
      `Edge ${edge.from} -> ${edge.to} appears twice; duplicate imports must be merged`,
    );
    edgeKeys.add(key);
    invariant(
      Array.isArray(edge.kinds) && edge.kinds.length > 0,
      'invalid_architecture_snapshot',
      `Edge ${edge.from} -> ${edge.to} must record at least one import kind`,
    );
    for (const kind of edge.kinds) {
      invariant(
        kind === 'static' || kind === 'dynamic' || kind === 'require' || kind === 'export-from',
        'invalid_architecture_snapshot',
        `Edge ${edge.from} -> ${edge.to} has an unknown import kind`,
      );
    }
    invariant(
      new Set(edge.kinds).size === edge.kinds.length,
      'invalid_architecture_snapshot',
      `Edge ${edge.from} -> ${edge.to} repeats an import kind`,
    );
    invariant(
      Array.isArray(edge.specifiers) && edge.specifiers.length > 0,
      'invalid_architecture_snapshot',
      `Edge ${edge.from} -> ${edge.to} must keep the specifiers that produced it`,
    );
    for (const specifier of edge.specifiers) {
      invariant(
        typeof specifier === 'string' && specifier !== '',
        'invalid_architecture_snapshot',
        `Edge ${edge.from} -> ${edge.to} has an empty specifier`,
      );
    }
    invariant(
      new Set(edge.specifiers).size === edge.specifiers.length,
      'invalid_architecture_snapshot',
      `Edge ${edge.from} -> ${edge.to} repeats a specifier`,
    );
    invariant(
      Number.isInteger(edge.importCount) && edge.importCount >= 1,
      'invalid_architecture_snapshot',
      `Edge ${edge.from} -> ${edge.to} must count the imports it merged`,
    );
    invariant(
      edge.importCount >= edge.specifiers.length,
      'invalid_architecture_snapshot',
      `Edge ${edge.from} -> ${edge.to} merged fewer imports than it has specifiers`,
    );
  }

  const moduleIds = new Set<string>();
  const moduleOfFile = new Map<string, string>();
  for (const module of input.modules) {
    invariant(
      isArchitectureModuleId(module?.id),
      'invalid_architecture_snapshot',
      `Module id '${String(module?.id)}' must be '.' or a normalized relative directory`,
    );
    invariant(
      !moduleIds.has(module.id),
      'invalid_architecture_snapshot',
      `Module ${module.id} appears twice`,
    );
    moduleIds.add(module.id);
    invariant(Array.isArray(module.files), 'invalid_architecture_snapshot', `Module ${module.id} has no file list`);
    for (const file of module.files) {
      invariant(
        nodePaths.has(file),
        'invalid_architecture_snapshot',
        `Module ${module.id} lists ${String(file)}, which is not a node`,
      );
      invariant(
        !moduleOfFile.has(file),
        'invalid_architecture_snapshot',
        `File ${file} belongs to more than one module`,
      );
      moduleOfFile.set(file, module.id);
    }
    checkCount(module.fanIn, `Module ${module.id} fan-in`);
    checkCount(module.fanOut, `Module ${module.id} fan-out`);
    invariant(
      typeof module.isolated === 'boolean',
      'invalid_architecture_snapshot',
      `Module ${module.id} must record whether it is isolated`,
    );
  }

  for (const node of input.nodes) {
    invariant(
      moduleIds.has(node.moduleId),
      'invalid_architecture_snapshot',
      `Node ${node.path} belongs to module ${node.moduleId}, which is not in the model`,
    );
    invariant(
      moduleOfFile.get(node.path) === node.moduleId,
      'invalid_architecture_snapshot',
      `Node ${node.path} claims module ${node.moduleId}, but that module does not list it`,
    );
  }

  for (const cycle of input.cycles) {
    invariant(
      isRecord(cycle) && Array.isArray(cycle.nodes) && cycle.nodes.length > 0,
      'invalid_architecture_snapshot',
      'A cycle must list the files it contains',
    );
    for (const path of cycle.nodes) {
      invariant(
        nodePaths.has(path),
        'invalid_architecture_snapshot',
        `Cycle contains ${String(path)}, which is not a node`,
      );
    }
    invariant(
      new Set(cycle.nodes).size === cycle.nodes.length,
      'invalid_architecture_snapshot',
      'A cycle must not repeat a file',
    );
    invariant(
      typeof cycle.selfLoop === 'boolean',
      'invalid_architecture_snapshot',
      'A cycle must record whether it is a self-loop',
    );
    invariant(
      !cycle.selfLoop || cycle.nodes.length === 1,
      'invalid_architecture_snapshot',
      'A self-loop cycle may only contain one file',
    );
    invariant(
      cycle.selfLoop || cycle.nodes.length > 1,
      'invalid_architecture_snapshot',
      'A single-file cycle must be marked as a self-loop',
    );
  }

  for (const finding of input.findings) {
    invariant(
      isRecord(finding) && typeof finding.ruleId === 'string' && RULE_ID_PATTERN.test(finding.ruleId),
      'invalid_architecture_snapshot',
      'An architecture finding must carry a stable VAnnn rule id',
    );
    invariant(
      finding.severity === 'error' || finding.severity === 'warning' || finding.severity === 'info',
      'invalid_architecture_snapshot',
      `Finding ${finding.ruleId} has an unknown severity`,
    );
    invariant(
      finding.certainty === 'certain' || finding.certainty === 'conditional',
      'invalid_architecture_snapshot',
      `Finding ${finding.ruleId} has an unknown certainty`,
    );
    invariant(
      Array.isArray(finding.nodes) && Array.isArray(finding.modules),
      'invalid_architecture_snapshot',
      `Finding ${finding.ruleId} must list the nodes and modules it concerns`,
    );
    for (const path of finding.nodes) {
      invariant(
        nodePaths.has(path),
        'invalid_architecture_snapshot',
        `Finding ${finding.ruleId} refers to ${String(path)}, which is not a node`,
      );
    }
    for (const moduleId of finding.modules) {
      invariant(
        moduleIds.has(moduleId),
        'invalid_architecture_snapshot',
        `Finding ${finding.ruleId} refers to module ${String(moduleId)}, which is not in the model`,
      );
    }
    invariant(
      finding.nodes.length > 0 || finding.modules.length > 0,
      'invalid_architecture_snapshot',
      `Finding ${finding.ruleId} does not say what it is about`,
    );
    invariant(
      typeof finding.message === 'string' && finding.message.trim() !== '',
      'invalid_architecture_snapshot',
      `Finding ${finding.ruleId} has no explanation`,
    );
    invariant(
      Array.isArray(finding.evidence),
      'invalid_architecture_snapshot',
      `Finding ${finding.ruleId} must list the edges that support it`,
    );
    for (const ref of finding.evidence) {
      invariant(
        isRecord(ref) &&
          typeof ref.from === 'string' &&
          typeof ref.to === 'string' &&
          nodePaths.has(ref.from) &&
          nodePaths.has(ref.to),
        'invalid_architecture_snapshot',
        `Finding ${finding.ruleId} cites an edge that is not in the graph`,
      );
      invariant(
        edgeKeys.has(`${ref.from}\u0000${ref.to}`),
        'invalid_architecture_snapshot',
        `Finding ${finding.ruleId} cites edge ${ref.from} -> ${ref.to}, which has no node pair in the graph`,
      );
    }
  }

  const normalized = normalizeArchitectureContent({
    nodes: input.nodes,
    edges: input.edges,
    modules: input.modules,
    cycles: input.cycles,
    findings: input.findings,
  });

  const metrics = computeArchitectureMetrics(
    normalized.nodes,
    normalized.edges,
    normalized.modules,
    normalized.cycles,
  );
  const summary = summarizeArchitecture(
    normalized.nodes,
    normalized.edges,
    normalized.modules,
    normalized.cycles,
    normalized.findings,
  );
  const content = {
    schemaVersion,
    engineVersion,
    analysisId,
    analysisDigest: input.analysisDigest,
    projectId: input.projectId as ProjectId,
    projectRevision,
    limits: {
      maxNodes: limits.maxNodes,
      maxEdges: limits.maxEdges,
      maxModules: limits.maxModules,
      maxFindings: limits.maxFindings,
    },
    thresholds: {
      fanIn: input.thresholds.fanIn,
      fanOut: input.thresholds.fanOut,
      concentration: input.thresholds.concentration,
    },
    nodes: normalized.nodes,
    edges: normalized.edges,
    modules: normalized.modules,
    cycles: normalized.cycles,
    findings: normalized.findings,
  };

  return {
    ...content,
    metrics,
    summary,
    digest: architectureContentDigest({ ...content, metrics, summary }),
  };
}

/** Deep copy, so a stored or returned model cannot be mutated by aliasing. */
export function cloneArchitectureSnapshot(snapshot: ArchitectureSnapshot): ArchitectureSnapshot {
  return createArchitectureSnapshot({
    analysisId: snapshot.analysisId,
    analysisDigest: snapshot.analysisDigest,
    projectId: snapshot.projectId,
    projectRevision: snapshot.projectRevision,
    schemaVersion: snapshot.schemaVersion,
    engineVersion: snapshot.engineVersion,
    limits: { ...snapshot.limits },
    thresholds: { ...snapshot.thresholds },
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    modules: snapshot.modules,
    cycles: snapshot.cycles,
    findings: snapshot.findings,
  });
}

/**
 * Recompute the digest and compare.
 *
 * A model whose content no longer matches its digest was edited or corrupted;
 * it is refused rather than reported as if it described the analysis.
 */
export function assertArchitectureDigest(snapshot: ArchitectureSnapshot): void {
  const { digest, ...content } = snapshot;
  const expected = architectureContentDigest(content as ArchitectureContent & {
    metrics: ArchitectureMetrics;
    summary: ArchitectureSummary;
  });
  if (expected !== digest) {
    throw new DomainError(
      'architecture_corrupted',
      `Architecture model for analysis ${snapshot.analysisId} does not match its recorded ` +
        `digest (${digest}); it was modified or corrupted`,
    );
  }
}

/** One-line label used by the CLI and by reports. */
export function describeArchitectureFinding(finding: ArchitectureFinding): string {
  const subject =
    finding.nodes.length > 0 ? finding.nodes[0] : `module ${finding.modules[0] ?? '?'}`;
  const suffix =
    finding.nodes.length > 1 ? ` (+${finding.nodes.length - 1} more)` : '';
  return `${finding.severity.toUpperCase()} ${finding.ruleId} ${finding.certainty} ${subject}${suffix} ${finding.message}`;
}
