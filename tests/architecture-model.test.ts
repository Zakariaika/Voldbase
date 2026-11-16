/**
 * The architecture domain model (Phase 2B).
 *
 * These tests are about the *contract*: provenance is recorded, ordering is
 * canonical, every reference is validated, the digest is a function of content
 * only, and no part of the derivation can reach a filesystem.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ARCHITECTURE_ENGINE_VERSION,
  ARCHITECTURE_SCHEMA_VERSION,
  assertArchitectureDigest,
  buildArchitecture,
  cloneArchitectureSnapshot,
  createArchitectureSnapshot,
  DEFAULT_ARCHITECTURE_LIMITS,
  DEFAULT_ARCHITECTURE_THRESHOLDS,
  DomainError,
  type AnalysisSnapshot,
  type ArchitectureSnapshot,
  type CreateArchitectureSnapshotInput,
} from '../src/index.ts';
import {
  analysisFromSpec,
  architectureFromSpec,
  PROJECT_REVISION,
} from './helpers/architecture-fixture.ts';

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

const ANALYSIS_DIGEST = analysisFromSpec({ 'a.ts': [], 'b.ts': [{ to: 'a.ts' }] }).digest;

function validInput(
  overrides: Partial<CreateArchitectureSnapshotInput> = {},
): CreateArchitectureSnapshotInput {
  return {
    analysisId: 'ana-1',
    analysisDigest: ANALYSIS_DIGEST,
    projectId: 'proj-1',
    projectRevision: PROJECT_REVISION,
    limits: DEFAULT_ARCHITECTURE_LIMITS,
    thresholds: DEFAULT_ARCHITECTURE_THRESHOLDS,
    nodes: [
      { path: 'a.ts', moduleId: '.', language: 'typescript', fanIn: 1, fanOut: 0, isolated: false },
      { path: 'b.ts', moduleId: '.', language: 'typescript', fanIn: 0, fanOut: 1, isolated: false },
    ],
    edges: [{ from: 'b.ts', to: 'a.ts', kinds: ['static'], specifiers: ['./a'], importCount: 1 }],
    modules: [{ id: '.', files: ['a.ts', 'b.ts'], fanIn: 0, fanOut: 0, isolated: false }],
    cycles: [],
    findings: [],
    ...overrides,
  };
}

describe('architecture model', () => {
  it('records provenance and derives metrics from the graph', () => {
    const snapshot = createArchitectureSnapshot(validInput());

    assert.equal(snapshot.schemaVersion, ARCHITECTURE_SCHEMA_VERSION);
    assert.equal(snapshot.engineVersion, ARCHITECTURE_ENGINE_VERSION);
    assert.equal(snapshot.analysisId, 'ana-1');
    assert.equal(snapshot.analysisDigest, ANALYSIS_DIGEST);
    assert.equal(snapshot.projectId, 'proj-1');
    assert.equal(snapshot.projectRevision, PROJECT_REVISION);
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);

    assert.deepEqual(snapshot.metrics, {
      nodeCount: 2,
      edgeCount: 1,
      moduleCount: 1,
      internalImportCount: 1,
      isolatedFileCount: 0,
      isolatedModuleCount: 0,
      cycleCount: 0,
      largestCycleSize: 0,
      maxFanIn: 1,
      maxFanOut: 1,
    });
    assert.equal(snapshot.summary.findingCount, 0);
    assert.equal(snapshot.summary.findingsBySeverity.warning, 0);
  });

  it('orders the model canonically and hashes content only', () => {
    const first = createArchitectureSnapshot(validInput());
    const second = createArchitectureSnapshot({
      ...validInput(),
      nodes: [
        { path: 'b.ts', moduleId: '.', language: 'typescript', fanIn: 0, fanOut: 1, isolated: false },
        { path: 'a.ts', moduleId: '.', language: 'typescript', fanIn: 1, fanOut: 0, isolated: false },
      ],
      modules: [{ id: '.', files: ['b.ts', 'a.ts'], fanIn: 0, fanOut: 0, isolated: false }],
      edges: [{ from: 'b.ts', to: 'a.ts', kinds: ['static'], specifiers: ['./a'], importCount: 1 }],
    });

    assert.equal(first.digest, second.digest);
    assert.deepEqual(
      second.nodes.map((node) => node.path),
      ['a.ts', 'b.ts'],
    );
    assert.deepEqual(second.modules[0]?.files, ['a.ts', 'b.ts']);
  });

  it('changes the digest when the graph changes but not when order does', () => {
    const base = createArchitectureSnapshot(validInput());
    const extraEdge = createArchitectureSnapshot(
      validInput({
        edges: [
          { from: 'b.ts', to: 'a.ts', kinds: ['static'], specifiers: ['./a'], importCount: 1 },
          { from: 'a.ts', to: 'b.ts', kinds: ['dynamic'], specifiers: ['./b'], importCount: 1 },
        ],
      }),
    );
    assert.notEqual(base.digest, extraEdge.digest);
  });

  it('rejects an edge that names a file which is not a node', () => {
    assert.throws(
      () =>
        createArchitectureSnapshot(
          validInput({
            edges: [
              { from: 'b.ts', to: 'a.ts', kinds: ['static'], specifiers: ['./a'], importCount: 1 },
              { from: 'b.ts', to: 'ghost.ts', kinds: ['static'], specifiers: ['./ghost'], importCount: 1 },
            ],
          }),
        ),
      isDomainError('invalid_architecture_snapshot'),
    );
  });

  it('rejects a module that claims a file it does not list', () => {
    assert.throws(
      () =>
        createArchitectureSnapshot(
          validInput({
            modules: [{ id: '.', files: ['a.ts'], fanIn: 0, fanOut: 0, isolated: false }],
          }),
        ),
      isDomainError('invalid_architecture_snapshot'),
    );
  });

  it('rejects a finding with no subject and a finding citing an absent edge', () => {
    assert.throws(
      () =>
        createArchitectureSnapshot(
          validInput({
            findings: [
              {
                ruleId: 'VA005',
                severity: 'info',
                certainty: 'certain',
                nodes: [],
                modules: [],
                message: 'nothing to see',
                evidence: [],
              },
            ],
          }),
        ),
      isDomainError('invalid_architecture_snapshot'),
    );

    assert.throws(
      () =>
        createArchitectureSnapshot(
          validInput({
            findings: [
              {
                ruleId: 'VA001',
                severity: 'warning',
                certainty: 'certain',
                nodes: ['a.ts'],
                modules: [],
                message: 'a cycle',
                evidence: [{ from: 'a.ts', to: 'b.ts' }],
              },
            ],
          }),
        ),
      isDomainError('invalid_architecture_snapshot'),
    );
  });

  it('rejects a finding with an unknown rule id', () => {
    assert.throws(
      () =>
        createArchitectureSnapshot(
          validInput({
            findings: [
              {
                ruleId: 'XX001',
                severity: 'info',
                certainty: 'certain',
                nodes: ['a.ts'],
                modules: [],
                message: 'wrong namespace',
                evidence: [],
              },
            ],
          }),
        ),
      isDomainError('invalid_architecture_snapshot'),
    );
  });

  it('rejects an unsupported schema version', () => {
    assert.throws(
      () => createArchitectureSnapshot(validInput({ schemaVersion: 99 })),
      isDomainError('architecture_unsupported_schema'),
    );
  });

  it('enforces the resource limits', () => {
    assert.throws(
      () =>
        createArchitectureSnapshot(
          validInput({ limits: { ...DEFAULT_ARCHITECTURE_LIMITS, maxNodes: 1 } }),
        ),
      isDomainError('architecture_limit_exceeded'),
    );
    assert.throws(
      () =>
        createArchitectureSnapshot(
          validInput({
            limits: { ...DEFAULT_ARCHITECTURE_LIMITS, maxEdges: 1 },
            edges: [
              { from: 'b.ts', to: 'a.ts', kinds: ['static'], specifiers: ['./a'], importCount: 1 },
              { from: 'a.ts', to: 'b.ts', kinds: ['dynamic'], specifiers: ['./b'], importCount: 1 },
            ],
          }),
        ),
      isDomainError('architecture_limit_exceeded'),
    );
  });

  it('detects a tampered model', () => {
    const snapshot = createArchitectureSnapshot(validInput());
    assert.doesNotThrow(() => assertArchitectureDigest(snapshot));

    const tampered = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) =>
        node.path === 'a.ts' ? { ...node, fanIn: 99 } : node,
      ),
    } satisfies ArchitectureSnapshot;

    assert.throws(() => assertArchitectureDigest(tampered), isDomainError('architecture_corrupted'));
  });

  it('clones without aliasing the caller', () => {
    const snapshot = architectureFromSpec({ 'src/a.ts': [], 'src/b.ts': [{ to: 'src/a.ts' }] });
    const clone = cloneArchitectureSnapshot(snapshot);

    assert.notEqual(clone, snapshot);
    assert.deepEqual(clone, snapshot);
    assert.notEqual(clone.nodes, snapshot.nodes);
    assert.notEqual(clone.nodes[0], snapshot.nodes[0]);
  });

  it('refuses an analysis whose import points at a file it does not contain', () => {
    const analysis = analysisFromSpec({ 'src/a.ts': [] });
    // Hand-built: the analysis domain refuses this shape, so a derivation that
    // meets it is looking at a snapshot that did not come through validation.
    const broken = {
      ...analysis,
      files: [
        {
          ...analysis.files[0],
          imports: [
            {
              specifier: './gone',
              kind: 'static',
              typeOnly: false,
              resolution: 'resolved-relative',
              resolvedPath: 'src/gone.ts',
              location: { line: 1, column: 1 },
            },
          ],
        },
      ],
    } as AnalysisSnapshot;

    assert.throws(() => buildArchitecture(broken), isDomainError('architecture_invalid_analysis'));
  });

  it('derives a model from the analysis alone, with no project on disk', () => {
    // The fixture only exists in memory; nothing here ever created src/a.ts.
    const analysis = analysisFromSpec({ 'src/a.ts': [], 'src/b.ts': [{ to: 'src/a.ts' }] });
    const architecture = buildArchitecture(analysis);

    assert.equal(architecture.nodes.length, 2);
    assert.equal(architecture.edges.length, 1);
    assert.equal(architecture.digest.length, 64);
  });

  it('imports no filesystem, process or network API in its own source', async () => {
    const modules = [
      '../src/domain/architecture.ts',
      '../src/application/architecture-builder.ts',
      '../src/application/architecture-service.ts',
    ];
    for (const modulePath of modules) {
      const source = await fs.readFile(new URL(modulePath, import.meta.url), 'utf8');
      for (const forbidden of ['node:fs', 'node:child_process', 'node:net', 'node:http']) {
        assert.equal(
          source.includes(forbidden),
          false,
          `${modulePath} must not import ${forbidden}`,
        );
      }
    }
  });
});
