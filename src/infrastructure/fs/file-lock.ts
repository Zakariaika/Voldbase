/**
 * Cross-process write coordination for the local store.
 *
 * Decisions: ADR-0011 (acquisition, bounded wait, in-lock re-read), ADR-0013
 * (capture-before-removal), ADR-0015 (this protocol: liveness-based reclaim and
 * the displaced-owner guard).
 *
 * Mutual exclusion is defined by exactly one thing: **creating the lock file with
 * `O_EXCL`**. Only the kernel's atomic exclusive create decides who may write.
 * Everything else here exists to answer two questions without ever breaking that
 * rule:
 *
 * 1. When may a lock be removed at all?
 * 2. What happens when a lock has been removed while its owner is still running?
 *
 * ## 1. Removal requires proof the owner is gone
 *
 * A lock is reclaimed only when **both** hold:
 *
 * - it is older than the stale threshold, and
 * - its owner is *provably not running* on this machine: same hostname, and
 *   `process.kill(pid, 0)` fails with `ESRCH`.
 *
 * Elapsed time alone is never sufficient. A paused process (`SIGSTOP`, a
 * debugger, a laptop suspended mid-write), a process stalled in I/O, and a
 * long-running operation are all *alive* and must never be displaced — they will
 * resume and write. A crashed process is gone, and its lock is recovered at once.
 *
 * Liveness checks are **not** portable proof of death, and this code does not
 * pretend otherwise:
 *
 * - a PID may be reused by an unrelated process → the check says "alive" and the
 *   lock is simply not reclaimed (the safe direction: a user must remove it);
 * - PIDs are namespaced: a process in another container or on another host is not
 *   visible, so a different hostname — or any doubt — is treated as "unknown" and
 *   is never reclaimed automatically;
 * - `EPERM` (a live process owned by another user) is treated as "alive";
 * - an unreadable or truncated lock carries no owner identity, so it is never
 *   reclaimed automatically (removal is documented as a manual repair).
 *
 * ## 2. If a lock is displaced anyway, no new writer may enter
 *
 * Portable file APIs have no compare-and-delete, so a removal can still race with
 * a re-creation. Therefore a captured lock is never used as evidence that its
 * owner is gone, and a displaced lock is never silently forgotten:
 *
 * - removal first **captures** the lock with an atomic `rename` to a private
 *   `*.quarantine` name, then verifies the captured inode/owner and either deletes
 *   it (owner provably dead) or restores it with `link` (which never overwrites).
 * - if the captured lock turns out to belong to a *live* owner, the remover does
 *   not acquire; it fails with `storage_lock_unsafe`.
 * - **every acquisition checks for unresolved quarantine files both before and
 *   after creating its lock.** If a quarantine file belongs to an owner that is
 *   alive — or whose state cannot be proven dead — the acquisition removes its own
 *   lock and fails with `storage_lock_unsafe`. That is the guarantee that matters:
 *   *while a valid owner may still be operating under a displaced lock, no other
 *   process enters the protected section.*
 * - the displaced owner cleans up its own quarantine file when it releases, which
 *   is what makes the store usable again without manual intervention.
 *
 * ## What remains true and what remains limited
 *
 * - Cooperative: only code that uses this module is serialized.
 * - Local filesystems only. `O_EXCL`, `rename`, `link` and PID visibility are not
 *   dependable over NFS/SMB or across containers, and the store is not supported
 *   there.
 * - There is still a microsecond window between an acquisition's quarantine check
 *   and its entry into the protected section. Closing it would need a conditional
 *   delete/rename primitive that portable filesystems do not provide. It can only
 *   be hit if a reclaimer simultaneously misjudges a live owner as dead, and the
 *   result is detected and reported (`storage_lock_unsafe`) rather than ignored.
 * - Manual deletion of a lock file is outside every guarantee.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
   * it is verified. Tests use it to simulate another process acquiring the lock
   * in that gap. Must not be used in production.
   */
  afterCapture?(capturedPath: string, kind: 'release' | 'stale'): void | Promise<void>;
}

export interface LockOptions {
  /** Maximum time to wait for the lock before failing. */
  readonly timeoutMs?: number;
  /**
   * Minimum age before a lock is even considered for recovery. Recovery also
   * requires proof that the owner is no longer running.
   */
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

/** What is on disk at a lock path, read through a single descriptor. */
interface LockSnapshot {
  readonly metadata: LockMetadata | undefined;
  readonly device: number;
  readonly inode: number;
  readonly modifiedMs: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STALE_LOCK_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 25;

const QUARANTINE_SUFFIX = '.quarantine';

/**
 * Quarantine kinds.
 *
 * `release` is written by the owner itself, after its protected section has
 * finished, so it never indicates a writer that is still working. `stale` is
 * written by a reclaimer and `displaced` by a release that could not hand a
 * foreign lock back; both mean "a lock may have left its path while its owner was
 * still running", and both block new writers while the owner is alive.
 */
type QuarantineKind = 'release' | 'stale' | 'displaced';

function quarantineKindOf(entryName: string, lockName: string): QuarantineKind | undefined {
  if (!entryName.startsWith(`${lockName}.`) || !entryName.endsWith(QUARANTINE_SUFFIX)) {
    return undefined;
  }
  const middle = entryName.slice(lockName.length + 1, entryName.length - QUARANTINE_SUFFIX.length);
  if (middle.startsWith('release-')) return 'release';
  if (middle.startsWith('stale-')) return 'stale';
  if (middle.startsWith('displaced-')) return 'displaced';
  return undefined;
}

/** Only these kinds can mean a live owner is still inside its section. */
function blocksEntry(kind: QuarantineKind): boolean {
  return kind === 'stale' || kind === 'displaced';
}

type Liveness = 'alive' | 'dead' | 'unknown';

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

function parseMetadata(raw: string): LockMetadata | undefined {
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
    return undefined;
  }
}

/**
 * Read a lock through one descriptor: identity, contents and timestamp all come
 * from the same inode, so what is judged cannot be swapped between the reads.
 */
async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  let handle;
  try {
    handle = await fs.open(lockPath, 'r');
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    let raw: string | undefined;
    try {
      raw = await handle.readFile('utf8');
    } catch {
      raw = undefined;
    }
    return {
      metadata: raw === undefined ? undefined : parseMetadata(raw),
      device: stats.dev,
      inode: stats.ino,
      modifiedMs: stats.mtimeMs,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Age of a snapshot, from its recorded acquisition time or its mtime. */
function ageOf(snapshot: LockSnapshot): number {
  const acquiredAt = snapshot.metadata === undefined ? Number.NaN : Date.parse(snapshot.metadata.acquiredAt);
  if (Number.isFinite(acquiredAt)) {
    return Math.max(0, Date.now() - acquiredAt);
  }
  return Math.max(0, Date.now() - snapshot.modifiedMs);
}

/**
 * Is the recorded owner still running?
 *
 * `dead` is only returned when the owner claims this host *and* the PID does not
 * exist. Everything else — another host, another container, a permission error, a
 * platform without the check, a parse failure — is `alive` or `unknown`, and
 * neither is grounds for taking the lock away.
 */
function ownerLiveness(metadata: LockMetadata | undefined): Liveness {
  if (metadata === undefined) {
    return 'unknown';
  }
  if (metadata.hostname !== os.hostname()) {
    return 'unknown';
  }
  if (metadata.pid === process.pid) {
    return 'alive';
  }
  try {
    process.kill(metadata.pid, 0);
    return 'alive';
  } catch (error) {
    // ESRCH is the only answer that means "no such process".
    return errorCode(error) === 'ESRCH' ? 'dead' : 'alive';
  }
}

function quarantinePath(lockPath: string, kind: 'release' | 'stale'): string {
  return `${lockPath}.${kind}-${randomUUID()}${QUARANTINE_SUFFIX}`;
}

/** Atomically take custody of whatever is at `lockPath`. */
async function captureLock(lockPath: string, target: string): Promise<boolean> {
  try {
    await fs.rename(lockPath, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a captured lock back under its original name, without overwriting a lock
 * that appeared meanwhile. The captured copy is kept when it cannot be restored:
 * it is that owner's only remaining record, and deleting it would hide the fact
 * that a lock went missing.
 */
async function restoreCapturedLock(lockPath: string, captured: string): Promise<boolean> {
  try {
    await fs.link(captured, lockPath);
    await fs.rm(captured, { force: true });
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return false;
    }
  }

  try {
    await fs.lstat(lockPath);
    return false;
  } catch {
    try {
      await fs.rename(captured, lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

function unsafe(message: string): DomainError {
  return new DomainError('storage_lock_unsafe', message);
}

/**
 * Resolve quarantine files for this lock.
 *
 * Files whose owner is provably dead are deleted (a dead owner cannot be inside
 * the protected section). Files whose owner is alive, or whose state cannot be
 * proven, *block* new writers: that owner may still be writing under a lock that
 * is no longer at its original path.
 */
async function resolveQuarantine(lockPath: string): Promise<'clear' | 'blocked'> {
  const directory = path.dirname(lockPath);
  const lockName = path.basename(lockPath);

  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return 'clear';
  }

  let blocked = false;
  for (const entry of entries) {
    const kind = quarantineKindOf(entry, lockName);
    if (kind === undefined) {
      continue;
    }
    const candidate = path.join(directory, entry);
    const snapshot = await readLockSnapshot(candidate);
    if (snapshot === undefined) {
      continue; // vanished between listing and reading
    }
    if (ownerLiveness(snapshot.metadata) === 'dead') {
      // A dead owner cannot be inside its section: this file is only litter.
      await fs.rm(candidate, { force: true }).catch(() => undefined);
      continue;
    }
    if (blocksEntry(kind)) {
      blocked = true;
    }
  }
  return blocked ? 'blocked' : 'clear';
}

/** Remove quarantine files that carry this process's own token. */
async function removeOwnQuarantine(lockPath: string, token: string): Promise<void> {
  const directory = path.dirname(lockPath);
  const lockName = path.basename(lockPath);
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (quarantineKindOf(entry, lockName) === undefined) {
      continue;
    }
    const candidate = path.join(directory, entry);
    const snapshot = await readLockSnapshot(candidate);
    if (snapshot?.metadata?.token === token) {
      await fs.rm(candidate, { force: true }).catch(() => undefined);
    }
  }
}

type ReclaimOutcome = 'reclaimed' | 'skip' | 'unsafe';

/**
 * Try to recover a lock left by a process that is no longer running.
 *
 * The age check is a floor, not a licence: the owner must also be provably dead.
 */
async function reclaimStaleLock(
  lockPath: string,
  staleMs: number,
  hooks: LockHooks | undefined,
): Promise<ReclaimOutcome> {
  const snapshot = await readLockSnapshot(lockPath);
  if (snapshot === undefined) {
    return 'skip';
  }
  // No identity means no proof of death: never reclaim, ask for a human instead.
  if (snapshot.metadata === undefined || ownerLiveness(snapshot.metadata) !== 'dead') {
    return 'skip';
  }
  if (ageOf(snapshot) <= staleMs) {
    return 'skip';
  }

  if (hooks?.beforeCapture !== undefined) {
    await hooks.beforeCapture(lockPath, 'stale');
  }

  const captured = quarantinePath(lockPath, 'stale');
  if (!(await captureLock(lockPath, captured))) {
    return 'skip';
  }

  if (hooks?.afterCapture !== undefined) {
    await hooks.afterCapture(captured, 'stale');
  }

  // Only delete if the inode we captured is the inode we judged, and its owner is
  // still provably gone. Anything else is a lock that appeared in the gap: it may
  // have a live owner, so it is put back and this process refuses to continue.
  const capturedSnapshot = await readLockSnapshot(captured);
  const sameLock =
    capturedSnapshot !== undefined &&
    capturedSnapshot.device === snapshot.device &&
    capturedSnapshot.inode === snapshot.inode;
  const stillDead =
    capturedSnapshot !== undefined && ownerLiveness(capturedSnapshot.metadata) === 'dead';

  if (sameLock && stillDead) {
    await fs.rm(captured, { force: true }).catch(() => undefined);
    return 'reclaimed';
  }

  const restored = await restoreCapturedLock(lockPath, captured);
  throw unsafe(
    restored
      ? `${lockPath} changed while it was being recovered; the lock was restored and this ` +
        'process refused to continue. Retry the operation.'
      : `${lockPath} changed while it was being recovered and a new lock appeared before the ` +
        'previous one could be restored. Refusing to continue: another writer may still be ' +
        'active. Inspect the store directory, then retry.',
  );
}

/**
 * Acquire the lock, waiting up to `timeoutMs`.
 *
 * @throws DomainError `storage_lock_timeout` when the deadline passes.
 * @throws DomainError `storage_lock_unsafe` when another writer may still be
 * active under a displaced lock; the caller must not enter the protected section.
 * @throws DomainError `storage_lock_failed` when the lock cannot be created at all.
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
  const instruction =
    'Remove it only if you are certain no VOLDBASE process is running.';

  const metadata: LockMetadata = {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  for (;;) {
    // Cheap pre-check: do not even try while a live owner's lock is displaced.
    if ((await resolveQuarantine(lockPath)) === 'blocked') {
      throw unsafe(
        `${lockPath} has a displaced lock whose owner may still be active. ` +
          'Refusing to enter the protected section.',
      );
    }

    let created = false;
    try {
      // Exclusive creation: the kernel guarantees exactly one winner.
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      created = true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw new DomainError(
          'storage_lock_failed',
          `Cannot create lock file ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (created) {
      // Binding check, done after we own the name: if a valid owner is displaced,
      // this process gives the lock back instead of becoming a second writer.
      if ((await resolveQuarantine(lockPath)) === 'blocked') {
        await releaseLock(lockPath, token, hooks);
        throw unsafe(
          `${lockPath} was acquired but a displaced lock with a live owner exists. ` +
            'Refusing to enter the protected section.',
        );
      }

      return {
        path: lockPath,
        token,
        release: () => releaseLock(lockPath, token, hooks),
      };
    }

    const outcome = await reclaimStaleLock(lockPath, staleMs, hooks);
    if (outcome === 'reclaimed') {
      continue;
    }

    if (Date.now() >= deadline) {
      const held = await readLockSnapshot(lockPath);
      const owner =
        held?.metadata === undefined
          ? 'its owner could not be identified (the file is empty, truncated or unreadable)'
          : held.metadata.hostname === os.hostname()
            ? `pid ${held.metadata.pid} on this host, which is still running`
            : `pid ${held.metadata.pid} on host ${held.metadata.hostname}, which cannot be checked from here`;
      throw new DomainError(
        'storage_lock_timeout',
        `Timed out after ${timeoutMs} ms waiting for ${lockPath}. The lock is held by ${owner}. ` +
          instruction,
      );
    }

    await sleep(pollIntervalMs + Math.floor(Math.random() * pollIntervalMs));
  }
}

/**
 * Release the lock only if this process still owns it.
 *
 * Never throws: it runs from `finally` blocks and must not mask the original
 * error. It never removes a name it has not just verified as its own, so it cannot
 * delete a lock held by another process, and it never displaces a foreign lock.
 */
export async function releaseLock(
  lockPath: string,
  token: string,
  hooks?: LockHooks,
): Promise<void> {
  const current = await readLockSnapshot(lockPath);

  if (current !== undefined && current.metadata?.token === token) {
    if (hooks?.beforeCapture !== undefined) {
      await hooks.beforeCapture(lockPath, 'release');
    }

    const captured = quarantinePath(lockPath, 'release');
    if (await captureLock(lockPath, captured)) {
      if (hooks?.afterCapture !== undefined) {
        await hooks.afterCapture(captured, 'release');
      }

      const capturedSnapshot = await readLockSnapshot(captured);
      if (capturedSnapshot?.metadata?.token === token) {
        await fs.rm(captured, { force: true }).catch(() => undefined);
      } else if (!(await restoreCapturedLock(lockPath, captured))) {
        // A foreign lock was caught in the capture window and could not be handed
        // back because a newcomer took the name. It must keep blocking entry while
        // its owner may still be working, so it is re-labelled as displaced.
        await fs
          .rename(captured, `${lockPath}.displaced-${randomUUID()}${QUARANTINE_SUFFIX}`)
          .catch(() => undefined);
      }
    }
  }

  // Our own lock may have ended up in quarantine (for example if it was displaced
  // while this process was paused). Releasing it is what unblocks new writers.
  await removeOwnQuarantine(lockPath, token);
}
