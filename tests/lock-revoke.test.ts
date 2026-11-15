/**
 * Lock ownership, reclamation and displacement (ADR-0015).
 *
 * The dangerous sequence is "remove a lock whose owner is still running": the
 * owner keeps working while someone else enters the same protected section. These
 * tests pin down when removal is allowed at all, and prove that a displaced lock
 * blocks new writers instead of being quietly forgotten.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { acquireFileLock, DomainError, releaseLock, type LockOptions } from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-lock-race-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

/**
 * A pid that belongs to no running process. Candidates above the default
 * `pid_max` are never allocated, so the answer stays true for the test's life.
 */
function deadPid(): number {
  for (let candidate = 4_000_001; candidate < 4_000_101; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as { code?: string }).code === 'ESRCH') {
        return candidate;
      }
    }
  }
  throw new Error('could not find a free pid');
}

const POSIX_ONLY = process.platform === 'win32' ? 'pid liveness is POSIX-verified' : false;

interface LockIdentity {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

async function writeLock(lockPath: string, identity: Partial<LockIdentity> & { token: string }) {
  const payload: LockIdentity = {
    token: identity.token,
    pid: identity.pid ?? deadPid(),
    hostname: identity.hostname ?? os.hostname(),
    acquiredAt: identity.acquiredAt ?? new Date(Date.now() - 60_000).toISOString(),
  };
  await fs.writeFile(lockPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function readToken(lockPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

async function inodeOf(target: string): Promise<number> {
  return (await fs.stat(target)).ino;
}

async function quarantineFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(directory))
    .filter((name) => name.endsWith('.quarantine'))
    .sort();
}

const QUICK: LockOptions = { timeoutMs: 250, pollIntervalMs: 5, staleMs: 50 };

describe('lock ownership safety', () => {
  it('never deletes or displaces a foreign lock that replaced ours before release', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    const handle = await acquireFileLock(lockPath, QUICK);
    let captures = 0;
    let foreignInode = 0;

    // Replace our lock with a foreign one between our read and any removal.
    await releaseLock(lockPath, handle.token, {
      async beforeCapture(currentPath) {
        await fs.rm(currentPath, { force: true });
        await writeLock(currentPath, { token: 'intruder', pid: process.pid });
        foreignInode = await inodeOf(currentPath);
      },
      afterCapture() {
        captures += 1;
      },
    });

    // The replacement was captured and handed straight back: same inode, same
    // owner, and no quarantine litter left behind.
    assert.equal(captures, 1, 'the replacement should have been captured and restored');
    assert.equal(await readToken(lockPath), 'intruder');
    assert.equal(await inodeOf(lockPath), foreignInode, 'the foreign lock must be the same file');
    assert.deepEqual(await quarantineFiles(directory), []);
  });

  it('leaves an already-taken-over lock alone on release', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    const handle = await acquireFileLock(lockPath, QUICK);
    await fs.rm(lockPath, { force: true });
    await writeLock(lockPath, { token: 'took-over', pid: process.pid });
    const before = await inodeOf(lockPath);

    await handle.release();

    assert.equal(await readToken(lockPath), 'took-over');
    assert.equal(await inodeOf(lockPath), before);
    assert.deepEqual(await quarantineFiles(directory), []);
  });

  it(
    'does not reclaim a lock whose owner is alive, however old it is',
    { skip: POSIX_ONLY },
    async (t) => {
      const directory = await makeTempDir(t);
      const lockPath = path.join(directory, 'projects.json.lock');
      // Alive: this very process, with an acquisition time far in the past.
      await writeLock(lockPath, {
        token: 'paused-owner',
        pid: process.pid,
        acquiredAt: new Date(Date.now() - 600_000).toISOString(),
      });

      await assert.rejects(acquireFileLock(lockPath, QUICK), isDomainError('storage_lock_timeout'));

      assert.equal(await readToken(lockPath), 'paused-owner');
    },
  );

  it('does not reclaim a lock whose owner is on another host', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');
    await writeLock(lockPath, { token: 'remote-owner', hostname: 'build-agent.invalid' });

    await assert.rejects(acquireFileLock(lockPath, QUICK), isDomainError('storage_lock_timeout'));

    assert.equal(await readToken(lockPath), 'remote-owner');
  });

  it('does not reclaim a lock whose owner cannot be identified', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');
    await fs.writeFile(lockPath, '{"token": "half-writ', 'utf8');
    const old = new Date(Date.now() - 600_000);
    await fs.utimes(lockPath, old, old);

    await assert.rejects(acquireFileLock(lockPath, QUICK), isDomainError('storage_lock_timeout'));

    assert.equal((await fs.stat(lockPath)).isFile(), true);
  });

  it('refuses to enter while a displaced lock with a live owner is quarantined', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');
    // Only `stale-`/`displaced-` quarantine files can mean a live owner that is
    // still inside its section; `release-` leftovers are the owner's own and are
    // harmless.
    const quarantined = `${lockPath}.stale-deadbeef.quarantine`;
    await writeLock(quarantined, { token: 'displaced-owner', pid: process.pid });

    await assert.rejects(acquireFileLock(lockPath, QUICK), isDomainError('storage_lock_unsafe'));

    // Nothing was acquired, and the displaced lock was not removed.
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
    assert.equal(await readToken(quarantined), 'displaced-owner');
  });

  it('aborts recovery when a live lock is captured in the gap', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    // Recoverable: nobody owns it any more.
    await writeLock(lockPath, { token: 'dead-owner' });

    await assert.rejects(
      acquireFileLock(lockPath, {
        ...QUICK,
        hooks: {
          async beforeCapture(currentPath) {
            // …but a live process takes over between the check and the capture.
            await fs.rm(currentPath, { force: true });
            await writeLock(currentPath, { token: 'live-owner', pid: process.pid });
          },
          async afterCapture() {
            // …and a third process acquires the now-free name before restoration.
            await writeLock(lockPath, { token: 'third-owner', pid: process.pid });
          },
        },
      }),
      isDomainError('storage_lock_unsafe'),
    );

    // The newcomer keeps its lock; the captured live lock is preserved, not deleted.
    assert.equal(await readToken(lockPath), 'third-owner');
    const quarantined = await quarantineFiles(directory);
    assert.equal(quarantined.length, 1);
    const captured = quarantined[0];
    assert.ok(captured !== undefined);
    assert.equal(await readToken(path.join(directory, captured)), 'live-owner');
  });

  it(
    'recovers a lock whose owner is provably gone, and leaves nothing behind',
    { skip: POSIX_ONLY },
    async (t) => {
      const directory = await makeTempDir(t);
      const lockPath = path.join(directory, 'projects.json.lock');
      await writeLock(lockPath, { token: 'crashed-owner' });

      const handle = await acquireFileLock(lockPath, QUICK);

      assert.equal(await readToken(lockPath), handle.token);
      await handle.release();
      await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
      assert.deepEqual(await quarantineFiles(directory), []);
    },
  );

  it('a displaced owner unblocks the store when it finally releases', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    // This process holds the lock, but its file is moved to quarantine by an
    // over-eager recovery while it is still working.
    const handle = await acquireFileLock(lockPath, QUICK);
    const quarantined = `${lockPath}.stale-c0ffee.quarantine`;
    await fs.rename(lockPath, quarantined);

    // With a live owner displaced, nobody may enter.
    await assert.rejects(acquireFileLock(lockPath, QUICK), isDomainError('storage_lock_unsafe'));

    // Releasing is what makes the store usable again.
    await handle.release();
    assert.deepEqual(await quarantineFiles(directory), []);

    const next = await acquireFileLock(lockPath, QUICK);
    await next.release();
  });
});
