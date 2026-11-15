/**
 * Mutual exclusion, measured from outside the lock (ADR-0015).
 *
 * These tests never assert "a lock file exists". Each writer, once inside the
 * protected section, creates an exclusive marker file; if the marker already
 * exists, two writers are inside at the same time. The writers also perform a real
 * read-modify-write of a JSON array, so a lost update is independently visible.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { acquireFileLock, DomainError } from '../src/index.ts';

const HELPER = path.resolve(import.meta.dirname, 'helpers', 'lock-worker.ts');

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-exclusion-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

interface WorkerRun {
  readonly child: ChildProcess;
  readonly done: Promise<{ code: number | null; stderr: string }>;
}

function spawnWorker(args: readonly string[]): WorkerRun {
  const child = spawn(process.execPath, [HELPER, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += String(chunk);
  });
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });
  return { child, done };
}

async function waitForFile(target: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.stat(target);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${target}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/**
 * A pid that belongs to no running process: candidates above the default
 * `pid_max` are never allocated, so recovery has a stable, provably dead owner.
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

async function readStore(storePath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(storePath, 'utf8'));
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

describe('lock mutual exclusion', () => {
  it('never lets two active writers into the protected section', async (t) => {
    const directory = await makeTempDir(t);
    const storePath = path.join(directory, 'projects.json');
    const markerPath = path.join(directory, 'critical-section.marker');
    const workers = ['one', 'two', 'three', 'four', 'five'].map((id) =>
      spawnWorker(['write', storePath, `proj-${id}`, markerPath, '40']),
    );
    t.after(() => {
      for (const worker of workers) {
        worker.child.kill('SIGKILL');
      }
    });

    const results = await Promise.all(workers.map(async (worker) => await worker.done));

    for (const result of results) {
      assert.equal(result.code, 0, `worker failed: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /CONCURRENT_ENTRY/, 'two writers overlapped');
    }

    const stored = await readStore(storePath);
    assert.equal(stored.length, 5, `lost update: stored ${JSON.stringify(stored)}`);
    assert.deepEqual(
      [...stored].sort(),
      ['proj-five', 'proj-four', 'proj-one', 'proj-three', 'proj-two'],
    );
    await assert.rejects(fs.stat(markerPath), { code: 'ENOENT' });
  });

  it(
    'does not steal the lock from a paused owner that exceeds the stale threshold',
    { skip: process.platform === 'win32' ? 'SIGSTOP is POSIX-only' : false },
    async (t) => {
      const directory = await makeTempDir(t);
      const storePath = path.join(directory, 'projects.json');
      const lockPath = `${storePath}.lock`;
      const readyPath = path.join(directory, 'ready');
      const releasePath = path.join(directory, 'release');

      const worker = spawnWorker(['hold', storePath, readyPath, releasePath]);
      t.after(() => {
        worker.child.kill('SIGKILL');
      });

      await waitForFile(readyPath);
      assert.ok(worker.child.pid !== undefined);
      process.kill(worker.child.pid, 'SIGSTOP');

      // Paused, alive, and far older than staleMs: it must still be respected.
      const startedAt = Date.now();
      await assert.rejects(
        acquireFileLock(lockPath, { timeoutMs: 500, pollIntervalMs: 10, staleMs: 50 }),
        isDomainError('storage_lock_timeout'),
      );
      assert.ok(Date.now() - startedAt >= 400, 'expected to wait out the full timeout');
      assert.equal((await fs.stat(lockPath)).isFile(), true);

      process.kill(worker.child.pid, 'SIGCONT');
      await fs.writeFile(releasePath, 'go\n', 'utf8');
      const released = await worker.done;
      assert.equal(released.code, 0, released.stderr);

      const handle = await acquireFileLock(lockPath, { timeoutMs: 2_000, pollIntervalMs: 10 });
      await handle.release();
    },
  );

  it(
    'serializes many contenders racing to recover the same dead lock',
    { skip: process.platform === 'win32' ? 'pid liveness is POSIX-verified' : false },
    async (t) => {
      const directory = await makeTempDir(t);
      const storePath = path.join(directory, 'projects.json');
      const markerPath = path.join(directory, 'critical-section.marker');

      // Leave a real lock behind from a process that is now gone.
      const dead = spawnWorker(['deadlock', storePath]);
      t.after(() => {
        dead.child.kill('SIGKILL');
      });
      const deadResult = await dead.done;
      assert.equal(deadResult.code, 0, deadResult.stderr);

      // Pin the abandoned lock to an owner that is unambiguously gone, so the test
      // does not depend on the exited child's pid not being reused.
      const lockPath = `${storePath}.lock`;
      const abandoned = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ ...abandoned, pid: deadPid(), acquiredAt: new Date(Date.now() - 60_000).toISOString() })}\n`,
        'utf8',
      );

      const workers = ['a', 'b', 'c'].map((id) =>
        spawnWorker(['write', storePath, `proj-${id}`, markerPath, '30']),
      );
      t.after(() => {
        for (const worker of workers) {
          worker.child.kill('SIGKILL');
        }
      });

      const results = await Promise.all(workers.map(async (worker) => await worker.done));

      for (const result of results) {
        assert.equal(result.code, 0, `worker failed: ${result.stderr}`);
        assert.doesNotMatch(result.stderr, /CONCURRENT_ENTRY/, 'two recovery winners overlapped');
      }

      const stored = await readStore(storePath);
      assert.equal(stored.length, 3, `lost update: stored ${JSON.stringify(stored)}`);
      await assert.rejects(fs.stat(`${storePath}.lock`), { code: 'ENOENT' });
    },
  );

  it('keeps a foreign owner out while this process holds the lock', async (t) => {
    const directory = await makeTempDir(t);
    const storePath = path.join(directory, 'projects.json');
    const lockPath = `${storePath}.lock`;

    const handle = await acquireFileLock(lockPath, { timeoutMs: 2_000, pollIntervalMs: 5 });
    try {
      await assert.rejects(
        acquireFileLock(lockPath, { timeoutMs: 200, pollIntervalMs: 5, staleMs: 5_000 }),
        isDomainError('storage_lock_timeout'),
      );
    } finally {
      await handle.release();
    }

    const next = await acquireFileLock(lockPath, { timeoutMs: 2_000, pollIntervalMs: 5 });
    await next.release();
  });
});
