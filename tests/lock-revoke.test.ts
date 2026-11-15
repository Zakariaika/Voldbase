/**
 * Lock revocation races (ADR-0013).
 *
 * The dangerous sequence is "verify the lock, then delete the path": another
 * process can replace the lock in between, and the delete then destroys a lock
 * that is actively held. These tests reproduce that replacement deterministically
 * through the lock's test hooks and assert the foreign lock survives.
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

/** Write a lock file exactly as another process would have. */
async function writeLock(
  lockPath: string,
  token: string,
  acquiredAt: Date = new Date(),
): Promise<void> {
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({
      token,
      pid: 999_999,
      hostname: 'test-host',
      acquiredAt: acquiredAt.toISOString(),
    })}\n`,
    'utf8',
  );
}

async function readToken(lockPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

async function quarantineFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory);
  return entries.filter((name) => name.includes('.quarantine')).sort();
}

const QUICK: LockOptions = { timeoutMs: 200, pollIntervalMs: 5, staleMs: 5_000 };

describe('lock revocation safety', () => {
  it('does not delete a lock that replaced ours between verification and release', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    const handle = await acquireFileLock(lockPath, QUICK);
    let captures = 0;

    // Our lock is verified as ours, then the path is re-pointed at a foreign lock
    // before the removal step would run.
    await releaseLock(lockPath, handle.token, {
      async beforeCapture(currentPath) {
        await fs.rm(currentPath, { force: true });
        await writeLock(currentPath, 'intruder');
      },
      afterCapture() {
        captures += 1;
      },
    });

    // The foreign lock was captured and restored — not deleted — and no quarantine
    // file is left behind.
    assert.equal(captures, 1, 'expected the foreign lock to have been captured');
    assert.equal(await readToken(lockPath), 'intruder');
    assert.deepEqual(await quarantineFiles(directory), []);
  });

  it('leaves an already-taken-over lock alone on release', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    const handle = await acquireFileLock(lockPath, QUICK);

    // Simulate our lock being reclaimed while we were slow.
    await fs.rm(lockPath, { force: true });
    await writeLock(lockPath, 'took-over');

    await handle.release();

    assert.equal(await readToken(lockPath), 'took-over');
    assert.deepEqual(await quarantineFiles(directory), []);
  });

  it('restores a fresh lock captured during stale reclaim instead of deleting it', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    // An old lock, so the age pre-check decides reclaiming is worth attempting.
    await writeLock(lockPath, 'stale-owner', new Date(Date.now() - 60_000));
    let captures = 0;

    // In the window between the age check and the capture, a live process takes
    // over the lock. It must survive.
    await assert.rejects(
      acquireFileLock(lockPath, {
        ...QUICK,
        hooks: {
          async beforeCapture(currentPath) {
            await fs.rm(currentPath, { force: true });
            await writeLock(currentPath, 'fresh-owner');
          },
          afterCapture() {
            captures += 1;
          },
        },
      }),
      isDomainError('storage_lock_timeout'),
    );

    assert.equal(captures, 1, 'expected the fresh lock to have been captured');
    assert.equal(await readToken(lockPath), 'fresh-owner');
    assert.deepEqual(await quarantineFiles(directory), []);
  });

  it('never clobbers a lock acquired while a captured lock is being restored', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    const handle = await acquireFileLock(lockPath, QUICK);
    let capturedPath: string | undefined;

    await releaseLock(lockPath, handle.token, {
      async beforeCapture(currentPath) {
        await fs.rm(currentPath, { force: true });
        await writeLock(currentPath, 'intruder');
      },
      async afterCapture(path_) {
        capturedPath = path_;
        // A third process acquires the now-free lock name while the captured
        // (foreign) lock is still awaiting its verdict.
        await writeLock(lockPath, 'third-owner');
      },
    });

    // The newcomer's lock is untouched, and the captured foreign lock is kept
    // rather than silently deleted.
    assert.equal(await readToken(lockPath), 'third-owner');
    const quarantined = await quarantineFiles(directory);
    assert.equal(quarantined.length, 1);
    assert.equal(await readToken(path.join(directory, queriedQuarantine(quarantined))), 'intruder');
    assert.ok(capturedPath !== undefined);
  });

  it('keeps a fresh captured lock when a newcomer takes the name during reclaim', async (t) => {
    const directory = await makeTempDir(t);
    const lockPath = path.join(directory, 'projects.json.lock');

    await writeLock(lockPath, 'stale-owner', new Date(Date.now() - 60_000));

    await assert.rejects(
      acquireFileLock(lockPath, {
        ...QUICK,
        hooks: {
          async beforeCapture(currentPath) {
            await fs.rm(currentPath, { force: true });
            await writeLock(currentPath, 'fresh-owner');
          },
          async afterCapture() {
            await writeLock(lockPath, 'third-owner');
          },
        },
      }),
      isDomainError('storage_lock_timeout'),
    );

    assert.equal(await readToken(lockPath), 'third-owner');
    const quarantined = await quarantineFiles(directory);
    assert.equal(quarantined.length, 1);
    assert.equal(await readToken(path.join(directory, queriedQuarantine(quarantined))), 'fresh-owner');
  });
});

/** Return the single quarantine entry, failing clearly if there is not exactly one. */
function queriedQuarantine(entries: readonly string[]): string {
  const [entry] = entries;
  assert.ok(entry !== undefined, 'expected a quarantine file to be retained');
  return entry;
}
