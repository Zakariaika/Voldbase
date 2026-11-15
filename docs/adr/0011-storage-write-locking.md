# 0011 — Cross-process write locking for the local store

- Status: Accepted
- Date: 2026-11-15

## Context

ADR-0009 chose a single JSON document with atomic replacement (write a temporary
file, `rename` over the target). That guarantees each *write* is all-or-nothing,
but it does not prevent a **lost update**: two processes can read the same
document, each add a project, and the second rename silently discards the first
process's record. The write is atomic; the read-modify-write cycle is not.

The Phase 1 review flagged this. Two `voldbase import` commands running at the same
time (a script, a pre-commit hook, an editor plugin, an impatient second terminal)
are enough to lose a project.

## Decision

1. **Exclusive lock file** next to the store: `projects.json.lock`, created with
   `fs.open(path, 'wx')` (`O_CREAT | O_EXCL`), which the operating system makes
   atomic. Exactly one creator wins.
2. **Owner token.** The lock contains `{ token, pid, hostname, acquiredAt }`.
   Release only removes the file when its token matches the releasing process, so
   a process can never delete another process's lock.
3. **Bounded wait.** Acquisition retries every ~25 ms (plus jitter) until a
   deadline: 5 000 ms by default. Exhausting it fails with `storage_lock_timeout`
   rather than hanging; no operation waits indefinitely.
4. **Stale recovery.** A lock older than 30 s (its `acquiredAt`, or the file's
   mtime when the metadata is unreadable) is considered abandoned — the process
   crashed between creating and releasing it. Before deleting, the lock's
   device + inode are captured and re-checked, so a lock that was released and
   re-created in between is left alone.
5. **Re-read inside the lock.** `save()` reads the document from disk *while
   holding the lock*, not from its in-process cache, and only then applies the
   snapshot guard and the write. This is what actually prevents the lost update;
   the lock alone would only serialize stale writes.
6. **Release in `finally`.** Success, guard rejection, validation error, write
   error and process-level `finally` all release. A process killed with `SIGKILL`
   cannot, which is exactly what stale recovery is for.
7. **Lock scope is one write.** The lock is never held across a project scan, a CLI
   render, or user input. Reads (`list`, `findById`) do not take it.

## Consequences

- Concurrent VOLDBASE writers on one machine, using this code, do not lose
  records. The last writer sees the others' records because it re-reads first.
- **Cooperating processes only.** An external editor, a script that writes the JSON
  directly, or a *different* tool that does not take the lock can still interleave.
- **Local filesystems only.** `O_EXCL` and timestamps are reliable locally;
  network filesystems (NFS, SMB) with attribute caching may break both exclusive
  creation assumptions and staleness detection. The store is not supported there.
- Lock files are visible state: a permanently stuck process shows up as
  `projects.json.lock`, and the error message tells the user to remove it.
- A slow write that exceeds 30 s would have its lock reclaimed while still held.
  Writes are a few kilobytes, so this is theoretical; the value is a constant in
  one place (`DEFAULT_STALE_LOCK_MS`) if it ever matters.
- The residual race in stale reclamation (between the inode check and `unlink`) is
  a narrow window on already-abandoned locks, not on live ones.

## Alternatives considered

- **Atomic rename only** (status quo). Rejected: it cannot prevent lost updates,
  which is the actual defect.
- **`flock`/`fcntl` advisory locks.** Not exposed by Node's standard library; a
  native dependency would violate ADR-0007 for a problem `O_EXCL` already solves.
- **Lock directory (`mkdir`).** Equivalent exclusivity, but directories cannot hold
  owner metadata as simply, and cleanup of a stale directory is less transparent.
- **Single-writer daemon.** A background process would serialize everything, at the
  cost of a long-lived service, lifecycle management and a new failure mode.
- **SQLite.** Real transactions and locking, but a new storage dependency deferred
  by ADR-0009 until there is a query or concurrency need beyond this one.
