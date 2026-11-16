/**
 * Architecture derivation (Phase 2B).
 *
 * A pure function from one `AnalysisSnapshot` to one `ArchitectureSnapshot`.
 * It reads no files, opens no sockets, spawns nothing and imports nothing from
 * the filesystem: the only input is the analysis that Phase 2A already produced
 * and the only output is a validated domain model.
 *
 * Three different kinds of statement live here, and they are kept apart:
 *
 * 1. **Facts copied from the analysis** — a file exists, an import resolved to
 *    another analysed file, with the specifier the parser saw.
 * 2. **Calculations over that graph** — fan-in, fan-out, strongly connected
 *    components, cross-module coupling. These are arithmetic on facts: exact,
 *    reproducible, and not opinions.
 * 3. **Heuristic signals** — anything produced from a configurable threshold.
 *    Those findings are marked `conditional` and say so in their own message.
 *
 * Module grouping is a stated *policy* (the directory a file lives in), never an
 * inference about intended layering. Nothing here claims that `services/` is a
 * service layer, or that a cycle will break at runtime.
 */

import type { AnalysisSnapshot, ImportKind } from '../domain/analysis.ts';
import {
  ARCHITECTURE_RULES,
  createArchitectureSnapshot,
  DEFAULT_ARCHITECTURE_LIMITS,
  DEFAULT_ARCHITECTURE_THRESHOLDS,
  ROOT_MODULE_ID,
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
import { DomainError } from '../domain/errors.ts';

export interface BuildArchitectureOptions {
  readonly limits?: Partial<ArchitectureLimits>;
  readonly thresholds?: Partial<ArchitectureThresholds>;
}

/** Separator for composite map keys; cannot occur in a POSIX relative path. */
const KEY_SEPARATOR = '\u0000';

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function edgeKey(from: string, to: string): string {
  return `${from}${KEY_SEPARATOR}${to}`;
}

/**
 * The module a file belongs to: its directory, or `.` at the project root.
 *
 * This is the whole grouping policy. It is deterministic, needs no configuration
 * and claims nothing about intent.
 */
export function moduleIdForPath(filePath: string): string {
  const separator = filePath.lastIndexOf('/');
  return separator === -1 ? ROOT_MODULE_ID : filePath.slice(0, separator);
}

interface EdgeAccumulator {
  readonly from: string;
  readonly to: string;
  readonly kinds: Set<ImportKind>;
  readonly specifiers: Set<string>;
  importCount: number;
}

/**
 * Collapse every resolved import into at most one edge per file pair.
 *
 * Nothing is invented and nothing is dropped: unresolved, external and
 * out-of-root imports never become edges (they name no internal file), and a pair
 * imported several times keeps every kind, every specifier and the number of
 * statements that produced it.
 */
function collectEdges(
  analysis: AnalysisSnapshot,
  knownPaths: ReadonlySet<string>,
  limits: ArchitectureLimits,
): Map<string, EdgeAccumulator> {
  const edges = new Map<string, EdgeAccumulator>();

  for (const file of analysis.files) {
    for (const importEdge of file.imports) {
      if (importEdge.resolution !== 'resolved-relative') {
        continue;
      }
      const target = importEdge.resolvedPath;
      if (target === undefined || !knownPaths.has(target)) {
        // The analysis domain forbids this, so seeing it means the snapshot was
        // hand-built or damaged: refuse instead of drawing an edge to nowhere.
        throw new DomainError(
          'architecture_invalid_analysis',
          `Analysis ${analysis.analysisId} resolves '${importEdge.specifier}' in ${file.path} to ` +
            `${String(target)}, which is not an analysed file`,
        );
      }

      const key = edgeKey(file.path, target);
      const existing = edges.get(key);
      if (existing === undefined) {
        edges.set(key, {
          from: file.path,
          to: target,
          kinds: new Set([importEdge.kind]),
          specifiers: new Set([importEdge.specifier]),
          importCount: 1,
        });
      } else {
        existing.kinds.add(importEdge.kind);
        existing.specifiers.add(importEdge.specifier);
        existing.importCount += 1;
      }

      if (edges.size > limits.maxEdges) {
        throw new DomainError(
          'architecture_limit_exceeded',
          `Architecture graph exceeds the ${limits.maxEdges}-edge limit; the project is too ` +
            'large for this phase, and a truncated graph would misdescribe it',
        );
      }
    }
  }

  return edges;
}

function materializeEdges(accumulated: ReadonlyMap<string, EdgeAccumulator>): ArchitectureEdge[] {
  return [...accumulated.values()]
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      kinds: [...edge.kinds].sort(compareStrings),
      specifiers: [...edge.specifiers].sort(compareStrings),
      importCount: edge.importCount,
    }))
    .sort((left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to));
}

/**
 * Iterative Tarjan strongly connected components.
 *
 * Iterative on purpose: a recursive implementation would overflow the stack on a
 * deep dependency chain, and the graph is attacker-influenced data. Each frame
 * holds its own edge cursor, so the recursion depth of the algorithm becomes
 * heap-allocated state.
 *
 * A component of one node is a cycle only when that node imports itself.
 */
export function findCycleComponents(
  nodePaths: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): ArchitectureCycle[] {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: ArchitectureCycle[] = [];
  let counter = 0;

  interface Frame {
    readonly node: string;
    readonly edges: readonly string[];
    next: number;
  }

  for (const root of nodePaths) {
    if (index.has(root)) {
      continue;
    }

    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    const frames: Frame[] = [{ node: root, edges: adjacency.get(root) ?? [], next: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as Frame;

      if (frame.next < frame.edges.length) {
        const target = frame.edges[frame.next] as string;
        frame.next += 1;

        if (!index.has(target)) {
          index.set(target, counter);
          lowLink.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          frames.push({ node: target, edges: adjacency.get(target) ?? [], next: 0 });
        } else if (onStack.has(target)) {
          const targetIndex = index.get(target) as number;
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) as number, targetIndex));
        }
        continue;
      }

      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1] as Frame;
        lowLink.set(
          parent.node,
          Math.min(lowLink.get(parent.node) as number, lowLink.get(frame.node) as number),
        );
      }

      if (lowLink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) {
            break;
          }
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) {
            break;
          }
        }
        const isSelfLoop =
          component.length === 1 &&
          (adjacency.get(component[0] as string) ?? []).includes(component[0] as string);
        if (component.length > 1 || isSelfLoop) {
          cycles.push({
            nodes: [...component].sort(compareStrings),
            selfLoop: component.length === 1,
          });
        }
      }
    }
  }

  // Largest cycles first, then lexicographic: a stable, reviewable order.
  return cycles.sort((left, right) => {
    if (left.nodes.length !== right.nodes.length) {
      return right.nodes.length - left.nodes.length;
    }
    return compareStrings(left.nodes[0] ?? '', right.nodes[0] ?? '');
  });
}

function sortedEvidence(refs: Iterable<ArchitectureEdgeRef>): ArchitectureEdgeRef[] {
  const seen = new Map<string, ArchitectureEdgeRef>();
  for (const ref of refs) {
    seen.set(edgeKey(ref.from, ref.to), ref);
  }
  return [...seen.entries()]
    .sort((left, right) => compareStrings(left[0], right[0]))
    .map(([, ref]) => ref);
}

/**
 * Derive the architecture model for one analysis.
 *
 * @throws DomainError `architecture_invalid_analysis` when the analysis points at
 * a file it does not contain, and `architecture_limit_exceeded` when a graph or
 * finding bound is exceeded. It never returns a partial model.
 */
export function buildArchitecture(
  analysis: AnalysisSnapshot,
  options: BuildArchitectureOptions = {},
): ArchitectureSnapshot {
  const limits: ArchitectureLimits = { ...DEFAULT_ARCHITECTURE_LIMITS, ...options.limits };
  const thresholds: ArchitectureThresholds = {
    ...DEFAULT_ARCHITECTURE_THRESHOLDS,
    ...options.thresholds,
  };

  const knownPaths = new Set(analysis.files.map((file) => file.path));
  if (knownPaths.size > limits.maxNodes) {
    throw new DomainError(
      'architecture_limit_exceeded',
      `Analysis ${analysis.analysisId} has ${knownPaths.size} files, above the ` +
        `${limits.maxNodes}-node architecture limit`,
    );
  }

  const accumulated = collectEdges(analysis, knownPaths, limits);
  const edges = materializeEdges(accumulated);

  // Fan-in and fan-out count *distinct other files*. A self-import is a real edge
  // and a real cycle, but it is not a dependency on another file, so it must not
  // inflate either count — it is reported separately (VA002).
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.from === edge.to) {
      continue;
    }
    const targets = outgoing.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    outgoing.set(edge.from, targets);

    const sources = incoming.get(edge.to) ?? new Set<string>();
    sources.add(edge.from);
    incoming.set(edge.to, sources);
  }

  const nodes: ArchitectureNode[] = analysis.files
    .map((file) => {
      const fanIn = (incoming.get(file.path) ?? new Set<string>()).size;
      const fanOut = (outgoing.get(file.path) ?? new Set<string>()).size;
      const hasSelfLoop = accumulated.has(edgeKey(file.path, file.path));
      return {
        path: file.path,
        moduleId: moduleIdForPath(file.path),
        language: file.language,
        fanIn,
        fanOut,
        isolated: fanIn === 0 && fanOut === 0 && !hasSelfLoop,
      };
    })
    .sort((left, right) => compareStrings(left.path, right.path));

  const moduleFiles = new Map<string, string[]>();
  for (const node of nodes) {
    const files = moduleFiles.get(node.moduleId) ?? [];
    files.push(node.path);
    moduleFiles.set(node.moduleId, files);
  }
  if (moduleFiles.size > limits.maxModules) {
    throw new DomainError(
      'architecture_limit_exceeded',
      `Architecture graph exceeds the ${limits.maxModules}-module limit`,
    );
  }

  const moduleOutgoing = new Map<string, Set<string>>();
  const moduleIncoming = new Map<string, Set<string>>();
  for (const edge of edges) {
    const fromModule = moduleIdForPath(edge.from);
    const toModule = moduleIdForPath(edge.to);
    if (fromModule === toModule) {
      continue;
    }
    const targets = moduleOutgoing.get(fromModule) ?? new Set<string>();
    targets.add(toModule);
    moduleOutgoing.set(fromModule, targets);

    const sources = moduleIncoming.get(toModule) ?? new Set<string>();
    sources.add(fromModule);
    moduleIncoming.set(toModule, sources);
  }

  // A module is "isolated" only when the project has more than one module: in a
  // single-module project nothing is disconnected from anything, and calling the
  // only module isolated would be noise dressed as a finding.
  const moduleCount = moduleFiles.size;
  const modules: ArchitectureModule[] = [...moduleFiles.entries()]
    .map(([id, files]) => {
      const fanIn = (moduleIncoming.get(id) ?? new Set<string>()).size;
      const fanOut = (moduleOutgoing.get(id) ?? new Set<string>()).size;
      return {
        id,
        files: [...files].sort(compareStrings),
        fanIn,
        fanOut,
        isolated: moduleCount > 1 && fanIn === 0 && fanOut === 0,
      };
    })
    .sort((left, right) => compareStrings(left.id, right.id));

  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    const targets = [...(outgoing.get(node.path) ?? new Set<string>())].sort(compareStrings);
    const selfLoop = accumulated.has(edgeKey(node.path, node.path)) ? [node.path] : [];
    adjacency.set(node.path, [...selfLoop, ...targets].sort(compareStrings));
  }
  const cycles = findCycleComponents(
    nodes.map((node) => node.path),
    adjacency,
  );

  const findings: ArchitectureFinding[] = [];

  // VA001 — circular dependencies. The cycle is a fact about imports; the finding
  // says exactly that and nothing about runtime behaviour.
  for (const cycle of cycles) {
    if (cycle.selfLoop) {
      continue;
    }
    const members = new Set(cycle.nodes);
    const evidence = sortedEvidence(
      edges
        .filter((edge) => members.has(edge.from) && members.has(edge.to))
        .map((edge) => ({ from: edge.from, to: edge.to })),
    );
    findings.push({
      ruleId: ARCHITECTURE_RULES.circularDependency,
      severity: 'warning',
      certainty: 'certain',
      nodes: cycle.nodes,
      modules: [],
      message:
        `${cycle.nodes.length} files form a circular dependency: each can reach the others by ` +
        'following internal imports. This is a fact about the import graph; it does not by ' +
        'itself mean the code fails, loops or misbehaves at runtime.',
      evidence,
    });
  }

  // VA002 — a file importing itself.
  for (const node of nodes) {
    if (!accumulated.has(edgeKey(node.path, node.path))) {
      continue;
    }
    findings.push({
      ruleId: ARCHITECTURE_RULES.selfImport,
      severity: 'warning',
      certainty: 'certain',
      nodes: [node.path],
      modules: [],
      message:
        'This file imports itself. The import edge exists in the parsed source; whether it is ' +
        'intended, and what it does at runtime, is outside what an import graph can tell.',
      evidence: [{ from: node.path, to: node.path }],
    });
  }

  // VA003 / VA004 — fan-out and fan-in. Measured counts; the threshold is the
  // heuristic part, which is why these are `conditional`.
  for (const node of nodes) {
    if (node.fanOut >= thresholds.fanOut) {
      const evidence = sortedEvidence(
        edges.filter((edge) => edge.from === node.path).map((edge) => ({ from: edge.from, to: edge.to })),
      );
      findings.push({
        ruleId: ARCHITECTURE_RULES.highFanOut,
        severity: 'info',
        certainty: 'conditional',
        nodes: [node.path],
        modules: [],
        message:
          `This file imports ${node.fanOut} other internal files, at or above the configured ` +
          `fan-out threshold of ${thresholds.fanOut}. The count is measured; that a high ` +
          'fan-out is a problem is a heuristic, not a rule.',
        evidence,
      });
    }
    if (node.fanIn >= thresholds.fanIn) {
      const evidence = sortedEvidence(
        edges.filter((edge) => edge.to === node.path).map((edge) => ({ from: edge.from, to: edge.to })),
      );
      findings.push({
        ruleId: ARCHITECTURE_RULES.highFanIn,
        severity: 'info',
        certainty: 'conditional',
        nodes: [node.path],
        modules: [],
        message:
          `This file is imported by ${node.fanIn} other internal files, at or above the ` +
          `configured fan-in threshold of ${thresholds.fanIn}. Being widely depended on is a ` +
          'measured fact; calling it a bottleneck would be an interpretation.',
        evidence,
      });
    }
  }

  // VA005 — files with no internal dependency in either direction.
  for (const node of nodes) {
    if (!node.isolated) {
      continue;
    }
    findings.push({
      ruleId: ARCHITECTURE_RULES.isolatedFile,
      severity: 'info',
      certainty: 'certain',
      nodes: [node.path],
      modules: [],
      message:
        'Nothing analysed imports this file, and it imports nothing analysed. For an entry ' +
        'point or a test that is expected; the graph cannot tell which it is.',
      evidence: [],
    });
  }

  // VA006 — modules with no cross-module dependency at all.
  for (const module of modules) {
    if (!module.isolated) {
      continue;
    }
    findings.push({
      ruleId: ARCHITECTURE_RULES.isolatedModule,
      severity: 'info',
      certainty: 'certain',
      nodes: [],
      modules: [module.id],
      message:
        `Module ${module.id} has no imports to or from any other module in this project. Its ` +
        'files may still depend on each other.',
      evidence: [],
    });
  }

  // VA007 — concentration between one pair of modules.
  const pairCounts = new Map<string, number>();
  for (const edge of edges) {
    const fromModule = moduleIdForPath(edge.from);
    const toModule = moduleIdForPath(edge.to);
    if (fromModule === toModule) {
      continue;
    }
    const key = edgeKey(fromModule, toModule);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + edge.importCount);
  }
  for (const [key, count] of [...pairCounts.entries()].sort((left, right) =>
    compareStrings(left[0], right[0]),
  )) {
    if (count < thresholds.concentration) {
      continue;
    }
    const [fromModule, toModule] = key.split(KEY_SEPARATOR) as [string, string];
    const evidence = sortedEvidence(
      edges
        .filter(
          (edge) =>
            moduleIdForPath(edge.from) === fromModule && moduleIdForPath(edge.to) === toModule,
        )
        .map((edge) => ({ from: edge.from, to: edge.to })),
    );
    findings.push({
      ruleId: ARCHITECTURE_RULES.dependencyConcentration,
      severity: 'info',
      certainty: 'conditional',
      nodes: [],
      modules: [fromModule, toModule],
      message:
        `${fromModule} imports ${toModule} through ${count} import statements between ` +
        `${evidence.length} file pairs, at or above the configured concentration threshold of ` +
        `${thresholds.concentration}. This measures coupling; it is not a claim that the ` +
        'coupling is wrong.',
      evidence,
    });
  }

  if (findings.length > limits.maxFindings) {
    throw new DomainError(
      'architecture_limit_exceeded',
      `Architecture derivation produced ${findings.length} findings, above the ` +
        `${limits.maxFindings}-finding limit; the project is too large for a readable report`,
    );
  }

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
