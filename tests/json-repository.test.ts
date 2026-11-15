import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  asProjectId,
  createProject,
  DomainError,
  JsonProjectRepository,
  projectToStored,
  STORAGE_SCHEMA_VERSION,
  type Project,
} from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-store-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function buildProject(overrides: Partial<Parameters<typeof createProject>[0]> = {}): Project {
  return createProject({
    id: asProjectId('proj-1'),
    name: 'example',
    source: { kind: 'local', location: '/tmp/example' },
    revision: 'a'.repeat(64),
    dependencies: [],
    configuration: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

function repositoryAt(directory: string): JsonProjectRepository {
  return new JsonProjectRepository({ filePath: path.join(directory, 'projects.json') });
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

describe('json project repository', () => {
  it('persists projects across instances', async (t) => {
    const directory = await makeTempDir(t);
    await repositoryAt(directory).save(buildProject());

    const reopened = repositoryAt(directory);
    const found = await reopened.findById(asProjectId('proj-1'));

    assert.ok(found);
    assert.equal(found.name, 'example');
    assert.equal(found.revision, 'a'.repeat(64));
    assert.equal(found.createdAt.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal((await reopened.list()).length, 1);
  });

  it('writes a versioned document', async (t) => {
    const directory = await makeTempDir(t);
    await repositoryAt(directory).save(buildProject());

    const raw = await fs.readFile(path.join(directory, 'projects.json'), 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion: number; projects: unknown[] };

    assert.equal(parsed.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(parsed.projects.length, 1);
    assert.equal(typeof (parsed.projects[0] as { revision?: unknown }).revision, 'string');
  });

  it('writes atomically, leaving no temporary files behind', async (t) => {
    const directory = await makeTempDir(t);
    const repository = repositoryAt(directory);

    await repository.save(buildProject());
    await repository.save(buildProject({ id: asProjectId('proj-2'), name: 'second' }));

    const entries = await fs.readdir(directory);
    assert.deepEqual(entries, ['projects.json']);
  });

  it('keeps the original createdAt when an identical snapshot is re-saved', async (t) => {
    const directory = await makeTempDir(t);
    const repository = repositoryAt(directory);
    await repository.save(buildProject());

    await repository.save(buildProject({ createdAt: new Date('2027-07-07T00:00:00Z') }));

    const found = await repository.findById(asProjectId('proj-1'));
    assert.ok(found);
    assert.equal(found.createdAt.toISOString(), '2026-01-01T00:00:00.000Z');
  });

  it('rejects re-pointing a stored snapshot at another revision', async (t) => {
    const directory = await makeTempDir(t);
    const repository = repositoryAt(directory);
    await repository.save(buildProject());

    await assert.rejects(
      () => repository.save(buildProject({ revision: 'b'.repeat(64) })),
      isDomainError('project_snapshot_immutable'),
    );

    const stored = await repository.findById(asProjectId('proj-1'));
    assert.equal(stored?.revision, 'a'.repeat(64));
  });

  it('rejects a corrupted document instead of starting over', async (t) => {
    const directory = await makeTempDir(t);
    const filePath = path.join(directory, 'projects.json');
    await fs.writeFile(filePath, '{ this is not json', 'utf8');

    await assert.rejects(
      () => repositoryAt(directory).list(),
      isDomainError('storage_corrupted'),
    );
    // The file is untouched: no silent reset.
    assert.equal(await fs.readFile(filePath, 'utf8'), '{ this is not json');
  });

  it('rejects a document written by a newer build', async (t) => {
    const directory = await makeTempDir(t);
    await fs.writeFile(
      path.join(directory, 'projects.json'),
      JSON.stringify({ schemaVersion: 99, projects: [] }),
      'utf8',
    );

    await assert.rejects(
      () => repositoryAt(directory).list(),
      isDomainError('storage_unsupported_schema'),
    );
  });

  it('rejects a stored project with an invalid revision', async (t) => {
    const directory = await makeTempDir(t);
    await fs.writeFile(
      path.join(directory, 'projects.json'),
      JSON.stringify({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        projects: [{ ...projectToStored(buildProject()), revision: 'deadbeef' }],
      }),
      'utf8',
    );

    await assert.rejects(
      () => repositoryAt(directory).list(),
      isDomainError('storage_corrupted'),
    );
  });

  it('migrates the legacy unversioned array format', async (t) => {
    const directory = await makeTempDir(t);
    const filePath = path.join(directory, 'projects.json');
    await fs.writeFile(filePath, JSON.stringify([projectToStored(buildProject())]), 'utf8');

    const repository = repositoryAt(directory);
    const projects = await repository.list();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.name, 'example');

    // The next write upgrades the document in place.
    await repository.save(buildProject({ id: asProjectId('proj-2'), name: 'second' }));
    const migrated = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      schemaVersion: number;
      projects: unknown[];
    };
    assert.equal(migrated.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(migrated.projects.length, 2);
  });

  it('reports a write failure rather than pretending the save succeeded', async (t) => {
    const directory = await makeTempDir(t);
    const repository = repositoryAt(directory);
    // Load an (empty) state first, then make the target directory unwritable by
    // replacing it with a regular file: mkdir/rename must fail.
    assert.deepEqual(await repository.list(), []);

    await fs.rm(directory, { recursive: true, force: true });
    await fs.writeFile(directory, 'not a directory', 'utf8');

    await assert.rejects(
      () => repository.save(buildProject()),
      isDomainError('storage_write_failed'),
    );
    // The failed save must not be visible in memory either.
    assert.equal(await repository.findById(asProjectId('proj-1')), undefined);
  });

  it('returns copies, so callers cannot mutate stored projects', async (t) => {
    const directory = await makeTempDir(t);
    const repository = repositoryAt(directory);
    await repository.save(buildProject());

    const leaked = await repository.findById(asProjectId('proj-1'));
    assert.ok(leaked);
    (leaked as { name: string }).name = 'tampered';

    const stored = await repository.findById(asProjectId('proj-1'));
    assert.equal(stored?.name, 'example');
  });

  it('validates the storage path', () => {
    assert.throws(
      () => new JsonProjectRepository({ filePath: '  ' }),
      isDomainError('invalid_storage_path'),
    );
  });
});
