# 0013 — Lock removal by capture, verification and restore

- Status: Accepted
- Date: 2026-11-15
- Supersedes: [0011](0011-storage-write-locking.md) (removal mechanism; acquisition, timeouts and the in-lock re-read are retained)

## Context

ADR-0011 removed locks with a check-then-delete sequence: read the owner token (or
re-read device + inode and age), then `unlink` the path. Both `releaseLock()` and
`reclaimStaleLock()` had the same defect, and it is the dangerous direction:

```
process A: read lock     → sees its own token         (check)
process B: (A's lock was reclaimed) creates a new lock at the same path
process A: unlink(path)  → deletes B's live lock       (use)
```

B now believes it holds the store exclusively while A believes it has released
it, and a third process can acquire it too. The same shape applies to stale
reclaim: the lock can be replaced between the final identity check and the
`rm`. Widening or repeating the check cannot fix this; the problem is that the
object verified (an inode at time T) and the object deleted (whatever the name
points at at time T+1) are not the same object.

## Decision

Never delete a name that was merely inspected. Every removal is two-phase.

1. **Capture.** `rename(lockPath, quarantinePath)` moves whatever inode is at the
   path into a fresh name (`<lock>.release-<uuid>.quarantine` or
   `<lock>.stale-<uuid>.quarantine`) in the same directory, so the rename stays on
   one filesystem and is atomic. Nothing is destroyed by capturing: the file still
   exists, under a name only this process knows.
2. **Verify the captured file.** Read the owner token and age *from the quarantine
   path*. This is now race-free: the process is the only one that can name that
   file, so no other process can swap its contents or identity out from under the
   verification.
3. **Delete or restore.**
   - Our token, or genuinely stale → `rm(quarantine)`. That deletes exactly the
     inode that was verified.
   - Not ours (ours was replaced between the pre-check and the capture) → restore
     it with `link(quarantine, lockPath)` followed by `rm(quarantine)`.
     `link` fails with `EEXIST` rather than overwriting, so a lock acquired while
     the capture was in flight is never clobbered. If the restore is refused, the
     captured file is **kept** — it is the only remaining reference to that lock,
     and deleting it would be worse than leaving a stray `.quarantine` file.

The pre-checks (token equality for release, age for reclaim) are retained purely as
an optimisation: they decide whether capturing is worth attempting. The decision
that binds the outcome is taken after capture.

**Guarantee obtained:** release and stale reclaim can only ever delete a name they
exclusively created by an atomic rename. Therefore **a newly acquired lock cannot
be deleted by another process's release or reclaim** — the failure mode above
becomes impossible.

**Residual limitation, stated honestly:** a foreign lock can be *captured*, i.e.
made briefly unavailable under its own name, in the window between the pre-check
and the rename. It is restored immediately, and a lock acquired in that same gap
is not overwritten (its restore fails with `EEXIST`). Exclusivity is never
knowingly broken, but this is not a linearizable mutex built on POSIX
`rename`/`link`: there is no compare-and-delete primitive in portable userland.
Things that remain outside the guarantee are unchanged: a process that ignores the
lock, and network filesystems whose rename/link/`O_EXCL` semantics are not local.

## Consequences

- No test can construct a sequence in which a live lock is deleted: the tests in
  `tests/lock-revoke.test.ts` reproduce the replacement window with hooks and
  assert the foreign lock survives, with its token intact.
- Removing a lock costs one extra `rename` (and one `link` in the repair case).
  Both are microseconds, inside a lock that is already held.
- An extremely rare failed repair leaves a `*.quarantine` file. It cannot block
  acquisition (the lock name itself is what is opened with `O_EXCL`), and it is
  safe to delete by hand.
- The lock's acquisition path is unchanged: `open(lockPath, 'wx')`,
  `{token, pid, hostname, acquiredAt}`, bounded polling, and the document re-read
  under the lock from ADR-0011.

## Alternatives considered

- **Keep check-then-delete, narrow the window.** Rejected: the failure deletes a
  live lock, and "narrow" is not a guarantee.
- **Delete via `unlink` only when the inode still matches a `stat` taken
  immediately before.** Still check-then-use; a rename in between is exactly the
  race.
- **`renameat2(RENAME_EXCHANGE)` / `unlinkat` with a directory fd.** Would give a
  stronger primitive on Linux only; not exposed by Node and not portable.
- **Never delete locks; expire by generation counter.** Requires reading and
  writing a counter with its own atomicity problem, and grows the lock file
  unboundedly.
- **`flock`/`fcntl` advisory locks.** Not in Node's standard library; a native
  dependency is not justified (ADR-0007).
- **Single-writer daemon.** Removes the problem by changing the architecture;
  out of scope for Phase 1.
