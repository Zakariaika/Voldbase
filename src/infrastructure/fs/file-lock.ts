/**
 * Cross-process write coordination for the local store (ADR-0011, ADR-0013).
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
 * ## Why the lock is never deleted after a check
 *
 * "Stat the file, decide, then unlink the path" is a race: another process can
 * release and re-create the lock in between, and the unlink then destroys a lock
 * that someone is actively holding. POSIX offers no compare-and-delete, so this
 * module never deletes a name it just inspected. Instead every removal is
 * two-phase:
 *
 * 1. **Capture.** `rename(lockPath, quarantine)` is atomic and moves whatever
 *    inode is at the path into a name only this process knows. No file is
 *    destroyed by this step.
 * 2. **Verify, then delete or restore.** The captured file is inspected on its
 *    own; if it is the lock we meant to remove (our token, or a genuinely stale
 *    lock), it is deleted — safely, because no other process can ever acquire
 *    that quarantine name. If it turns out to belong to someone else (it was
 *    replaced between the pre-check and the capture), it is put back with
 *    `link()`, which refuses to overwrite a lock that appeared meanwhile.
 *
 * The consequence is the guarantee that matters: **a newly acquired lock cannot
 * be deleted by another process's release or stale reclaim**, because deletion
 * only ever targets a quarantine name owned exclusively by the deleting process.
 *
 * Residual limitation, stated honestly: a foreign lock can be *captured* — made
 * briefly unavailable under its own name — in the microseconds between a
 * pre-check and the capture. It is restored immediately, and if a third process
 * acquired the lock in that gap the restore refuses (EEXIST) and the captured
 * copy is kept rather than clobbering the new lock. Exclusivity is never
 * knowingly broken, but this is not a linearizable mutex on top of POSIX
 * rename/link, and no claim beyond the above is made.
 *
 * ## Other guarantees (and limits)
 *
 * - Cooperative: only code that takes this lock is serialized. An external editor
 *   or a process that ignores the lock can still overwrite the document.
 * - Local filesystems only. `O_EXCL`, rename/link semantics and timestamps vary
 *   over NFS/SMB; the lock is best-effort there.
 * - The lock is held only for the duration of one read-modify-write, never across
 *   a scan or any user-visible work.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';

import { DomainError } from '../../domain/errors.ts';

/** Test seam: never used by production code. */
export interface LockHooks {
  /**
   * Called after a pre-check decided to act on a lock, immediately before the
   * lock is captured by `rename`. Tests use it to replace the lock in exactly
   * that window. Must not be used in production.
   */
  beforeCapture?(lockPath: string, kind: 'release' | 'stale'): void | Promise<void>;
  /**
   * Called after the lock was captured (moved to its quarantine name) and before
   * it is verified and deleted or restored. Tests use it to simulate another
   * process acquiring the lock in that gap. Must not be used in production.
   */
  afterCapture?(capturedPath: string, kind: 'release' | 'stale'): void | Promise<void>;
}

export interface LockOptions {
  /** Maximum time to wait for the lock before failing. */
  readonly timeoutMs?: number;
  /** Age after which an existing lock is considered abandoned. */
  readonly staleMs?: number;
  /** Delay between acquisition attempts. */
  readonly pollIntervalMs?: number;
  /** Test seam; see {@link LockHooks}. */
  readonly hooks?: LockHooks;
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

/** How long the lock at `lockPath` has existed, in milliseconds. */
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
 * Unique name in the same directory, so `rename` stays on one filesystem and is
 * therefore atomic. Quarantine files never collide with the lock name, so a
 * leftover one can never block an acquisition.
 */
function quarantinePath(lockPath: string, kind: 'release' | 'stale'): string {
  return `${lockPath}.${kind}-${randomUUID()}.quarantine`;
}

/**
 * Atomically take exclusive custody of whatever is currently at `lockPath`.
 *
 * Returns false when there is nothing to capture (already gone, or the move was
 * refused) — never throws, because callers treat failure as "try again later".
 */
async function captureLock(lockPath: string, target: string): Promise<boolean> {
  try {
    await fs.rename(lockPath, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a captured lock back under its original name.
 *
 * `link()` is used deliberately: it fails with `EEXIST` instead of overwriting, so
 * a lock acquired while the capture was in flight is never clobbered. On
 * filesystems without hard links the fallback renames only when the name is free.
 *
 * When the restore is refused, the captured file is *kept*: it is the only
 * remaining reference to that lock, and silently deleting it would be worse than
 * leaving a stray quarantine file.
 */
async function restoreCapturedLock(lockPath: string, captured: string): Promise<void> {
  try {
    await fs.link(captured, lockPath);
    await fs.rm(captured, { force: true });
    return;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return; // A new lock appeared; keep the captured copy, never touch the new one.
    }
  }

  try {
    await fs.lstat(lockPath);
    return; // Occupied: leave the captured copy alone.
  } catch {
    await fs.rename(captured, lockPath).catch(() => undefined);
  }
}

/**
 * Remove an abandoned lock, without ever being able to delete a live one.
 *
 * The age check is only a hint that decides whether capturing is worth attempting.
 * The decision that matters is made *after* capture, on the captured inode, and a
 * lock that turns out to be fresh is restored untouched.
 */
async function reclaimStaleLock(
  lockPath: string,
  staleMs: number,
  hooks: LockHooks | undefined,
): Promise<boolean> {
  const age = await lockAgeMs(lockPath);
  if (age === undefined || age <= staleMs) {
    return false;
  }

  if (hooks?.beforeCapture !== undefined) {
    await hooks.beforeCapture(lockPath, 'stale');
  }

  const captured = quarantinePath(lockPath, 'stale');
  if (!(await captureLock(lockPath, captured))) {
    return false;
  }

  if (hooks?.afterCapture !== undefined) {
    await hooks.afterCapture(captured, 'stale');
  }

  // Exclusively ours from here on: whatever we do to this name cannot affect a
  // lock held by anyone else.
  const capturedAge = await lockAgeMs(captured);
  if (capturedAge === undefined || capturedAge <= staleMs) {
    // Fresh lock captured by mistake (it replaced the stale one in the gap):
    // put it back and keep waiting.
    await restoreCapturedLock(lockPath, captured);
    return false;
  }

  await fs.rm(captured, { force: true }).catch(() => undefined);
  return true;
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
  const hooks = options.hooks;
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
      // Exclusive creation: the kernel guarantees exactly one winner.
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        token,
        release: () => releaseLock(lockPath, token, hooks),
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new DomainError(
          'storage_lock_failed',
          `Cannot create lock file ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (await reclaimStaleLock(lockPath, staleMs, hooks)) {
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

/**
 * Release the lock only if this process still owns it.
 *
 * Never throws: it runs from `finally` blocks and must not mask the original
 * error. If the lock was already replaced, nothing is released and nothing is
 * deleted — the foreign lock is restored if it had to be captured to find that out.
 */
export async function releaseLock(
  lockPath: string,
  token: string,
  hooks?: LockHooks,
): Promise<void> {
  // Fast path: if the file is already gone, or clearly not ours, do not touch it.
  const metadata = await readMetadata(lockPath);
  if (metadata === undefined || metadata.token !== token) {
    return;
  }

  if (hooks?.beforeCapture !== undefined) {
    await hooks.beforeCapture(lockPath, 'release');
  }

  const captured = quarantinePath(lockPath, 'release');
  if (!(await captureLock(lockPath, captured))) {
    return;
  }

  if (hooks?.afterCapture !== undefined) {
    await hooks.afterCapture(captured, 'release');
  }

  // Decide on the captured inode, not on the path we checked earlier.
  const capturedMetadata = await readMetadata(captured);
  if (capturedMetadata !== undefined && capturedMetadata.token === token) {
    await fs.rm(captured, { force: true }).catch(() => undefined);
    return;
  }

  // Someone else's lock was captured (it replaced ours in the gap): hand it back.
  await restoreCapturedLock(lockPath, captured);
}
