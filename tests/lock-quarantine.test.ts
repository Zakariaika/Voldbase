/**
 * Fail-closed quarantine inspection (ADR-0015).
 *
 * The displaced-owner guard only works if the check before entry is honest. If an
 * unreadable directory or an uninspectable quarantine file were treated as "nothing
 * there", a newcomer would walk into the protected section while a displaced owner
 * may still be writing — the exact failure the guard exists to prevent.
 *
 * These tests assert acquisition behavior, not error wording: every refusal also
 * asserts that no lock file was created, and every allowance is followed by a real
 * acquire/release cycle.
 */

import assert from 'node:assert/strict';
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
  type LockOptions,
} from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-lock-quarantine-'));
  t.after(async () => {
    // Directories are made unreadable by these tests; restore before removing.
    await fs.chmod(directory, 0o700).catch(() => undefined);
    for (const entry of await fs.readdir(directory).catch(() => [])) {
      await fs.chmod(path.join(directory, entry), 0o600).catch(() => undefined);
      await fs.chmod(path.join(directory, entry), 0o700).catch(() => undefined);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

/** Permission-based tests need a POSIX filesystem and a non-root user. */
const PERMISSIONS_ONLY =
  process.platform === 'win32'
    ? 'directory modes are POSIX-only'
    : process.getuid?.() === 0
      ? 'a root user bypasses permission checks'
      : false;

const QUICK: LockOptions = { timeoutMs: 1_000, pollIntervalMs: 5, staleMs: 60_000 };

async function quarantineEntries(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((entry) => entry.endsWith('.quarantine')).sort();
}

/**
 * Write a quarantine file whose owner is alive (this very process), which is the
 * state that must block a new writer.
 */
async function writeLiveQuarantine(
  directory: string,
  lockName: string,
  kind: 'release' | 'stale' | 'displaced',
): Promise<string> {
  const entry = `${lockName}.${kind}-00000000-0000-4000-8000-000000000000.quarantine`;
  const candidate = path.join(directory, entry);
  await fs.writeFile(
    candidate,
    `${JSON.stringify({
      token: 'live-owner-token',
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    })}\n`,
    'utf8',
  );
  return candidate;
}

describe('lock quarantine inspection', () => {
  it('refuses to enter when the lock directory cannot be listed', { skip: PERMISSIONS_ONLY }, async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    // Writable and searchable, but not listable: the store directory cannot be
    // read even though a lock file could be created in it.
    await fs.chmod(directory, 0o300);

    await assert.rejects(
      acquireFileLock(lockPath, QUICK),
      isDomainError('storage_lock_unsafe'),
      'an unlistable directory must not be treated as empty',
    );
    // The refusal happened before any lock existed, so no writer could enter.
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });

    // Sanity: the same call succeeds once the directory is readable again.
    await fs.chmod(directory, 0o700);
    const handle = await acquireFileLock(lockPath, QUICK);
    assert.equal((await fs.stat(lockPath)).isFile(), true);
    await handle.release();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  });

  it(
    'refuses to enter while a quarantine entry cannot be inspected',
    { skip: PERMISSIONS_ONLY },
    async (t) => {
      const directory = await makeTempDir(t);
      const lockPath = path.join(directory, 'projects.json.lock');
      const candidate = await writeLiveQuarantine(directory, 'projects.json.lock', 'displaced');
      await fs.chmod(candidate, 0o000);

      await assert.rejects(
        acquireFileLock(lockPath, QUICK),
        isDomainError('storage_lock_unsafe'),
        'an uninspectable quarantine entry must block entry, not be skipped',
      );
      await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
      // Nothing was deleted: the file may hold the only record of a live owner.
      assert.equal((await fs.stat(candidate)).isFile(), true);

      // Make it readable: it still blocks, because its owner is alive. That proves
      // the first refusal came from the entry, not merely from its permissions.
      await fs.chmod(candidate, 0o600);
      await assert.rejects(acquireFileLock(lockPath, QUICK), isDomainError('storage_lock_unsafe'));

      // Once the entry is gone, so is the block.
      await fs.rm(candidate, { force: true });
      const handle = await acquireFileLock(lockPath, QUICK);
      await handle.release();
      assert.deepEqual(await quarantineEntries(directory), []);
    },
  );

  it(
    'refuses to enter when an uninspectable entry is of release kind',
    { skip: PERMISSIONS_ONLY },
    async (t) => {
      const directory = await makeTempDir(t);
      const lockPath = path.join(directory, 'projects.json.lock');
      const candidate = await writeLiveQuarantine(directory, 'projects.json.lock', 'release');
      await fs.chmod(candidate, 0o000);

      // A readable `release-` entry never blocks (its owner has finished), but an
      // unreadable one cannot be shown to be harmless, so it does.
      await assert.rejects(acquireFileLock(lockPath, QUICK), isDomainError('storage_lock_unsafe'));
      await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });

      await fs.chmod(candidate, 0o600);
      const handle = await acquireFileLock(lockPath, QUICK);
      await handle.release();
    },
  );

  it('treats a quarantine entry that vanishes during inspection as absent', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');
    const candidate = await writeLiveQuarantine(directory, 'projects.json.lock', 'displaced');

    let removed = false;
    const handle = await acquireFileLock(lockPath, {
      ...QUICK,
      hooks: {
        beforeQuarantineInspect: async (entryPath: string) => {
          if (!removed && entryPath === candidate) {
            removed = true;
            await fs.rm(entryPath, { force: true });
          }
        },
      },
    });

    assert.equal(removed, true, 'the hook must have run for the live entry');
    assert.equal((await fs.stat(lockPath)).isFile(), true);
    await handle.release();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
    assert.deepEqual(await quarantineEntries(directory), []);
  });

  it('acquires and releases normally when quarantine inspection succeeds', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    const handle = await acquireFileLock(lockPath, QUICK);
    const written = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token: string };
    assert.equal(written.token, handle.token);

    await handle.release();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });

    // A later acquisition (and a wrong-token release) behaves as before.
    const second = await acquireFileLock(lockPath, QUICK);
    await releaseLock(lockPath, 'not-the-owner');
    assert.equal((await fs.stat(lockPath)).isFile(), true);
    await second.release();
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  });

  it(
    'a failed quarantine inspection never lets a save reach the store',
    { skip: PERMISSIONS_ONLY },
    async (t) => {
      const directory = await makeTempDir(t);
      const storagePath = path.join(directory, 'projects.json');
      const repository = new JsonProjectRepository({
        filePath: storagePath,
        lock: { timeoutMs: 500, pollIntervalMs: 5, staleMs: 60_000 },
      });
      const project = createProject({
        id: asProjectId('proj-1'),
        name: 'project-1',
        source: { kind: 'local', location: '/tmp/proj-1' },
        revision: 'a'.repeat(64),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      await fs.chmod(directory, 0o300);
      await assert.rejects(
        () => repository.save(project),
        isDomainError('storage_lock_unsafe'),
        'the save must not proceed past an unreadable lock directory',
      );
      // Nothing was written, and no lock was left behind.
      await assert.rejects(fs.stat(storagePath), { code: 'ENOENT' });
      await assert.rejects(fs.stat(`${storagePath}.lock`), { code: 'ENOENT' });

      await fs.chmod(directory, 0o700);
      await repository.save(project);
      assert.equal((await repository.list()).length, 1);
    },
  );
});
