/**
 * Architecture metrics and heuristic findings (Phase 2B).
 *
 * The point of these tests is that a *measurement* and an *interpretation* stay
 * separate: counts are exact, and every threshold-based finding is marked
 * `conditional` and says so in its message.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DomainError } from '../src/index.ts';
import {
  architectureFromSpec,
  findingsFor,
  moduleById,
  nodeByPath,
} from './helpers/architecture-fixture.ts';

function isDomainError(code: string) {
  return (error: unknown): error is DomainError => error instanceof DomainError && error.code === code;
}

describe('architecture metrics', () => {
  it('counts distinct importers, not import statements', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [],
      'src/b.ts': [{ to: 'src/a.ts' }, { to: 'src/a.ts', kind: 'dynamic' }],
      'src/c.ts': [{ to: 'src/a.ts' }],
    });

    assert.equal(nodeByPath(snapshot, 'src/a.ts').fanIn, 2);
    assert.equal(nodeByPath(snapshot, 'src/b.ts').fanOut, 1);
    assert.equal(snapshot.metrics.maxFanIn, 2);
    assert.equal(snapshot.metrics.maxFanOut, 1);
    assert.equal(snapshot.metrics.internalImportCount, 3);
    assert.equal(snapshot.metrics.edgeCount, 2);
  });

  it('counts a file reachable from a cycle consumer once per importer', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [{ to: 'src/shared.ts' }],
      'src/b.ts': [{ to: 'src/shared.ts' }],
      'src/shared.ts': [],
    });

    assert.equal(nodeByPath(snapshot, 'src/shared.ts').fanIn, 2);
    assert.equal(nodeByPath(snapshot, 'src/shared.ts').fanOut, 0);
  });

  it('marks modules isolated only when the project has more than one module', () => {
    const multi = architectureFromSpec({
      'src/a.ts': [],
      'lib/b.ts': [],
    });
    assert.equal(moduleById(multi, 'src').isolated, true);
    assert.equal(moduleById(multi, 'lib').isolated, true);
    assert.equal(findingsFor(multi, 'VA006').length, 2);
    assert.equal(multi.metrics.isolatedModuleCount, 2);

    // One module can never be disconnected from the rest of a project it *is*.
    const single = architectureFromSpec({
      'a.ts': [{ to: 'b.ts' }],
      'b.ts': [],
    });
    assert.equal(single.modules.length, 1);
    assert.equal(single.modules[0]?.isolated, false);
    assert.equal(findingsFor(single, 'VA006').length, 0);
  });

  it('flags high fan-out at or above the configured threshold, as a heuristic', () => {
    const spec = {
      'src/hub.ts': [
        { to: 'src/a.ts' },
        { to: 'src/b.ts' },
        { to: 'src/c.ts' },
      ],
      'src/a.ts': [],
      'src/b.ts': [],
      'src/c.ts': [],
    };

    const flagged = architectureFromSpec(spec, { thresholds: { fanOut: 3 } });
    const [finding] = findingsFor(flagged, 'VA003');
    assert.equal(finding?.severity, 'info');
    assert.equal(finding?.certainty, 'conditional');
    assert.deepEqual(finding?.nodes, ['src/hub.ts']);
    assert.match(finding?.message ?? '', /heuristic, not a rule/);
    assert.equal(finding?.evidence.length, 3);

    const quiet = architectureFromSpec(spec, { thresholds: { fanOut: 4 } });
    assert.equal(findingsFor(quiet, 'VA003').length, 0);
  });

  it('flags high fan-in at or above the configured threshold, as a heuristic', () => {
    const flagged = architectureFromSpec(
      {
        'src/a.ts': [{ to: 'src/shared.ts' }],
        'src/b.ts': [{ to: 'src/shared.ts' }],
        'src/shared.ts': [],
      },
      { thresholds: { fanIn: 2 } },
    );

    const [finding] = findingsFor(flagged, 'VA004');
    assert.equal(finding?.certainty, 'conditional');
    assert.deepEqual(finding?.nodes, ['src/shared.ts']);
    assert.equal(finding?.evidence.length, 2);
  });

  it('flags cross-module dependency concentration with the edges as evidence', () => {
    const spec: Record<string, { to: string }[]> = { 'lib/target.ts': [] };
    for (let index = 0; index < 12; index += 1) {
      spec[`src/m${index}.ts`] = [{ to: 'lib/target.ts' }];
    }

    const snapshot = architectureFromSpec(spec, { thresholds: { concentration: 10 } });
    const [finding] = findingsFor(snapshot, 'VA007');
    assert.equal(finding?.certainty, 'conditional');
    assert.deepEqual(finding?.modules, ['lib', 'src']);
    assert.equal(finding?.evidence.length, 12);
    assert.match(finding?.message ?? '', /not a claim that the coupling is wrong/);

    const quiet = architectureFromSpec(spec, { thresholds: { concentration: 13 } });
    assert.equal(findingsFor(quiet, 'VA007').length, 0);
  });

  it('reports cycle metrics', () => {
    const snapshot = architectureFromSpec({
      'src/a.ts': [{ to: 'src/b.ts' }],
      'src/b.ts': [{ to: 'src/c.ts' }],
      'src/c.ts': [{ to: 'src/a.ts' }],
      'src/solo.ts': [],
    });

    assert.equal(snapshot.metrics.cycleCount, 1);
    assert.equal(snapshot.metrics.largestCycleSize, 3);
    assert.equal(snapshot.metrics.isolatedFileCount, 1);
  });

  it('fails explicitly when a resource limit is exceeded', () => {
    const many = {
      'src/a.ts': [],
      'src/b.ts': [],
      'src/c.ts': [],
    };

    assert.throws(
      () => architectureFromSpec(many, { limits: { maxNodes: 2 } }),
      isDomainError('architecture_limit_exceeded'),
    );
    assert.throws(
      () => architectureFromSpec(many, { limits: { maxFindings: 2 } }),
      isDomainError('architecture_limit_exceeded'),
    );
    assert.throws(
      () => architectureFromSpec({ 'a.ts': [], 'src/b.ts': [] }, { limits: { maxModules: 1 } }),
      isDomainError('architecture_limit_exceeded'),
    );
  });

  it('records the limits and thresholds it was derived with', () => {
    const snapshot = architectureFromSpec({ 'src/a.ts': [] }, {
      limits: { maxNodes: 42 },
      thresholds: { fanIn: 3, fanOut: 4, concentration: 5 },
    });

    assert.equal(snapshot.limits.maxNodes, 42);
    assert.equal(snapshot.limits.maxEdges, 20_000);
    assert.deepEqual(snapshot.thresholds, { fanIn: 3, fanOut: 4, concentration: 5 });
  });
});
