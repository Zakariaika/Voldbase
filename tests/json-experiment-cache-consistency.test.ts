/**
 * JSON experiment repository cache consistency (Phase 2C.8).
 *
 * The repository caches the parsed document for the life of an instance. Phase
 * 2C.7 found that the cache was never checked against the file, so an instance
 * kept serving an outdated experiment definition after another instance (or a
 * hand edit) changed `experiments.json`, and never noticed the file becoming
 * corrupted. These tests pin the corrected behaviour: a cached snapshot is only
 * served while the file it was read from is unchanged, and every other
 * repository guarantee (integrity checks, storable-record validation, cloning)
 * still holds across that re-read.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  asExperimentId,
  asProjectId,
  createExperiment,
  DomainError,
  experimentStorageFilePath,
  JsonExperimentRepository,
  reviseExperiment,
  type Experiment,
} from '../src/index.ts';

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

async function makeHome(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2c8-'));
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

describe('json experiment repository cache consistency', () => {
  it('detects an experiment revised by another repository instance', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const first = experimentRepository(filePath);
    const original = buildExperiment();

    await first.save(original);
    // Warm the cache at version 1.
    assert.equal((await first.findById(asExperimentId('exp-1')))?.definitionVersion, 1);

    const revised = reviseExperiment(original, { hypothesis: 'changed elsewhere' });
    await experimentRepository(filePath).save(revised);

    const seen = await first.findById(asExperimentId('exp-1'));
    assert.ok(seen !== undefined);
    assert.equal(seen.definitionVersion, 2);
    assert.equal(seen.hypothesis, 'changed elsewhere');
    assert.deepEqual(
      (await first.listByProject(asProjectId('proj-1'))).map((item) => item.definitionVersion),
      [2],
    );
  });

  it('does not serve cached data once the document is corrupted', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);

    await repository.save(buildExperiment());
    assert.equal((await repository.findById(asExperimentId('exp-1')))?.name, 'suite passes');

    // Replace the document in place: the cached snapshot is now untrustworthy
    // and must not be returned as if nothing happened.
    await fs.writeFile(filePath, '{ not json', 'utf8');

    await assert.rejects(
      () => repository.findById(asExperimentId('exp-1')),
      isDomainError('storage_corrupted'),
    );
    await assert.rejects(
      () => repository.listByProject(asProjectId('proj-1')),
      isDomainError('storage_corrupted'),
    );

    // Removing the unusable file is the documented repair; the same instance
    // must recover rather than keep the corrupted read or the older snapshot.
    await fs.rm(filePath);
    await experimentRepository(filePath).save(buildExperiment());

    assert.equal((await repository.findById(asExperimentId('exp-1')))?.name, 'suite passes');
  });

  it('stops serving cached data after the document is deleted', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);

    await repository.save(buildExperiment());
    assert.ok((await repository.findById(asExperimentId('exp-1'))) !== undefined);

    await fs.rm(filePath);

    assert.equal(await repository.findById(asExperimentId('exp-1')), undefined);
    assert.deepEqual(await repository.listByProject(asProjectId('proj-1')), []);
  });

  it('keeps serving reads from the cache while the document is unchanged', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);

    await repository.save(buildExperiment());
    // The save invalidates the cache, so the first read below reloads it.
    await repository.findById(asExperimentId('exp-1'));

    // A warm, unchanged document must not be read again.
    t.mock.method(fs, 'readFile', async () => {
      throw new Error('readFile was called for an unchanged document');
    });

    assert.equal((await repository.findById(asExperimentId('exp-1')))?.name, 'suite passes');
    assert.equal((await repository.findById(asExperimentId('exp-1')))?.name, 'suite passes');
    assert.equal((await repository.listByProject(asProjectId('proj-1'))).length, 1);
  });

  it('returns the saved record immediately after a save', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);
    const original = buildExperiment();

    await repository.save(original);
    await repository.findById(asExperimentId('exp-1'));
    await repository.save(reviseExperiment(original, { hypothesis: 'a real change' }));

    const stored = await repository.findById(asExperimentId('exp-1'));
    assert.equal(stored?.definitionVersion, 2);
    assert.equal(stored?.hypothesis, 'a real change');
    assert.deepEqual(
      (await repository.listByProject(asProjectId('proj-1'))).map((item) => item.hypothesis),
      ['a real change'],
    );
  });

  it('keeps revision and storable-record checks with a warm cache', async (t) => {
    const home = await makeHome(t);
    const filePath = experimentStorageFilePath(home);
    const repository = experimentRepository(filePath);
    const original = buildExperiment();

    await repository.save(original);
    await repository.findById(asExperimentId('exp-1'));
    const before = await fs.readFile(filePath, 'utf8');

    await assert.rejects(
      () => repository.save({ ...original, hypothesis: 'silently rewritten' }),
      isDomainError('definition_version_mismatch'),
    );
    await assert.rejects(
      () => repository.save({ ...original, definitionVersion: 2 }),
      isDomainError('definition_version_mismatch'),
    );
    await assert.rejects(
      () => repository.save({ ...original, steps: [] }),
      isDomainError('invalid_storage_record'),
    );

    assert.equal(await fs.readFile(filePath, 'utf8'), before);
    assert.equal(
      (await repository.findById(asExperimentId('exp-1')))?.definitionVersion,
      1,
    );

    await repository.save(reviseExperiment(original, { hypothesis: 'a real change' }));
    assert.equal(
      (await repository.findById(asExperimentId('exp-1')))?.definitionVersion,
      2,
    );
  });
});
