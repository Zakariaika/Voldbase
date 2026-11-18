/**
 * Experiment and run storage (Phase 2C).
 *
 * Experiments and runs are durable records in their own documents. These tests
 * cover the round trip through fresh repository instances, per-project and
 * per-experiment listing, atomic writes under a lock, terminal-run immutability,
 * and the ways a stored record can become untrustworthy: corrupt JSON, malformed
 * records, duplicate ids and a document written by a newer build.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  analysisStorageFilePath,
  asExperimentId,
  asProjectId,
  asRunId,
  completeRun,
  createExperiment,
  createRun,
  DomainError,
  documentToExperiments,
  documentToRuns,
  experimentStorageFilePath,
  experimentsToDocument,
  EXPERIMENT_STORAGE_SCHEMA_VERSION,
  JsonExperimentRepository,
  JsonRunRepository,
  projectStorageFilePath,
  runsToDocument,
  runStorageFilePath,
  RUN_STORAGE_SCHEMA_VERSION,
  startRun,
  type EnvironmentManifest,
  type Experiment,
  type Run,
} from '../src/index.ts';

const ENVIRONMENT: EnvironmentManifest = {
  os: 'linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: '22.18.0',
};

const DEFINITION_HASH = 'e'.repeat(64);

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

async function makeHome(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2c-store-'));
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

function buildExperiment(
  id = 'exp-1',
  projectId = 'proj-1',
  definitionVersion = 1,
): Experiment {
  return createExperiment({
    id: asExperimentId(id),
    projectId: asProjectId(projectId),
    name: 'suite passes',
    hypothesis: 'npm test exits 0',
    steps: [{ index: 0, description: 'run tests', command: 'npm test' }],
    determinism: 'deterministic',
    expectedObservations: ['exit code 0'],
    definitionVersion,
    createdAt: new Date('2026-05-01T00:00:00Z'),
  });
}

function buildRun(id = 'run-1', experimentId = 'exp-1'): Run {
  return createRun({
    id: asRunId(id),
    projectId: asProjectId('proj-1'),
    projectRevision: 'a'.repeat(40),
    experimentId: asExperimentId(experimentId),
    experimentDefinitionHash: DEFINITION_HASH,
    environment: ENVIRONMENT,
  });
}

function finishedRun(id = 'run-1'): Run {
  const started = startRun(buildRun(id), new Date('2026-05-01T00:01:00Z'));
  return completeRun(started, {
    result: 'NOT_TESTED',
    finishedAt: new Date('2026-05-01T00:02:00Z'),
    notes: 'nothing executed',
  });
}

describe('experiment storage', () => {
  it('saves and retrieves an experiment through a new repository instance', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const experiment = buildExperiment();

    await experimentRepository(filePath).save(experiment);

    const reopened = experimentRepository(filePath);
    const loaded = await reopened.findById(asExperimentId('exp-1'));
    assert.ok(loaded !== undefined);
    assert.equal(loaded.name, 'suite passes');
    assert.equal(loaded.hypothesis, 'npm test exits 0');
    assert.equal(loaded.determinism, 'deterministic');
    assert.equal(loaded.definitionVersion, 1);
    assert.equal(loaded.steps[0]?.command, 'npm test');
    assert.deepEqual(loaded.expectedObservations, ['exit code 0']);
    assert.deepEqual(loaded.createdAt, new Date('2026-05-01T00:00:00Z'));

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      experiments: { id: string }[];
    };
    assert.equal(document.schemaVersion, EXPERIMENT_STORAGE_SCHEMA_VERSION);
    assert.equal(document.experiments.length, 1);
    assert.equal(document.experiments[0]?.id, 'exp-1');
  });

  it('lists experiments by project without leaking other projects', async (t) => {
    const home = await makeHome(t);
    const repository = experimentRepository(experimentStorageFilePath(home));
    await repository.save(buildExperiment('exp-1', 'proj-1'));
    await repository.save(buildExperiment('exp-2', 'proj-1'));
    await repository.save(buildExperiment('exp-other', 'proj-2'));

    assert.deepEqual(
      (await repository.listByProject(asProjectId('proj-1'))).map((item) => item.id),
      ['exp-1', 'exp-2'],
    );
    assert.deepEqual(
      (await repository.listByProject(asProjectId('proj-2'))).map((item) => item.id),
      ['exp-other'],
    );
    assert.deepEqual(await repository.listByProject(asProjectId('proj-absent')), []);
  });

  it('preserves records written by a different repository instance', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);

    await experimentRepository(filePath).save(buildExperiment('exp-1'));
    await experimentRepository(filePath).save(buildExperiment('exp-2'));

    const reopened = experimentRepository(filePath);
    assert.ok(await reopened.findById(asExperimentId('exp-1')) !== undefined);
    assert.ok(await reopened.findById(asExperimentId('exp-2')) !== undefined);
  });

  it('writes identical documents for identical saves', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const experiment = buildExperiment();

    await experimentRepository(filePath).save(experiment);
    const first = await fs.readFile(filePath, 'utf8');
    await experimentRepository(filePath).save(experiment);
    const second = await fs.readFile(filePath, 'utf8');

    assert.equal(second, first);
  });

  it('does not lose records written concurrently by two instances', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);

    await Promise.all([
      experimentRepository(filePath).save(buildExperiment('exp-1')),
      experimentRepository(filePath).save(buildExperiment('exp-2')),
      experimentRepository(filePath).save(buildExperiment('exp-3')),
    ]);

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      experiments: { id: string }[];
    };
    assert.deepEqual(
      document.experiments.map((item) => item.id),
      ['exp-1', 'exp-2', 'exp-3'],
    );
  });

  it('leaves valid data in place when the atomic write fails', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);
    const experiment = buildExperiment();
    await repository.save(experiment);
    const before = await fs.readFile(filePath, 'utf8');

    const original = fs.writeFile;
    t.mock.method(fs, 'writeFile', async () => {
      throw new Error('simulated disk failure');
    });
    try {
      await assert.rejects(
        () => repository.save(buildExperiment('exp-2')),
        isDomainError('storage_write_failed'),
      );
    } finally {
      t.mock.restoreAll();
    }
    assert.equal(fs.writeFile, original);

    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    assert.ok(await repository.findById(asExperimentId('exp-1')) !== undefined);
    assert.equal(await repository.findById(asExperimentId('exp-2')), undefined);
    assert.deepEqual(
      (await fs.readdir(home)).sort(),
      [path.basename(filePath)],
    );
  });

  it('rejects corrupted JSON without touching the file', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    await fs.writeFile(filePath, '{ not json', 'utf8');

    await assert.rejects(
      () => experimentRepository(filePath).listByProject(asProjectId('proj-1')),
      isDomainError('storage_corrupted'),
    );
    assert.equal(await fs.readFile(filePath, 'utf8'), '{ not json');
  });

  it('rejects a malformed stored experiment', async () => {
    const stored = experimentsToDocument([buildExperiment()]).experiments[0];
    assert.ok(stored !== undefined);
    const malformed = {
      schemaVersion: EXPERIMENT_STORAGE_SCHEMA_VERSION,
      experiments: [{ ...stored, steps: [{ index: 4, description: 'out of order' }] }],
    };

    assert.throws(
      () => documentToExperiments(malformed),
      isDomainError('storage_corrupted'),
    );
  });

  it('rejects duplicate experiment ids instead of keeping one', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const raw = `${JSON.stringify(
      experimentsToDocument([buildExperiment('exp-1'), buildExperiment('exp-1')]),
      null,
      2,
    )}\n`;
    await fs.writeFile(filePath, raw, 'utf8');

    await assert.rejects(
      () => experimentRepository(filePath).listByProject(asProjectId('proj-1')),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === 'storage_corrupted' &&
        /duplicate experiment id 'exp-1'/.test(error.message),
    );
    // The duplicate document is reported, never rewritten or deduplicated.
    assert.equal(await fs.readFile(filePath, 'utf8'), raw);
  });

  it('rejects a document written by a newer build', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    await fs.writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 99, experiments: [] }),
      'utf8',
    );

    await assert.rejects(
      () => experimentRepository(filePath).findById(asExperimentId('exp-1')),
      isDomainError('storage_unsupported_schema'),
    );
  });

  it('returns copies, so callers cannot mutate stored experiments', async (t) => {
    const home = await makeHome(t);
    const repository = experimentRepository(experimentStorageFilePath(home));
    await repository.save(buildExperiment());

    const leaked = await repository.findById(asExperimentId('exp-1'));
    assert.ok(leaked !== undefined);
    (leaked as { name: string }).name = 'tampered';
    (leaked.steps[0] as { description: string }).description = 'tampered';

    const stored = await repository.findById(asExperimentId('exp-1'));
    assert.equal(stored?.name, 'suite passes');
    assert.equal(stored?.steps[0]?.description, 'run tests');
  });
});

describe('run storage', () => {
  it('saves and retrieves a run through a new repository instance', async (t) => {
    const home = await makeHome(t);
    const filePath = runStorageFilePath(home);
    const run = finishedRun();

    await runRepository(filePath).save(run);

    const reopened = runRepository(filePath);
    const loaded = await reopened.findById(asRunId('run-1'));
    assert.ok(loaded !== undefined);
    assert.equal(loaded.projectId, 'proj-1');
    assert.equal(loaded.projectRevision, 'a'.repeat(40));
    assert.equal(loaded.experimentId, 'exp-1');
    assert.equal(loaded.experimentDefinitionHash, DEFINITION_HASH);
    assert.equal(loaded.state, 'completed');
    assert.equal(loaded.result, 'NOT_TESTED');
    assert.equal(loaded.notes, 'nothing executed');
    assert.deepEqual(loaded.environment, ENVIRONMENT);
    assert.deepEqual(loaded.startedAt, new Date('2026-05-01T00:01:00Z'));
    assert.deepEqual(loaded.finishedAt, new Date('2026-05-01T00:02:00Z'));

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      runs: { id: string; state: string }[];
    };
    assert.equal(document.schemaVersion, RUN_STORAGE_SCHEMA_VERSION);
    assert.equal(document.runs.length, 1);
    assert.equal(document.runs[0]?.state, 'completed');
  });

  it('lists runs by experiment without leaking other histories', async (t) => {
    const home = await makeHome(t);
    const repository = runRepository(runStorageFilePath(home));
    await repository.save(buildRun('run-1', 'exp-1'));
    await repository.save(finishedRun('run-2'));
    await repository.save(buildRun('run-other', 'exp-other'));

    assert.deepEqual(
      (await repository.listByExperiment(asExperimentId('exp-1'))).map((item) => item.id),
      ['run-1', 'run-2'],
    );
    assert.deepEqual(await repository.listByExperiment(asExperimentId('exp-absent')), []);
  });

  it('preserves runs across repository instances', async (t) => {
    const home = await makeHome(t);
    const filePath = runStorageFilePath(home);

    await runRepository(filePath).save(buildRun('run-1'));
    await runRepository(filePath).save(buildRun('run-2'));

    const reopened = runRepository(filePath);
    assert.ok(await reopened.findById(asRunId('run-1')) !== undefined);
    assert.ok(await reopened.findById(asRunId('run-2')) !== undefined);
  });

  it('does not lose runs written concurrently by two instances', async (t) => {
    const home = await makeHome(t);
    const filePath = runStorageFilePath(home);

    await Promise.all([
      runRepository(filePath).save(buildRun('run-1')),
      runRepository(filePath).save(buildRun('run-2')),
    ]);

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      runs: { id: string }[];
    };
    assert.deepEqual(document.runs.map((item) => item.id), ['run-1', 'run-2']);
  });

  it('rejects modification of a terminal run', async (t) => {
    const home = await makeHome(t);
    const filePath = runStorageFilePath(home);
    const run = finishedRun();
    await runRepository(filePath).save(run);
    const before = await fs.readFile(filePath, 'utf8');

    await assert.rejects(
      () => runRepository(filePath).save({ ...run, notes: 'rewritten' }),
      isDomainError('immutable_run'),
    );
    // Also after reopening, so the guard is based on disk rather than a cache.
    await assert.rejects(
      () => runRepository(filePath).save({ ...run, state: 'running' }),
      isDomainError('immutable_run'),
    );

    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    const stored = await runRepository(filePath).findById(asRunId('run-1'));
    assert.equal(stored?.notes, 'nothing executed');
  });

  it('allows a queued run to be updated until it becomes terminal', async (t) => {
    const home = await makeHome(t);
    const repository = runRepository(runStorageFilePath(home));
    const queued = buildRun();
    await repository.save(queued);

    const started = startRun(queued, new Date('2026-05-01T00:01:00Z'));
    await repository.save(started);
    assert.equal((await repository.findById(asRunId('run-1')))?.state, 'running');

    const completed = completeRun(started, {
      result: 'INCONCLUSIVE',
      finishedAt: new Date('2026-05-01T00:02:00Z'),
    });
    await repository.save(completed);
    assert.equal((await repository.findById(asRunId('run-1')))?.state, 'completed');
  });

  it('rejects a malformed stored run', async () => {
    const stored = JSON.parse(
      JSON.stringify({
        schemaVersion: RUN_STORAGE_SCHEMA_VERSION,
        runs: [finishedRun()],
      }),
    ) as { schemaVersion: number; runs: Record<string, unknown>[] };

    // A completed run without a result could never have been produced.
    const malformed = {
      schemaVersion: RUN_STORAGE_SCHEMA_VERSION,
      runs: [{ ...stored.runs[0], result: undefined }],
    };

    assert.throws(() => documentToRuns(malformed), isDomainError('storage_corrupted'));
  });

  it('rejects duplicate run ids instead of keeping one', async (t) => {
    const home = await makeHome(t);
    const filePath = runStorageFilePath(home);
    const raw = `${JSON.stringify(
      runsToDocument([buildRun('run-1'), finishedRun('run-1')]),
      null,
      2,
    )}\n`;
    await fs.writeFile(filePath, raw, 'utf8');

    await assert.rejects(
      () => runRepository(filePath).listByExperiment(asExperimentId('exp-1')),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === 'storage_corrupted' &&
        /duplicate run id 'run-1'/.test(error.message),
    );
    // The duplicate document is reported, never rewritten or deduplicated.
    assert.equal(await fs.readFile(filePath, 'utf8'), raw);
  });

  it('rejects a document written by a newer build', async (t) => {
    const home = await makeHome(t);
    const filePath = runStorageFilePath(home);
    await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 99, runs: [] }), 'utf8');

    await assert.rejects(
      () => runRepository(filePath).findById(asRunId('run-1')),
      isDomainError('storage_unsupported_schema'),
    );
  });

  it('returns copies, so callers cannot mutate stored runs', async (t) => {
    const home = await makeHome(t);
    const repository = runRepository(runStorageFilePath(home));
    await repository.save(buildRun());

    const leaked = await repository.findById(asRunId('run-1'));
    assert.ok(leaked !== undefined);
    (leaked.environment as { os: string }).os = 'tampered';

    const stored = await repository.findById(asRunId('run-1'));
    assert.equal(stored?.environment.os, 'linux');
  });
});

describe('experiment and run document isolation', () => {
  it('uses storage files separate from projects and analyses', async (t) => {
    const home = await makeHome(t);
    assert.notEqual(experimentStorageFilePath(home), projectStorageFilePath(home));
    assert.notEqual(experimentStorageFilePath(home), analysisStorageFilePath(home));
    assert.notEqual(runStorageFilePath(home), projectStorageFilePath(home));
    assert.notEqual(runStorageFilePath(home), analysisStorageFilePath(home));
    assert.notEqual(runStorageFilePath(home), experimentStorageFilePath(home));

    await experimentRepository(experimentStorageFilePath(home)).save(buildExperiment());
    await runRepository(runStorageFilePath(home)).save(buildRun());

    assert.deepEqual((await fs.readdir(home)).sort(), ['experiments.json', 'runs.json']);
    await assert.rejects(
      () => fs.readFile(projectStorageFilePath(home), 'utf8'),
      /ENOENT/,
    );
    await assert.rejects(
      () => fs.readFile(analysisStorageFilePath(home), 'utf8'),
      /ENOENT/,
    );
  });
});
