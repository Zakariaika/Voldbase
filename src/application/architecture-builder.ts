/**
 * Architecture derivation (Phase 2B).
 *
 * Turns one AnalysisSnapshot into an ArchitectureSnapshot. This is a *pure*
 * function of the analysis: it reads no file, parses no source, resolves no
 * specifier, executes nothing. Every edge it emits is an import the analysis
 * already classified `resolved-relative`, i.e. one that names another analysed
 * file, so the graph cannot contain an edge nobody can trace back.
 *
 * Pipeline: collect edges -> fold self/parallel imports -> modules -> metrics ->
 * strongly connected components -> findings -> validated model.
 */

import {
  ARCHITECTURE_RULES,
  DEFAULT_ARCHITECTURE_LIMITS,
  DEFAULT_ARCHITECTURE_THRESHOLDS,
  ROOT_MODULE_ID,
  createArchitectureSnapshot,
  type ArchitectureCycle,
  type ArchitectureEdge,
  type ArchitectureEdgeRef,
  type ArchitectureFinding,
  type ArchitectureLimits,
  type ArchitectureModule,
  type ArchitectureNode,
  type ArchitectureSnapshot,
  type ArchitectureThresholds,
} from '../domain/architecture.ts';
import type { AnalysisSnapshot, ImportKind } from '../domain/analysis.ts';
import { invariant } from '../domain/errors.ts';

export interface BuildArchitectureOptions {
  readonly limits?: Partial<ArchitectureLimits>;
  readonly thresholds?: Partial<ArchitectureThresholds>;
}

/** Separator for composite map keys; never appears in a path or module id. */
const KEY_SEPARATOR = '\u0000';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function edgeKey(from: string, to: string): string {
  return `${from}${KEY_SEPARATOR}${to}`;
}

/**
 * Module id of a file path: its directory, or `.` for a root file.
 *
 * This is the whole module policy. A directory name is data, never a signal:
 * `services`, `utils` and `core` get exactly the same treatment as any other
 * folder, and nothing here infers a layer, an owner or an intent.
 */
export function moduleIdForPath(filePath: string): string {
  const separator = filePath.lastIndexOf('/');
  if (separator <= 0) {
    return ROOT_MODULE_ID;
  }
  return filePath.slice(0, separator);
}

interface EdgeAccumulator {
  readonly from: string;
  readonly to: string;
  kinds: Set<ImportKind>;
  specifiers: Set<string>;
  importCount: number;
}

/**
 * Fold every `resolved-relative` import into at most one edge per file pair.
 *
 * Duplicate imports do not create duplicate edges, but the kinds, the specifiers
 * and the number of statements are kept, so "imported twice, statically and
 * dynamically" stays visible.
 */
function collectEdges(analysis: AnalysisSnapshot): Map<string, EdgeAccumulator> {
  const edges = new Map<string, EdgeAccumulator>();
  for (const file of analysis.files) {
    for (const dependency of file.imports) {
      if (dependency.resolution !== 'resolved-relative' || dependency.target === null) {
        continue;
      }
      const key = edgeKey(file.path, dependency.target);
      const existing = edges.get(key);
      if (existing === undefined) {
        edges.set(key, {
          from: file.path,
          to: dependency.target,
          kinds: new Set([dependency.kind]),
          specifiers: new Set([dependency.specifier]),
          importCount: 1,
        });
        continue;
      }
      existing.kinds.add(dependency.kind);
      existing.specifiers.add(dependency.specifier);
      existing.importCount += 1;
    }
  }
  return edges;
}

function materializeEdges(accumulated: Iterable<EdgeAccumulator>): ArchitectureEdge[] {
  const edges: ArchitectureEdge[] = [];
  for (const edge of accumulated) {
    edges.push({
      from: edge.from,
      to: edge.to,
      kinds: [...edge.kinds].sort(compareStrings),
      specifiers: [...edge.specifiers].sort(compareStrings),
      importCount: edge.importCount,
    });
  }
  return edges.sort(
    (left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to),
  );
}

/**
 * Strongly connected components of the file graph (iterative Tarjan).
 *
 * Iterative on purpose: a dependency chain deep enough to blow the JavaScript
 * call stack would turn a code review into a crash, so the algorithm carries its
 * own frame stack and never recurses. Cost is O(V + E).
 *
 * Returns only the components that are cycles: size > 1, or a single file that
 * imports itself.
 */
export function findCycleComponents(
  paths: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): ArchitectureCycle[] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: ArchitectureCycle[] = [];
  let nextIndex = 0;

  const ordered = [...paths].sort(compareStrings);

  for (const root of ordered) {
    if (index.has(root)) {
      continue;
    }
    const frames: { node: string; edgeIndex: number; neighbours: readonly string[] }[] = [];
    frames.push({ node: root, edgeIndex: 0, neighbours: adjacency.get(root) ?? [] });
    index.set(root, nextIndex);
    lowLink.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as {
        node: string;
        edgeIndex: number;
        neighbours: readonly string[];
      };

      if (frame.edgeIndex < frame.neighbours.length) {
        const neighbour = frame.neighbours[frame.edgeIndex] as string;
        frame.edgeIndex += 1;

        if (!index.has(neighbour)) {
          index.set(neighbour, nextIndex);
          lowLink.set(neighbour, nextIndex);
          nextIndex += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          frames.push({ node: neighbour, edgeIndex: 0, neighbours: adjacency.get(neighbour) ?? [] });
          continue;
        }
        if (onStack.has(neighbour)) {
          lowLink.set(
            frame.node,
            Math.min(lowLink.get(frame.node) as number, index.get(neighbour) as number),
          );
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowLink.set(
          parent.node,
          Math.min(lowLink.get(parent.node) as number, lowLink.get(frame.node) as number),
        );
        continue;
      }

      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        while (stack.length > 0) {
          const member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) {
            break;
          }
        }
        component.sort(compareStrings);
        if (component.length > 1) {
          cycles.push({ nodes: component, selfLoop: false });
        } else {
          const only = component[0] as string;
          if ((adjacency.get(only) ?? []).includes(only)) {
            cycles.push({ nodes: [only], selfLoop: true });
          }
        }
      }
    }
  }

  return cycles.sort(
    (left, right) =>
      right.nodes.length - left.nodes.length ||
      compareStrings(left.nodes[0] ?? '', right.nodes[0] ?? ''),
  );
}

function resolveOptions(options: BuildArchitectureOptions): {
  limits: ArchitectureLimits;
  thresholds: ArchitectureThresholds;
} {
  const limits = { ...DEFAULT_ARCHITECTURE_LIMITS, ...options.limits };
  const thresholds = { ...DEFAULT_ARCHITECTURE_THRESHOLDS, ...options.thresholds };
  return { limits, thresholds };
}

/**
 * Derive the architecture model of an analysis.
 *
 * Throws `architecture_invalid_analysis` when the analysis is not a coherent
 * snapshot (an import naming a file that is not analysed, a duplicate file, an
 * empty path), and `architecture_limit_exceeded` when the graph is larger than
 * the configured bounds. Nothing is ever silently dropped.
 */
export function buildArchitecture(
  analysis: AnalysisSnapshot,
  options: BuildArchitectureOptions = {},
): ArchitectureSnapshot {
  const { limits, thresholds } = resolveOptions(options);

  invariant(
    typeof analysis === 'object' && analysis !== null && Array.isArray(analysis.files),
    'architecture_invalid_analysis',
    'Architecture needs an analysis snapshot with a file list',
  );
  invariant(
    typeof analysis.digest === 'string' && analysis.digest !== '',
    'architecture_invalid_analysis',
    'Architecture needs the digest of the analysis it is derived from',
  );

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const file of analysis.files) {
    invariant(
      typeof file?.path === 'string' && file.path !== '',
      'architecture_invalid_analysis',
      'Every analysed file must record a path',
    );
    invariant(
      !seen.has(file.path),
      'architecture_invalid_analysis',
      `Analysis lists ${file.path} more than once`,
    );
    seen.add(file.path);
    paths.push(file.path);
  }

  paths.sort(compareStrings);

  invariant(
    paths.length <= limits.maxNodes,
    'architecture_limit_exceeded',
    `Analysis has ${paths.length} analysed files, above the ${limits.maxNodes}-node architecture limit`,
  );

  const accumulated = collectEdges(analysis);
  for (const edge of accumulated.values()) {
    invariant(
      seen.has(edge.to),
      'architecture_invalid_analysis',
      `Import from ${edge.from} resolves to ${edge.to}, which is not an analysed file`,
    );
  }
  invariant(
    accumulated.size <= limits.maxEdges,
    'architecture_limit_exceeded',
    `Graph has ${accumulated.size} edges, above the ${limits.maxEdges}-edge architecture limit`,
  );

  const edges = materializeEdges(accumulated.values());

  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  const selfLoops = new Set<string>();
  for (const path of paths) {
    adjacency.set(path, []);
    reverseAdjacency.set(path, []);
  }
  for (const edge of edges) {
    if (edge.from === edge.to) {
      selfLoops.add(edge.from);
      continue;
    }
    (adjacency.get(edge.from) as string[]).push(edge.to);
    (reverseAdjacency.get(edge.to) as string[]).push(edge.from);
  }

  const nodes: ArchitectureNode[] = [];
  const languageOf = new Map<string, ArchitectureNode['language']>();
  const moduleOf = new Map<string, string>();
  for (const file of analysis.files) {
    languageOf.set(file.path, file.language);
    moduleOf.set(file.path, moduleIdForPath(file.path));
  }

  // Fan-in and fan-out count distinct *other* files. Self-imports are excluded:
  // a file importing itself is a cycle, not a dependency on something else.
  for (const path of paths) {
    const fanIn = new Set(reverseAdjacency.get(path) ?? []).size;
    const fanOut = new Set(adjacency.get(path) ?? []).size;
    nodes.push({
      path,
      moduleId: moduleOf.get(path) as string,
      language: languageOf.get(path) as ArchitectureNode['language'],
      fanIn,
      fanOut,
      isolated: fanIn === 0 && fanOut === 0 && !selfLoops.has(path),
    });
  }

  const moduleFiles = new Map<string, string[]>();
  for (const path of paths) {
    const moduleId = moduleOf.get(path) as string;
    const files = moduleFiles.get(moduleId);
    if (files === undefined) {
      moduleFiles.set(moduleId, [path]);
    } else {
      files.push(path);
    }
  }
  invariant(
    moduleFiles.size <= limits.maxModules,
    'architecture_limit_exceeded',
    `Graph has ${moduleFiles.size} modules, above the ${limits.maxModules}-module architecture limit`,
  );

  const moduleOut = new Map<string, Set<string>>();
  const moduleIn = new Map<string, Set<string>>();
  for (const moduleId of moduleFiles.keys()) {
    moduleOut.set(moduleId, new Set());
    moduleIn.set(moduleId, new Set());
  }
  for (const edge of edges) {
    const from = moduleOf.get(edge.from) as string;
    const to = moduleOf.get(edge.to) as string;
    if (from === to) {
      continue;
    }
    (moduleOut.get(from) as Set<string>).add(to);
    (moduleIn.get(to) as Set<string>).add(from);
  }

  const modules: ArchitectureModule[] = [];
  const sortedModuleIds = [...moduleFiles.keys()].sort(compareStrings);
  const multipleModules = sortedModuleIds.length > 1;
  for (const moduleId of sortedModuleIds) {
    const fanIn = (moduleIn.get(moduleId) as Set<string>).size;
    const fanOut = (moduleOut.get(moduleId) as Set<string>).size;
    modules.push({
      id: moduleId,
      files: [...(moduleFiles.get(moduleId) as string[])].sort(compareStrings),
      fanIn,
      fanOut,
      // A project with a single module is not "disconnected": marking the only
      // module isolated would say nothing about the code.
      isolated: multipleModules && fanIn === 0 && fanOut === 0,
    });
  }

  const cycles = findCycleComponents(paths, adjacency);
  const findings: ArchitectureFinding[] = [];

  const edgeRef = (from: string, to: string): ArchitectureEdgeRef => ({ from, to });
  const edgesInside = (members: ReadonlySet<string>): ArchitectureEdgeRef[] =>
    edges
      .filter((edge) => members.has(edge.from) && members.has(edge.to))
      .map((edge) => edgeRef(edge.from, edge.to));

  for (const cycle of cycles) {
    const members = new Set(cycle.nodes);
    if (cycle.selfLoop) {
      findings.push({
        ruleId: ARCHITECTURE_RULES.selfImport,
        severity: 'warning',
        certainty: 'certain',
        nodes: cycle.nodes,
        modules: [],
        message:
          'This file imports itself. The self-import is kept in the graph as a one-file cycle; ' +
          'whether it has any runtime effect depends on how the code is loaded.',
        evidence: [edgeRef(cycle.nodes[0] as string, cycle.nodes[0] as string)],
      });
      continue;
    }
    findings.push({
      ruleId: ARCHITECTURE_RULES.circularDependency,
      severity: 'warning',
      certainty: 'certain',
      nodes: cycle.nodes,
      modules: [],
      message:
        `${cycle.nodes.length} files depend on each other in a cycle. The cycle is a fact about ` +
        'imports; it does not by itself mean the code fails or misbehaves at runtime.',
      evidence: edgesInside(members),
    });
  }

  const moduleById = new Map<string, ArchitectureModule>();
  for (const module of modules) {
    moduleById.set(module.id, module);
  }

  for (const node of nodes) {
    if (node.fanOut >= thresholds.fanOut) {
      findings.push({
        ruleId: ARCHITECTURE_RULES.highFanOut,
        severity: 'info',
        certainty: 'conditional',
        nodes: [node.path],
        modules: [],
        message:
          `This file imports ${node.fanOut} other internal files, at or above the configured ` +
          `fan-out threshold of ${thresholds.fanOut}. The count is measured; that a high fan-out ` +
          'is a problem is a heuristic, not a rule.',
        evidence: edges
          .filter((edge) => edge.from === node.path)
          .map((edge) => edgeRef(edge.from, edge.to)),
      });
    }
    if (node.fanIn >= thresholds.fanIn) {
      findings.push({
        ruleId: ARCHITECTURE_RULES.highFanIn,
        severity: 'info',
        certainty: 'conditional',
        nodes: [node.path],
        modules: [],
        message:
          `${node.fanIn} other internal files import this one, at or above the configured ` +
          `fan-in threshold of ${thresholds.fanIn}. A widely imported file may be a shared ` +
          'utility or a coupling point; the graph cannot tell which.',
        evidence: edges
          .filter((edge) => edge.to === node.path)
          .map((edge) => edgeRef(edge.from, edge.to)),
      });
    }
    if (node.isolated) {
      findings.push({
        ruleId: ARCHITECTURE_RULES.isolatedFile,
        severity: 'info',
        certainty: 'certain',
        nodes: [node.path],
        modules: [],
        message:
          'No other analysed file imports this file and it imports nothing: it is not part of ' +
          'the internal dependency graph. It may be an entry point, a test or unused code.',
        evidence: [],
      });
    }
  }

  for (const module of modules) {
    if (module.isolated) {
      findings.push({
        ruleId: ARCHITECTURE_RULES.isolatedModule,
        severity: 'info',
        certainty: 'certain',
        nodes: [],
        modules: [module.id],
        message:
          `Module ${module.id} has no dependency in either direction with another module. ` +
          'Its files may still be connected inside the module; nothing outside it imports them.',
        evidence: [],
      });
    }
  }

  // Cross-module concentration: how many merged import statements a module pair
  // exchanges. Counted per statement, so ten imports from one file weigh the same
  // as ten imports from ten files — the metric is about coupling, not fan-out.
  const pairCounts = new Map<string, { from: string; to: string; count: number }>();
  for (const edge of edges) {
    const from = moduleOf.get(edge.from) as string;
    const to = moduleOf.get(edge.to) as string;
    if (from === to) {
      continue;
    }
    const key = edgeKey(from, to);
    const existing = pairCounts.get(key);
    if (existing === undefined) {
      pairCounts.set(key, { from, to, count: edge.importCount });
    } else {
      existing.count += edge.importCount;
    }
  }
  const concentrated = [...pairCounts.values()]
    .filter((pair) => pair.count >= thresholds.concentration)
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareStrings(left.from, right.from) ||
        compareStrings(left.to, right.to),
    );
  for (const pair of concentrated) {
    findings.push({
      ruleId: ARCHITECTURE_RULES.dependencyConcentration,
      severity: 'info',
      certainty: 'conditional',
      nodes: [],
      modules: [pair.from, pair.to],
      message:
        `${pair.from} imports ${pair.count} times from ${pair.to} (merged import statements), ` +
        `at or above the configured concentration threshold of ${thresholds.concentration}. ` +
        'Heavy coupling in one direction is a signal to look, not a defect.',
      evidence: edges
        .filter(
          (edge) =>
            moduleOf.get(edge.from) === pair.from && moduleOf.get(edge.to) === pair.to,
        )
        .map((edge) => edgeRef(edge.from, edge.to)),
    });
  }

  invariant(
    findings.length <= limits.maxFindings,
    'architecture_limit_exceeded',
    `Architecture produced ${findings.length} findings, above the ` +
      `${limits.maxFindings}-finding limit`,
  );

  return createArchitectureSnapshot({
    analysisId: analysis.analysisId,
    analysisDigest: analysis.digest,
    projectId: analysis.projectId,
    projectRevision: analysis.projectRevision,
    limits,
    thresholds,
    nodes,
    edges,
    modules,
    cycles,
    findings,
  });
}
