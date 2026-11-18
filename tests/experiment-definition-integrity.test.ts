/**
 * Experiment definition integrity (Phase 2C.5).
 *
 * An experiment is editable, but its history is not: runs pin the definition
 * hash they executed. These tests cover revision semantics (`definitionVersion`
 * moves exactly once per real change and never for a no-op), repository
 * enforcement against a version that disagrees with the definition, and the
 * guarantee that revising an experiment leaves existing runs untouched.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  asExperimentId,
  asProjectId,
  asRunId,
  createExperiment,
  createRun,
  DomainError,
  experimentDefinitionHash,
  experimentStorageFilePath,
  InMemoryExperimentRepository,
  JsonExperimentRepository,
  JsonRunRepository,
  reviseExperiment,
  runStorageFilePath,
  type EnvironmentManifest,
  type Experiment,
} from '../src/index.ts';

const ENVIRONMENT: EnvironmentManifest = {
  os: 'linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: '22.18.0',
};

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

async function makeHome(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2c5-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function experimentRepository(filePath: string): JsonExperimentRepository {
  return new JsonExperimentRepository({
    filePath,
    lock: { timeoutMs: 2_000, pollIntervalMs: 10, staleMs: 5_000 },
  });
}

function runRepository(filePath: string): JsonRunRepository {
  return new JsonRunRepository({
    filePath,
    lock: { timeoutMs: 2_000, pollIntervalMs: 10, staleMs: 5_000 },
  });
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

describe('experiment revisions', () => {
  it('keeps the version and hash when the definition is unchanged', () => {
    const experiment = buildExperiment();

    const revised = reviseExperiment(experiment, {
      name: experiment.name,
      hypothesis: experiment.hypothesis,
      steps: experiment.steps.map((step) => ({ ...step })),
      determinism: experiment.determinism,
      expectedObservations: [...experiment.expectedObservations],
    });

    assert.equal(revised.definitionVersion, 1);
    assert.equal(
      experimentDefinitionHash(revised),
      experimentDefinitionHash(experiment),
    );
    assert.equal(revised.id, experiment.id);
    assert.equal(revised.projectId, experiment.projectId);
    assert.deepEqual(revised.createdAt, experiment.createdAt);
    assert.notEqual(revised.createdAt, experiment.createdAt);
  });

  it('bumps the version when the hypothesis changes', async (t) => {
    const home = await makeHome(t);
    const repository = experimentRepository(experimentStorageFilePath(home));
    const experiment = buildExperiment();
    await repository.save(experiment);

    const revised = reviseExperiment(experiment, {
      hypothesis: 'npm test exits non-zero on a clean checkout',
    });

    assert.equal(revised.definitionVersion, 2);
    assert.notEqual(
      experimentDefinitionHash(revised),
      experimentDefinitionHash(experiment),
    );
    assert.equal(revised.id, 'exp-1');
    assert.equal(revised.projectId, 'proj-1');
    assert.deepEqual(revised.createdAt, experiment.createdAt);

    await repository.save(revised);
    const stored = await experimentRepository(experimentStorageFilePath(home))
      .findById(asExperimentId('exp-1'));
    assert.equal(stored?.definitionVersion, 2);
    assert.equal(stored?.hypothesis, 'npm test exits non-zero on a clean checkout');
  });

  it('bumps the version when a step changes', () => {
    const experiment = buildExperiment();

    const revised = reviseExperiment(experiment, {
      steps: [
        { index: 0, description: 'run tests', command: 'npm run test:all' },
        { index: 1, description: 'inspect the report' },
      ],
    });

    assert.equal(revised.definitionVersion, 2);
    assert.notEqual(
      experimentDefinitionHash(revised),
      experimentDefinitionHash(experiment),
    );
    assert.equal(revised.steps.length, 2);
  });

  it('bumps the version when an expected observation changes', () => {
    const experiment = buildExperiment();

    const revised = reviseExperiment(experiment, {
      expectedObservations: ['exit code 0', 'no skipped tests reported'],
    });

    assert.equal(revised.definitionVersion, 2);
    assert.notEqual(
      experimentDefinitionHash(revised),
      experimentDefinitionHash(experiment),
    );
    assert.deepEqual(revised.expectedObservations, [
      'exit code 0',
      'no skipped tests reported',
    ]);
  });

  it('counts every edit once, including reverting to an earlier definition', () => {
    const first = buildExperiment();
    const second = reviseExperiment(first, { hypothesis: 'a different claim' });
    const third = reviseExperiment(second, { hypothesis: first.hypothesis });

    assert.equal(second.definitionVersion, 2);
    assert.equal(third.definitionVersion, 3);
    // The text is back to the original, but this is still a third revision:
    // version tracks edits, not distinct content.
    assert.equal(
      experimentDefinitionHash(third),
      experimentDefinitionHash(first),
    );
    assert.equal(third.id, first.id);
    assert.deepEqual(third.createdAt, first.createdAt);
  });

  it('rejects an invalid revision through the same creation invariants', () => {
    const experiment = buildExperiment();

    assert.throws(
      () => reviseExperiment(experiment, { expectedObservations: [] }),
      isDomainError('empty_expectations'),
    );
    assert.throws(
      () =>
        reviseExperiment(experiment, {
          steps: [{ index: 3, description: 'out of order' }],
        }),
      isDomainError('non_contiguous_experiment_steps'),
    );
  });
});

describe('repository revision enforcement', () => {
  it('rejects a changed definition recorded under the old version', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);
    const experiment = buildExperiment();
    await repository.save(experiment);
    const before = await fs.readFile(filePath, 'utf8');

    await assert.rejects(
      () => repository.save({ ...experiment, hypothesis: 'silently rewritten' }),
      isDomainError('definition_version_mismatch'),
    );

    // Neither the document nor the instance cache accepts the rejected revision.
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    assert.equal(
      (await repository.findById(asExperimentId('exp-1')))?.hypothesis,
      'npm test exits 0',
    );
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
  });

  it('rejects an unchanged definition with a bumped version', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);
    const experiment = buildExperiment();
    await repository.save(experiment);
    const before = await fs.readFile(filePath, 'utf8');

    await assert.rejects(
      () => repository.save({ ...experiment, definitionVersion: 2 }),
      isDomainError('definition_version_mismatch'),
    );

    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    assert.equal(
      (await experimentRepository(filePath).findById(asExperimentId('exp-1')))
        ?.definitionVersion,
      1,
    );
  });

  it('checks the revision against disk, not a stale cache', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const first = experimentRepository(filePath);
    const experiment = buildExperiment();
    await first.save(experiment);
    // Warm the first instance's cache at version 1.
    assert.equal((await first.findById(asExperimentId('exp-1')))?.definitionVersion, 1);

    const revised = reviseExperiment(experiment, { hypothesis: 'changed by another instance' });
    await experimentRepository(filePath).save(revised);

    // A cached revision based on version 1 must not overwrite version 2.
    await assert.rejects(
      () => first.save({ ...experiment, expectedObservations: ['rewritten'] }),
      isDomainError('definition_version_mismatch'),
    );
    assert.equal(
      (await experimentRepository(filePath).findById(asExperimentId('exp-1')))
        ?.definitionVersion,
      2,
    );
  });

  it('enforces the same rule in the in-memory adapter', async () => {
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

    await repository.save(reviseExperiment(experiment, { hypothesis: 'a real change' }));
    const stored = await repository.findById(asExperimentId('exp-1'));
    assert.equal(stored?.definitionVersion, 2);
    assert.equal(stored?.hypothesis, 'a real change');
  });

  it('rejects moving an experiment to another project', async () => {
    const repository = new InMemoryExperimentRepository();
    const experiment = buildExperiment();
    await repository.save(experiment);

    await assert.rejects(
      () => repository.save(buildExperiment({ projectId: asProjectId('proj-2') })),
      isDomainError('experiment_identity_changed'),
    );
  });
});

describe('historical run definition hashes', () => {
  it('keeps the definition hash a run pinned when the experiment is revised', async (t) => {
    const home = await makeHome(t);
    const experimentsPath = experimentStorageFilePath(home);
    const runsPath = runStorageFilePath(home);
    const experiments = experimentRepository(experimentsPath);
    const runs = runRepository(runsPath);

    const experiment = buildExperiment();
    await experiments.save(experiment);
    const pinnedHash = experimentDefinitionHash(experiment);

    const run = createRun({
      id: asRunId('run-1'),
      projectId: asProjectId('proj-1'),
      projectRevision: 'a'.repeat(40),
      experimentId: asExperimentId('exp-1'),
      experimentDefinitionHash: pinnedHash,
      environment: ENVIRONMENT,
    });
    await runs.save(run);
    const runsBefore = await fs.readFile(runsPath, 'utf8');

    const revised = reviseExperiment(experiment, {
      hypothesis: 'npm test exits non-zero',
      expectedObservations: ['exit code 1'],
    });
    await experiments.save(revised);

    const storedExperiment = await experimentRepository(experimentsPath)
      .findById(asExperimentId('exp-1'));
    assert.equal(storedExperiment?.definitionVersion, 2);
    assert.notEqual(
      experimentDefinitionHash(storedExperiment as Experiment),
      pinnedHash,
    );

    const storedRun = await runRepository(runsPath).findById(asRunId('run-1'));
    assert.equal(storedRun?.experimentDefinitionHash, pinnedHash);
    assert.equal(storedRun?.experimentId, 'exp-1');
    // The revision must not rewrite, migrate or re-hash the run document.
    assert.equal(await fs.readFile(runsPath, 'utf8'), runsBefore);
    assert.deepEqual(
      (await runRepository(runsPath).listByExperiment(asExperimentId('exp-1')))
        .map((item) => item.experimentDefinitionHash),
      [pinnedHash],
    );
  });

  it('pins a new run to the revised hash while older runs keep theirs', async (t) => {
    const home = await makeHome(t);
    const experimentsPath = experimentStorageFilePath(home);
    const runsPath = runStorageFilePath(home);
    const experiments = experimentRepository(experimentsPath);
    const runs = runRepository(runsPath);

    const experiment = buildExperiment();
    await experiments.save(experiment);
    const firstHash = experimentDefinitionHash(experiment);
    const makeRun = (id: string, definitionHash: string) =>
      createRun({
        id: asRunId(id),
        projectId: asProjectId('proj-1'),
        projectRevision: 'a'.repeat(40),
        experimentId: asExperimentId('exp-1'),
        experimentDefinitionHash: definitionHash,
        environment: ENVIRONMENT,
      });
    await runs.save(makeRun('run-1', firstHash));

    const revised = reviseExperiment(experiment, { hypothesis: 'a second claim' });
    await experiments.save(revised);
    const secondHash = experimentDefinitionHash(revised);
    await runs.save(makeRun('run-2', secondHash));

    assert.notEqual(secondHash, firstHash);
    assert.equal(
      (await runRepository(runsPath).findById(asRunId('run-1')))
        ?.experimentDefinitionHash,
      firstHash,
    );
    assert.equal(
      (await runRepository(runsPath).findById(asRunId('run-2')))
        ?.experimentDefinitionHash,
      secondHash,
    );
  });
});
