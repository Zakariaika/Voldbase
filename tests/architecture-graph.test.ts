/**
 * File-level graph construction (Phase 2B).
 *
 * The graph is built from exactly one thing: imports the analysis classified as
 * `resolved-relative`. Everything else — packages, unresolved aliases, paths that
 * escape the project — must stay out of the internal graph.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildArchitecture } from '../src/index.ts';
import {
  analysisWith,
  architectureFromSpec,
  filesFromSpec,
  findingsFor,
  moduleById,
  nodeByPath,
  type GraphSpec,
} from './helpers/architecture-fixture.ts';

describe('architecture graph', () => {
  it('produces an empty, valid model for an analysis with no files', () => {
    const snapshot = architectureFromSpec({});

    assert.deepEqual(snapshot.nodes, []);
    assert.deepEqual(snapshot.edges, []);
    assert.deepEqual(snapshot.modules, []);
    assert.deepEqual(snapshot.cycles, []);
    assert.deepEqual(snapshot.findings, []);
    assert.equal(snapshot.metrics.nodeCount, 0);
    assert.equal(snapshot.digest.length, 64);
  });

  it('records a single file with no imports as isolated', () => {
    const snapshot = architectureFromSpec({ 'src/a.ts': [] });

    assert.equal(snapshot.nodes.length, 1);
    assert.equal(snapshot.edges.length, 0);
    assert.equal(nodeByPath(snapshot, 'src/a.ts').isolated, true);
    assert.equal(findingsFor(snapshot, 'VA005').length, 1);
  });

  it('never turns external, unresolved or out-of-root imports into edges', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [
        { specifier: 'express', resolution: 'external' },
        { specifier: 'node:fs', resolution: 'external' },
        { specifier: './missing', resolution: 'unresolved-relative' },
        // Assembled from parts: the test only needs a path that escapes the root.
        { specifier: ['..', '..', '..', 'etc', 'passwd'].join('/'), resolution: 'outside-root' },
      ],
    });

    assert.deepEqual(snapshot.edges, []);
    assert.equal(snapshot.nodes.length, 1);
    assert.equal(nodeByPath(snapshot, 'src/a.ts').fanOut, 0);
  });

  it('collapses duplicate imports into one edge without losing evidence', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [],
      'src/b.ts': [
        { to: 'src/a.ts', specifier: './a' },
        { to: 'src/a.ts', specifier: './a', kind: 'dynamic' },
        { to: 'src/a.ts', specifier: './a.ts' },
      ],
    });

    assert.equal(snapshot.edges.length, 1);
    const edge = snapshot.edges[0];
    assert.deepEqual(edge, {
      from: 'src/b.ts',
      to: 'src/a.ts',
      kinds: ['dynamic', 'static'],
      specifiers: ['./a', './a.ts'],
      importCount: 3,
    });
    assert.equal(snapshot.metrics.internalImportCount, 3);
    assert.equal(nodeByPath(snapshot, 'src/b.ts').fanOut, 1);
    assert.equal(nodeByPath(snapshot, 'src/a.ts').fanIn, 1);
  });

  it('handles a self-import explicitly: an edge, a cycle, but no fan-in or fan-out', () => {
    const snapshot = architectureFromSpec({ 'src/a.ts': [{ to: 'src/a.ts' }] });

    assert.equal(snapshot.edges.length, 1);
    assert.equal(nodeByPath(snapshot, 'src/a.ts').fanIn, 0);
    assert.equal(nodeByPath(snapshot, 'src/a.ts').fanOut, 0);
    assert.equal(nodeByPath(snapshot, 'src/a.ts').isolated, false);
    assert.deepEqual(snapshot.cycles, [{ nodes: ['src/a.ts'], selfLoop: true }]);
    assert.equal(snapshot.metrics.largestCycleSize, 1);

    const [finding] = findingsFor(snapshot, 'VA002');
    assert.equal(finding?.certainty, 'certain');
    assert.deepEqual(finding?.evidence, [{ from: 'src/a.ts', to: 'src/a.ts' }]);
    assert.equal(findingsFor(snapshot, 'VA001').length, 0);
  });

  it('detects a two-file circular dependency once', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [{ to: 'src/b.ts' }],
      'src/b.ts': [{ to: 'src/a.ts' }],
    });

    assert.deepEqual(snapshot.cycles, [{ nodes: ['src/a.ts', 'src/b.ts'], selfLoop: false }]);
    const cycles = findingsFor(snapshot, 'VA001');
    assert.equal(cycles.length, 1);
    assert.equal(cycles[0]?.severity, 'warning');
    assert.equal(cycles[0]?.certainty, 'certain');
    assert.deepEqual(cycles[0]?.nodes, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(cycles[0]?.evidence, [
      { from: 'src/a.ts', to: 'src/b.ts' },
      { from: 'src/b.ts', to: 'src/a.ts' },
    ]);
    assert.match(cycles[0]?.message ?? '', /does not by itself mean/);
  });

  it('finds a strongly connected component and leaves its consumers outside it', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [{ to: 'src/b.ts' }],
      'src/b.ts': [{ to: 'src/c.ts' }],
      'src/c.ts': [{ to: 'src/a.ts' }],
      'src/entry.ts': [{ to: 'src/a.ts' }],
    });

    assert.equal(snapshot.cycles.length, 1);
    assert.deepEqual(snapshot.cycles[0]?.nodes, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    assert.equal(snapshot.cycles[0]?.selfLoop, false);

    const finding = findingsFor(snapshot, 'VA001')[0];
    assert.equal(finding?.nodes.includes('src/entry.ts'), false);
    // Only edges inside the component are evidence for the cycle.
    assert.deepEqual(finding?.evidence, [
      { from: 'src/a.ts', to: 'src/b.ts' },
      { from: 'src/b.ts', to: 'src/c.ts' },
      { from: 'src/c.ts', to: 'src/a.ts' },
    ]);
  });

  it('reports every strongly connected component, sorted deterministically', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [{ to: 'src/b.ts' }],
      'src/b.ts': [{ to: 'src/a.ts' }],
      'lib/c.ts': [{ to: 'lib/d.ts' }],
      'lib/d.ts': [{ to: 'lib/c.ts' }],
    });

    assert.deepEqual(
      snapshot.cycles.map((cycle) => cycle.nodes),
      [
        ['lib/c.ts', 'lib/d.ts'],
        ['src/a.ts', 'src/b.ts'],
      ],
    );
    assert.equal(findingsFor(snapshot, 'VA001').length, 2);
  });

  it('keeps disconnected components apart', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [{ to: 'src/b.ts' }],
      'src/b.ts': [],
      'src/c.ts': [],
    });

    assert.equal(snapshot.edges.length, 1);
    assert.equal(nodeByPath(snapshot, 'src/c.ts').isolated, true);
    assert.equal(nodeByPath(snapshot, 'src/a.ts').isolated, false);
    assert.equal(snapshot.cycles.length, 0);
    assert.equal(findingsFor(snapshot, 'VA001').length, 0);
  });

  it('groups root files into the root module and nested files by directory', () => {
    const snapshot = architectureFromSpec({
      'index.ts': [{ to: 'src/app.ts' }],
      'src/app.ts': [{ to: 'src/lib/util.ts' }],
      'src/lib/util.ts': [],
    });

    assert.deepEqual(
      snapshot.modules.map((module) => module.id),
      ['.', 'src', 'src/lib'],
    );
    assert.deepEqual(moduleById(snapshot, '.').files, ['index.ts']);
    assert.equal(moduleById(snapshot, '.').fanOut, 1);
    assert.equal(moduleById(snapshot, '.').fanIn, 0);
    assert.equal(moduleById(snapshot, 'src').fanIn, 1);
    assert.equal(moduleById(snapshot, 'src').fanOut, 1);
    assert.equal(moduleById(snapshot, 'src/lib').fanIn, 1);
    assert.equal(moduleById(snapshot, 'src/lib').fanOut, 0);
    for (const module of snapshot.modules) {
      assert.equal(module.isolated, false);
    }
  });

  it('produces the same digest regardless of input ordering', () => {
    const spec: GraphSpec = {
      'src/a.ts': [{ to: 'src/b.ts' }, { to: 'src/c.ts' }],
      'src/b.ts': [{ to: 'src/a.ts' }],
      'src/c.ts': [],
    };
    const files = filesFromSpec(spec);

    // Identical files and identical import metadata, delivered in the opposite
    // order: a snapshot is a set, so the derivation must not depend on order.
    const forward = buildArchitecture(analysisWith(files));
    const reversed = buildArchitecture(analysisWith([...files].reverse()));

    assert.equal(forward.digest, reversed.digest);
    assert.deepEqual(forward.nodes, reversed.nodes);
    assert.deepEqual(forward.edges, reversed.edges);
    assert.deepEqual(forward.findings, reversed.findings);
  });
});
