/**
 * In-memory experiment isolation (Phase 2C.6).
 *
 * `readonly` is a compile-time promise only. The in-memory adapter must therefore
 * copy experiments on the way in and on the way out, or a caller could mutate
 * the stored definition after validation and hand out aliases of stale state.
 * These tests exercise the storage boundary directly, including nested `steps`
 * and `expectedObservations`, and confirm revision integrity still applies.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asExperimentId,
  asProjectId,
  createExperiment,
  DomainError,
  InMemoryExperimentRepository,
  reviseExperiment,
  type Experiment,
} from '../src/index.ts';

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

function buildExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return createExperiment({
    id: asExperimentId('exp-1'),
    projectId: asProjectId('proj-1'),
    name: 'suite passes',
    hypothesis: 'npm test exits 0',
    steps: [{ index: 0, description: 'run tests', command: 'npm test' }],
    determinism: 'deterministic',
    expectedObservations: ['exit code 0'],
    createdAt: new Date('2026-05-01T00:00:00Z'),
    ...overrides,
  });
}

/**
 * Test-only view with mutability restored. Runtime objects are mutable whatever
 * the type says, and these tests exist to prove storage does not rely on the
 * type to keep its copy intact.
 */
interface MutableExperiment {
  name: string;
  hypothesis: string;
  steps: { index: number; description: string; command?: string }[];
  expectedObservations: string[];
  createdAt: Date;
  definitionVersion: number;
}

function asMutable(experiment: Experiment): MutableExperiment {
  return experiment as unknown as MutableExperiment;
}

describe('in-memory experiment isolation', () => {
  it('does not store the caller object graph', async () => {
    const repository = new InMemoryExperimentRepository();
    const experiment = buildExperiment();
    await repository.save(experiment);

    const caller = asMutable(experiment);
    caller.name = 'rewritten name';
    caller.hypothesis = 'rewritten hypothesis';
    caller.steps[0]!.description = 'rewritten step';
    caller.steps[0]!.command = 'rm -rf build';
    caller.steps.push({ index: 1, description: 'injected step' });
    caller.expectedObservations[0] = 'rewritten expectation';
    caller.expectedObservations.push('injected expectation');
    caller.createdAt.setUTCFullYear(1999);

    const stored = await repository.findById(asExperimentId('exp-1'));
    assert.ok(stored !== undefined);
    assert.equal(stored.name, 'suite passes');
    assert.equal(stored.hypothesis, 'npm test exits 0');
    assert.deepEqual(stored.steps, [
      { index: 0, description: 'run tests', command: 'npm test' },
    ]);
    assert.deepEqual(stored.expectedObservations, ['exit code 0']);
    assert.deepEqual(stored.createdAt, new Date('2026-05-01T00:00:00Z'));
  });

  it('returns a detached experiment from findById()', async () => {
    const repository = new InMemoryExperimentRepository();
    await repository.save(buildExperiment());

    const first = await repository.findById(asExperimentId('exp-1'));
    assert.ok(first !== undefined);
    const mutable = asMutable(first);
    mutable.hypothesis = 'mutated by a reader';
    mutable.steps[0]!.description = 'mutated step';
    mutable.expectedObservations.push('mutated expectation');

    const second = await repository.findById(asExperimentId('exp-1'));
    assert.ok(second !== undefined);
    assert.equal(second.hypothesis, 'npm test exits 0');
    assert.deepEqual(second.steps, [
      { index: 0, description: 'run tests', command: 'npm test' },
    ]);
    assert.deepEqual(second.expectedObservations, ['exit code 0']);

    // Successive reads are separate objects, not views of one record.
    assert.notEqual(second, first);
    assert.notEqual(second.steps, first.steps);
    assert.notEqual(second.steps[0], first.steps[0]);
    assert.notEqual(second.expectedObservations, first.expectedObservations);
    assert.notEqual(second.createdAt, first.createdAt);
  });

  it('returns detached experiments from listByProject()', async () => {
    const repository = new InMemoryExperimentRepository();
    await repository.save(buildExperiment());
    await repository.save(
      buildExperiment({ id: asExperimentId('exp-2'), name: 'a second experiment' }),
    );
    await repository.save(
      buildExperiment({ id: asExperimentId('exp-3'), projectId: asProjectId('proj-2') }),
    );

    const listed = await repository.listByProject(asProjectId('proj-1'));
    assert.deepEqual(
      listed.map((item) => item.id),
      ['exp-1', 'exp-2'],
    );

    const mutable = asMutable(listed[0]!);
    mutable.name = 'mutated through a list';
    mutable.expectedObservations[0] = 'mutated expectation';
    listed.pop();
    listed.push(buildExperiment({ id: asExperimentId('exp-4') }));

    const relisted = await repository.listByProject(asProjectId('proj-1'));
    assert.deepEqual(
      relisted.map((item) => item.id),
      ['exp-1', 'exp-2'],
    );
    assert.equal(relisted[0]!.name, 'suite passes');
    assert.deepEqual(relisted[0]!.expectedObservations, ['exit code 0']);
    assert.notEqual(relisted[0], listed[0]);
    assert.notEqual(relisted[0]!.steps[0], listed[0]!.steps[0]);
    assert.deepEqual(await repository.listByProject(asProjectId('proj-2')), [
      buildExperiment({ id: asExperimentId('exp-3'), projectId: asProjectId('proj-2') }),
    ]);
  });

  it('isolates nested steps and expected observations', async () => {
    const repository = new InMemoryExperimentRepository();
    await repository.save(
      buildExperiment({
        steps: [
          { index: 0, description: 'run tests', command: 'npm test' },
          { index: 1, description: 'inspect the report' },
        ],
        expectedObservations: ['exit code 0', 'no skipped tests'],
      }),
    );

    const read = await repository.findById(asExperimentId('exp-1'));
    assert.ok(read !== undefined);
    const mutable = asMutable(read);
    mutable.steps.reverse();
    mutable.steps[0]!.description = 'rewritten';
    mutable.steps.pop();
    mutable.expectedObservations.length = 0;

    const reread = await repository.findById(asExperimentId('exp-1'));
    assert.ok(reread !== undefined);
    assert.deepEqual(reread.steps, [
      { index: 0, description: 'run tests', command: 'npm test' },
      { index: 1, description: 'inspect the report' },
    ]);
    assert.deepEqual(reread.expectedObservations, ['exit code 0', 'no skipped tests']);
  });

  it('rejects a caller-mutated experiment that never passed through reviseExperiment()', async () => {
    const repository = new InMemoryExperimentRepository();
    const experiment = buildExperiment();
    await repository.save(experiment);

    // This mutation used to reach the stored record, because save() kept the
    // caller's references. Now only the caller's copy changes.
    asMutable(experiment).hypothesis = 'silently rewritten';

    await assert.rejects(
      () => repository.save(experiment),
      isDomainError('definition_version_mismatch'),
    );
    assert.equal(
      (await repository.findById(asExperimentId('exp-1')))?.hypothesis,
      'npm test exits 0',
    );
  });

  it('still enforces revision integrity at the storage boundary', async () => {
    const repository = new InMemoryExperimentRepository();
    const experiment = buildExperiment();
    await repository.save(experiment);

    await assert.rejects(
      () => repository.save({ ...experiment, hypothesis: 'silently rewritten' }),
      isDomainError('definition_version_mismatch'),
    );
    await assert.rejects(
      () => repository.save({ ...experiment, definitionVersion: 2 }),
      isDomainError('definition_version_mismatch'),
    );
    assert.equal(
      (await repository.findById(asExperimentId('exp-1')))?.definitionVersion,
      1,
    );

    // A valid revision is still accepted and stored.
    await repository.save(reviseExperiment(experiment, { hypothesis: 'a real change' }));
    const stored = await repository.findById(asExperimentId('exp-1'));
    assert.equal(stored?.definitionVersion, 2);
    assert.equal(stored?.hypothesis, 'a real change');
  });
});
