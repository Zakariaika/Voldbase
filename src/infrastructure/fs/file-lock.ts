/**
 * Cross-process write coordination for the local store (ADR-0011).
 *
 * Atomic replacement (`write temp → rename`) makes a single write all-or-nothing,
 * but it cannot prevent a lost update: two processes can read the same document,
 * each add a project, and the second rename silently discards the first one. The
 * lock closes that read-modify-write window.
 *
 * Mechanism: a lock file created with `O_EXCL` (`'wx'`), so exactly one process
 * can create it. It holds an owner token, pid and timestamp. Acquisition polls
 * until a deadline, and a lock older than the stale threshold is reclaimed — a
 * crashed process must not wedge the store forever.
 *
 * Guarantees (and nothing more):
 * - Cooperative: only code that takes this lock is serialized. An external editor
 *   or a process that ignores the lock can still overwrite the document.
 * - Local filesystems only. On network filesystems `O_EXCL` semantics and
 *   timestamps vary; the lock is best-effort there.
 * - The lock is held only for the duration of one read-modify-write, never across
 *   a scan or any user-visible work.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';

import { DomainError } from '../../domain/errors.ts';

export interface LockOptions {
  /** Maximum time to wait for the lock before failing. */
  readonly timeoutMs?: number;
  /** Age after which an existing lock is considered abandoned. */
  readonly staleMs?: number;
  /** Delay between acquisition attempts. */
  readonly pollIntervalMs?: number;
}

export interface LockHandle {
  readonly path: string;
  /** Unique per acquisition; used to refuse releasing another process's lock. */
  readonly token: string;
  release(): Promise<void>;
}

interface LockMetadata {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STALE_LOCK_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 25;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function readMetadata(lockPath: string): Promise<LockMetadata | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const { token, pid, hostname, acquiredAt } = parsed as Record<string, unknown>;
    if (
      typeof token !== 'string' ||
      typeof pid !== 'number' ||
      typeof hostname !== 'string' ||
      typeof acquiredAt !== 'string'
    ) {
      return undefined;
    }
    return { token, pid, hostname, acquiredAt };
  } catch {
    // A process that crashed mid-write leaves a partial file: treat it as stale.
    return undefined;
  }
}

/** How long the current lock file has existed, in milliseconds. */
async function lockAgeMs(lockPath: string): Promise<number | undefined> {
  let stats;
  try {
    stats = await fs.stat(lockPath);
  } catch {
    return undefined;
  }

  const metadata = await readMetadata(lockPath);
  if (metadata !== undefined) {
    const acquiredAt = Date.parse(metadata.acquiredAt);
    if (Number.isFinite(acquiredAt)) {
      return Math.max(0, Date.now() - acquiredAt);
    }
  }
  // Unreadable or unparsable metadata: fall back to the filesystem timestamp, so
  // a half-written lock still ages out instead of blocking forever.
  return Math.max(0, Date.now() - stats.mtimeMs);
}

/**
 * Remove an abandoned lock.
 *
 * The identity of the lock file (device + inode) is captured before and checked
 * after reading it, so a lock that was legitimately released and re-created in
 * between is not deleted by mistake. A residual window remains between that last
 * check and the `unlink`; Node exposes no compare-and-delete primitive, so this
 * is documented rather than pretended away.
 */
async function reclaimStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let before;
  try {
    before = await fs.stat(lockPath);
  } catch {
    return false;
  }

  const age = await lockAgeMs(lockPath);
  if (age === undefined || age <= staleMs) {
    return false;
  }

  let after;
  try {
    after = await fs.stat(lockPath);
  } catch {
    return false;
  }
  if (after.ino !== before.ino || after.dev !== before.dev) {
    // The lock was replaced while we were inspecting it: not ours to reclaim.
    return false;
  }

  try {
    await fs.rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire the lock, waiting up to `timeoutMs`.
 *
 * @throws DomainError `storage_lock_timeout` when the deadline passes.
 * @throws DomainError `storage_lock_failed` when the lock cannot be created at all
 * (for example the directory does not exist or is read-only).
 */
export async function acquireFileLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  const metadata: LockMetadata = {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        token,
        release: () => releaseLock(lockPath, token),
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new DomainError(
          'storage_lock_failed',
          `Cannot create lock file ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (await reclaimStaleLock(lockPath, staleMs)) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new DomainError(
        'storage_lock_timeout',
        `Timed out after ${timeoutMs} ms waiting for ${lockPath}. Another VOLDBASE ` +
          'process may be writing; if not, remove the lock file manually.',
      );
    }

    // Small jitter avoids two waiters retrying in lockstep forever.
    await sleep(pollIntervalMs + Math.floor(Math.random() * pollIntervalMs));
  }
}

/** Release the lock only if this process still owns it. */
export async function releaseLock(lockPath: string, token: string): Promise<void> {
  const metadata = await readMetadata(lockPath);
  if (metadata === undefined || metadata.token !== token) {
    // Either already gone, or someone else holds it now: leave it alone.
    return;
  }
  try {
    await fs.rm(lockPath, { force: true });
  } catch {
    // A failed unlock must not mask the original error; the stale timeout
    // reclaims the lock if it lingers.
  }
}
