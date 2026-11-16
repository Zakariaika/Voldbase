/**
 * Analysis storage (Phase 2A).
 *
 * Analyses are append-only, content-addressed records in their own document.
 * These tests cover the round trip, immutability, and the two ways a stored
 * analysis can become untrustworthy: corrupt JSON and content that no longer
 * matches its digest.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  ANALYSIS_SCHEMA_VERSION,
  ANALYSES_STORAGE_SCHEMA_VERSION,
  analysisStorageFilePath,
  asAnalysisId,
  asProjectId,
  createAnalysisSnapshot,
  documentToAnalyses,
  DomainError,
  InMemoryAnalysisRepository,
  JsonAnalysisRepository,
  type AnalysisSnapshot,
} from '../src/index.ts';
import {
  analyzeProject,
  importProject,
  makeTempDir,
  writeFiles,
} from './helpers/analysis-fixture.ts';

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

async function buildSnapshot(t: TestContext) {
  const root = await makeTempDir(t, 'voldbase-2a-store-');
  await writeFiles(root, {
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': "import { a } from './missing';\n",
  });
  const project = await importProject(root);
  const result = await analyzeProject(project);
  return createAnalysisSnapshot({
    analysisId: 'ana-1',
    projectId: project.id,
    projectRevision: project.revision,
    analyzerVersion: result.analyzerVersion,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    settings: result.settings,
    files: result.files,
    findings: result.findings,
    createdAt: new Date('2026-04-02T10:00:00Z'),
  });
}

function repositoryAt(filePath: string): JsonAnalysisRepository {
  return new JsonAnalysisRepository({
    filePath,
    lock: { timeoutMs: 2_000, pollIntervalMs: 10, staleMs: 5_000 },
  });
}

describe('analysis storage', () => {
  it('round-trips a snapshot through the JSON document', async (t) => {
    const snapshot = await buildSnapshot(t);
    const home = await makeTempDir(t, 'voldbase-2a-home-');
    const filePath = analysisStorageFilePath(home);

    await repositoryAt(filePath).save(snapshot);

    const reopened = repositoryAt(filePath);
    const loaded = await reopened.findById(snapshot.analysisId);
    assert.ok(loaded !== undefined);
    assert.equal(loaded.digest, snapshot.digest);
    assert.equal(loaded.projectRevision, snapshot.projectRevision);
    assert.deepEqual(
      loaded.files.map((file) => file.path),
      ['src/a.ts', 'src/b.ts'],
    );
    assert.equal(loaded.findings.length, snapshot.findings.length);
    assert.deepEqual(loaded.createdAt, snapshot.createdAt);

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      analyses: { analysisId: string; digest: string }[];
    };
    assert.equal(document.schemaVersion, ANALYSES_STORAGE_SCHEMA_VERSION);
    assert.equal(document.analyses.length, 1);
    assert.equal(document.analyses[0]?.digest, snapshot.digest);
  });

  it('returns snapshots by project and nothing else', async (t) => {
    const snapshot = await buildSnapshot(t);
    const home = await makeTempDir(t, 'voldbase-2a-home-');
    const repository = repositoryAt(analysisStorageFilePath(home));
    await repository.save(snapshot);

    assert.deepEqual(
      (await repository.listByProject(snapshot.projectId)).map((item) => item.analysisId),
      ['ana-1'],
    );
    assert.deepEqual(await repository.listByProject(asProjectId('proj-other')), []);
    assert.equal(await repository.findById(asAnalysisId('ana-404')), undefined);
  });

  it('is idempotent for an identical re-save and immutable otherwise', async (t) => {
    const snapshot = await buildSnapshot(t);
    const home = await makeTempDir(t, 'voldbase-2a-home-');
    const repository = repositoryAt(analysisStorageFilePath(home));

    await repository.save(snapshot);
    await repository.save(snapshot);
    const document = JSON.parse(
      await fs.readFile(analysisStorageFilePath(home), 'utf8'),
    ) as { analyses: unknown[] };
    assert.equal(document.analyses.length, 1);

    const altered: AnalysisSnapshot = {
      ...snapshot,
      // Same id, different digest: an analysis may not be rewritten.
      digest: 'b'.repeat(64),
    };
    await assert.rejects(repository.save(altered), isDomainError('analysis_immutable'));
  });

  it('reports corrupted JSON instead of discarding it', async (t) => {
    const home = await makeTempDir(t, 'voldbase-2a-home-');
    const filePath = analysisStorageFilePath(home);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{ not json', 'utf8');

    await assert.rejects(repositoryAt(filePath).listByProject(asProjectId('p')), isDomainError('storage_corrupted'));
    // The file is left exactly as found: reporting, never repairing silently.
    assert.equal(await fs.readFile(filePath, 'utf8'), '{ not json');
  });

  it('refuses an analysis whose content no longer matches its digest', async (t) => {
    const snapshot = await buildSnapshot(t);
    const home = await makeTempDir(t, 'voldbase-2a-home-');
    const filePath = analysisStorageFilePath(home);
    await repositoryAt(filePath).save(snapshot);

    const document = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      analyses: Record<string, unknown>[];
    };
    const stored = document.analyses[0] as { findings: { message: string }[] };
    stored.findings[0]!.message = 'tampered explanation';
    await fs.writeFile(filePath, `${JSON.stringify(document)}\n`, 'utf8');

    await assert.rejects(
      repositoryAt(filePath).findById(asAnalysisId('ana-1')),
      isDomainError('analysis_corrupted'),
    );
  });

  it('refuses a document written by a newer build', async (t) => {
    const home = await makeTempDir(t, 'voldbase-2a-home-');
    const filePath = analysisStorageFilePath(home);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 99, analyses: [] }), 'utf8');

    await assert.rejects(
      repositoryAt(filePath).findById(asAnalysisId('ana-1')),
      isDomainError('storage_unsupported_schema'),
    );
  });

  it('rejects a malformed stored analysis with a corruption error', async () => {
    const bad = {
      schemaVersion: 1,
      analyses: [
        {
          analysisId: 'ana-bad',
          projectId: 'proj-1',
          projectRevision: 'not-a-revision',
          analyzerVersion: '1.0.0',
          schemaVersion: 1,
          digest: 'c'.repeat(64),
          createdAt: '2026-04-02T10:00:00.000Z',
          settings: { supportedExtensions: [], maxFiles: 1, maxTotalBytes: 1, maxFileBytes: 1, maxSourceFiles: 1 },
          files: [],
          findings: [],
        },
      ],
    };

    assert.throws(() => documentToAnalyses(bad), isDomainError('analysis_corrupted'));
  });

  it('behaves the same through the in-memory adapter', async (t) => {
    const snapshot = await buildSnapshot(t);
    const repository = new InMemoryAnalysisRepository();
    await repository.save(snapshot);

    const loaded = await repository.findById(snapshot.analysisId);
    assert.ok(loaded !== undefined);
    assert.notEqual(loaded, snapshot, 'the stored snapshot must not alias the caller object');

    await assert.rejects(
      repository.save({ ...snapshot, digest: 'd'.repeat(64) }),
      isDomainError('analysis_immutable'),
    );
    assert.deepEqual(
      (await repository.listByProject(snapshot.projectId)).map((item) => item.analysisId),
      ['ana-1'],
    );
  });
});
