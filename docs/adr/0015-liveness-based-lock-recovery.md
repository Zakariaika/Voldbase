# 0015 — Lock safety: liveness-based recovery and the displaced-owner guard

- Status: Accepted
- Date: 2026-11-15
- Supersedes: [0013](0013-lock-capture-and-restore.md)

## Context

ADR-0013 removed a lock in two phases — capture with `rename`, verify the captured
file, then delete or restore it — which stopped one process from *deleting*
another's lock. It did not stop one process from *displacing* another's lock, and
that is the more serious failure:

1. Process A captures a lock whose metadata it judged reclaimable.
2. The captured lock actually belongs to a live owner B, which is still inside its
   protected read-modify-write.
3. Before A restores it, process C creates a new lock at the original path.
4. The restore fails with `EEXIST`; B's lock stays in quarantine, and C enters the
   protected section believing it holds the store.

B and C then write concurrently. Preserving B's file in quarantine does not help:
mutual exclusion is defined by *who may enter*, not by which files still exist.

The root cause was time-based recovery: `reclaimStaleLock` treated a lock older than
30 s as abandoned. But age proves nothing. A process that is paused (`SIGSTOP`, a
debugger, a suspended laptop), stalled in I/O, or simply performing a long
operation is **alive** and will resume writing.

Portable filesystems also offer no compare-and-delete: between any check and any
`unlink` the name can be re-created. That makes "delete after verifying" unsafe in
principle, so the design has to avoid deleting another owner's lock *at all* rather
than trying to time the delete better.

## Decision

**1. Recovery requires proof that the owner is gone, never just elapsed time.**

A lock is reclaimed only when it is older than the threshold **and** its recorded
owner is provably not running: the same hostname, and `process.kill(pid, 0)` fails
with `ESRCH`. Everything else — another host, another container, `EPERM`, a
truncated metadata file, a platform where the check is unavailable — is treated as
*unknown* and is never reclaimed. A user sees the owner in the timeout message and
removes the file deliberately if they know it is safe.

**2. A captured lock is never treated as evidence that its owner is gone.**

Reclaim captures with `rename`, then confirms that the captured inode *is* the inode
it judged (identity compared with the descriptor it read the metadata through) and
that the owner is still provably dead. If either check fails, the lock is restored
with `link` (which never overwrites) and the reclaimer **aborts** with
`storage_lock_unsafe` instead of acquiring.

**3. A displaced live lock blocks every new writer until its owner releases.**

Every acquisition checks quarantine files **before creating its lock and again after
it owns the name**. A `stale-` (recovery) or `displaced-` entry whose owner is alive
means a valid owner may still be operating, so the newcomer removes its own lock and
fails with `storage_lock_unsafe`. This is what actually restores mutual exclusion
after a displacement: the displaced owner continues alone, and no one else enters.

`release-` entries are excluded from that check on purpose: they are written by the
owner itself *after* its section has finished, so they cannot represent a writer
that is still working. If a release ever catches a foreign lock and cannot hand it
back, the file is re-labelled `displaced-` so it does block.

**4. Release never removes or displaces a lock it does not own.**

Release reads the lock once; if the token is not its own it does nothing at all. If
it is its own, the lock is captured, re-verified by token, and deleted; a foreign
lock caught in that window is handed straight back. Finally, any quarantine file
carrying this process's own token is removed — that is how a displaced owner
unblocks the store without human intervention.

## Guarantees

- Exactly one process can create the lock: `open(path, 'wx')`, enforced by the
  kernel. No path in this module bypasses it.
- A live owner's lock is never reclaimed, however old it is — paused, stalled and
  long-running processes keep their exclusion.
- A lock whose owner cannot be shown to be gone is never reclaimed automatically.
- A displaced live lock prevents any other process from entering until its owner
  releases (`storage_lock_unsafe`).
- Release cannot delete or displace a lock owned by another process.

## Limitations (none of these are hypothetical)

- **No proof of death is portable or conclusive.** `pid` may be reused (the check
  then says "alive" and the store stays locked until a human intervenes — the safe
  direction), PIDs are namespaced by container, `EPERM` means alive, and a lock
  whose metadata is truncated has no owner to check. The liveness check is verified
  on POSIX in this repository's CI only; on Windows it relies on
  `process.kill(pid, 0)`, which is not exercised by these tests.
- **No heartbeat or lease.** A lease would not add a guarantee: a paused owner
  cannot renew, so a lease would expire under a live owner — reintroducing exactly
  this bug. Leases need fencing tokens in the *data* path, which this storage
  format does not have.
- **One residual window remains.** Between an acquisition's quarantine check and its
  entry into the protected section, a simultaneous misjudgement plus a capture could
  still overlap. Closing it needs a conditional rename/delete primitive that
  portable filesystems do not provide. It is detected and reported
  (`storage_lock_unsafe`) rather than silently ignored, and it requires a liveness
  check to be wrong first.
- **Manual deletion** of a lock file, or a tool that ignores the lock, is outside
  every guarantee.
- **Local filesystems only.** `O_EXCL`, `rename`, `link`, PID visibility and
  timestamps are not dependable over NFS/SMB or across containers.

## Alternatives considered

- **Time-based leases with heartbeats.** Rejected: an owner that cannot run (paused,
  stopped, descheduled) cannot renew, so the lease expires while it is still inside
  the section. Without fencing in the write path this recreates the bug.
- **Keep ADR-0013 and improve restoration.** Rejected: restoration cannot prevent a
  newcomer from entering while the displaced owner is working; the guard does.
- **Never reclaim at all.** Maximally safe but wedges the store after any crash; the
  liveness check preserves recovery for the one case that can be proven.
- **`flock`/`fcntl`.** Not exposed by Node's standard library (ADR-0007).
- **SQLite with transactions and its own locking.** The correct long-term answer for
  real multi-writer concurrency, deferred by ADR-0009 for Phase 1 scale.
- **Single-writer daemon.** Removes cross-process locking entirely; out of scope.
