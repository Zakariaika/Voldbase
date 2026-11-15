import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  acquireFileLock,
  asProjectId,
  createProject,
  DomainError,
  JsonProjectRepository,
  releaseLock,
  type LockHandle,
  type Project,
} from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-lock-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function repositoryAt(directory: string, timeoutMs = 2_000): JsonProjectRepository {
  return new JsonProjectRepository({
    filePath: path.join(directory, 'projects.json'),
    lock: { timeoutMs, pollIntervalMs: 10, staleMs: 5_000 },
  });
}

function buildProject(id: string, revisionCharacter = 'a'): Project {
  return createProject({
    id: asProjectId(id),
    name: `project-${id}`,
    source: { kind: 'local', location: `/tmp/${id}` },
    revision: revisionCharacter.repeat(64),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

async function writeLock(
  directory: string,
  ageMilliseconds: number,
  contents?: string,
): Promise<string> {
  const lockPath = path.join(directory, 'projects.json.lock');
  await fs.writeFile(
    lockPath,
    contents ??
      `${JSON.stringify({
        token: 'test-token',
        pid: 999_999,
        hostname: 'test-host',
        acquiredAt: new Date(Date.now() - ageMilliseconds).toISOString(),
      })}\n`,
    'utf8',
  );
  return lockPath;
}

async function runWriter(
  helperPath: string,
  storagePath: string,
  projectId: string,
  index: number,
): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [helperPath, storagePath, projectId, String(index)],
      { timeout: 60_000, encoding: 'utf8' },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stderr });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ code, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}

describe('storage write locking', () => {
  it('prevents a lost update when two instances interleave writes', async (t) => {
    const directory = await makeTempDir(t);
    const first = repositoryAt(directory);
    const second = repositoryAt(directory);

    await first.save(buildProject('proj-1', 'a'));
    // Second instance loads (and caches) the current state...
    assert.equal((await second.list()).length, 1);

    // ...then the first instance writes again...
    await first.save(buildProject('proj-2', 'b'));

    // ...and the second saves without having seen proj-2. It must re-read under
    // the lock instead of overwriting the store with its stale snapshot.
    await second.save(buildProject('proj-3', 'c'));

    const ids = (await repositoryAt(directory).list()).map((project) => project.id).sort();
    assert.deepEqual(ids, ['proj-1', 'proj-2', 'proj-3']);
  });

  it('serializes writes from separate OS processes without losing records', async (t) => {
    const directory = await makeTempDir(t);
    const storagePath = path.join(directory, 'projects.json');
    const helperPath = path.resolve(import.meta.dirname, 'helpers', 'concurrent-writer.ts');

    const results = await Promise.all(
      [0, 1, 2, 3].map(async (index) =>
        await runWriter(helperPath, storagePath, `proj-${index}`, index),
      ),
    );

    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }

    const document = JSON.parse(await fs.readFile(storagePath, 'utf8')) as {
      schemaVersion: number;
      projects: { id: string }[];
    };
    assert.equal(document.schemaVersion, 1);
    assert.deepEqual(
      document.projects.map((project) => project.id).sort(),
      ['proj-0', 'proj-1', 'proj-2', 'proj-3'],
    );

    // The lock is gone once every writer has finished.
    await assert.rejects(fs.stat(path.join(directory, 'projects.json.lock')), { code: 'ENOENT' });
  });

  it('fails with storage_lock_timeout when another process holds the lock', async (t) => {
    const directory = await makeTempDir(t);
    await writeLock(directory, 0);

    const repository = repositoryAt(directory, 150);
    const startedAt = Date.now();

    await assert.rejects(
      () => repository.save(buildProject('proj-1')),
      isDomainError('storage_lock_timeout'),
    );

    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 120, `expected to wait for the timeout, waited ${elapsed} ms`);
    // The other process's lock is untouched.
    assert.equal((await fs.stat(path.join(directory, 'projects.json.lock'))).isFile(), true);
  });

  it('recovers from a stale lock left by a crashed process', async (t) => {
    const directory = await makeTempDir(t);
    await writeLock(directory, 60_000);

    await repositoryAt(directory).save(buildProject('proj-1'));

    const projects = await repositoryAt(directory).list();
    assert.equal(projects.length, 1);
    await assert.rejects(fs.stat(path.join(directory, 'projects.json.lock')), { code: 'ENOENT' });
  });

  it('recovers from a truncated lock file that has aged out', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = await writeLock(directory, 0, '{"token": "half-writ');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    await repositoryAt(directory).save(buildProject('proj-1'));

    assert.equal((await repositoryAt(directory).list()).length, 1);
  });

  it('releases the lock when the write fails', async (t) => {
    const directory = await makeTempDir(t);
    // A directory where the store file should be: reading it fails while the lock
    // is held, which must still release the lock.
    await fs.mkdir(path.join(directory, 'projects.json'), { recursive: true });

    await assert.rejects(
      () => repositoryAt(directory).save(buildProject('proj-1')),
      isDomainError('storage_unreadable'),
    );

    await assert.rejects(fs.stat(path.join(directory, 'projects.json.lock')), { code: 'ENOENT' });

    // The store is usable again once the obstruction is gone.
    await fs.rm(path.join(directory, 'projects.json'), { recursive: true, force: true });
    await repositoryAt(directory).save(buildProject('proj-1'));
    assert.equal((await repositoryAt(directory).list()).length, 1);
  });

  it('releases the lock when the snapshot guard rejects a save', async (t) => {
    const directory = await makeTempDir(t);
    const repository = repositoryAt(directory);
    await repository.save(buildProject('proj-1', 'a'));

    await assert.rejects(
      () => repository.save(buildProject('proj-1', 'b')),
      isDomainError('project_snapshot_immutable'),
    );

    await assert.rejects(fs.stat(path.join(directory, 'projects.json.lock')), { code: 'ENOENT' });
    assert.equal((await repositoryAt(directory).list()).length, 1);
  });

  it('never releases a lock owned by another process', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');
    let handle: LockHandle | undefined;

    try {
      handle = await acquireFileLock(lockPath, { timeoutMs: 500, pollIntervalMs: 5 });

      await assert.rejects(
        acquireFileLock(lockPath, { timeoutMs: 60, pollIntervalMs: 5 }),
        isDomainError('storage_lock_timeout'),
      );

      // Wrong token: the lock must survive.
      await releaseLock(lockPath, 'not-the-owner');
      assert.equal((await fs.stat(lockPath)).isFile(), true);
    } finally {
      await handle?.release();
    }

    // After the owner releases, the lock can be taken again.
    const second = await acquireFileLock(lockPath, { timeoutMs: 500, pollIntervalMs: 5 });
    await second.release();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  });

  it('preserves existing records when a concurrent save is rejected', async (t) => {
    const directory = await makeTempDir(t);
    const writer = repositoryAt(directory);
    const intruder = repositoryAt(directory);

    await writer.save(buildProject('proj-1', 'a'));

    // Different content under an existing id: rejected, and nothing else is lost.
    await assert.rejects(
      () => intruder.save(buildProject('proj-1', 'b')),
      isDomainError('project_snapshot_immutable'),
    );
    await intruder.save(buildProject('proj-2', 'c'));

    const projects = await repositoryAt(directory).list();
    assert.deepEqual(
      projects.map((project) => project.id).sort(),
      ['proj-1', 'proj-2'],
    );
    assert.equal(projects.find((project) => project.id === 'proj-1')?.revision, 'a'.repeat(64));
  });
});
