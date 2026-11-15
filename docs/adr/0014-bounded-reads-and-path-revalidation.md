# 0014 — Bounded reads and post-read path revalidation

- Status: Accepted
- Date: 2026-11-15
- Supersedes: [0012](0012-scan-time-filesystem-validation.md) (read path); the
  no-symlink rule, `O_NOFOLLOW` open and descriptor validation are retained

## Context

ADR-0012 validated the open descriptor and then read it with `handle.readFile()`,
and it checked the per-file limit against the size observed *before* the read.
Two problems remained:

1. **The size check is an observation, not a bound.** A file can grow between
   `fstat` and the read (a log, a build artefact, an attacker with write access to
   the imported tree). `readFile()` then buffers the whole thing, so a file that
   passed a 8 MiB check could pull gigabytes into memory, and the total-budget
   check only ran afterwards — the oversized file was already fully read.
2. **`O_NOFOLLOW` is POSIX-only.** On Windows the flag degrades to `0`, leaving
   only `fstat` identity checks. On a filesystem that reports `ino === 0` (or when
   the entry is swapped after the open), the scanner had no second look at the path
   and could hash the content behind a substituted link.

## Decision

**Reads are bounded by the budget, not by a remembered size.**

1. The read allowance for a file is `min(maxFileBytes, maxTotalBytes − bytesReadSoFar)`.
   A file with no budget left fails immediately, before any I/O.
2. Bytes are pulled in 64 KiB chunks (`FileHandle.read` into a reused buffer, with
   a chunk capped at `allowance + 1`). The running total is compared against the
   allowance after each chunk, and the scan aborts on the first chunk that crosses
   it — an oversized file is never fully buffered.
3. The limit is enforced again after the last byte is read, so the code does not
   rely on the loop's arithmetic alone.
4. `file_too_large` is reported when the per-file limit is what was exceeded;
   `scan_limit_exceeded` when the total budget was. Both abort the import.
5. Hashing is unchanged: the same bytes, hashed once, in path order, so revisions
   stay deterministic and match those produced before this change.

**The path is re-validated after the read.**

6. After the last chunk, `lstat(path)` must still describe a regular file that is
   not a symbolic link, and — where inode numbers are meaningful — the same
   `dev`/`ino` as the descriptor that produced the bytes.
7. This is what protects platforms without `O_NOFOLLOW`: a substituted symlink is
   visible as a symlink to `lstat` even when the open could not refuse it, and the
   scan aborts before the bytes are hashed. The same check catches a same-inode
   path re-pointing on POSIX in the narrower window after the open.

## Consequences

- Memory use per file is bounded by the limit, not by the file. A growing file
  costs at most one chunk of over-read.
- A file that grows across the limit mid-read aborts the import with
  `file_too_large`; the user re-runs against a stable tree. A file that grows but
  stays within the limit produces a snapshot of the bytes actually read, which is
  consistent with the documented "revision describes the imported bytes".
- Deterministic digests and all existing scanner tests are unchanged.
- **Residual limitations.** On Windows without `O_NOFOLLOW`: if an attacker
  replaces a regular file with *another regular file* of the same size, and the
  filesystem reports no usable inode numbers, identity cannot be proven and the
  read may come from the substituted file. The scanner never follows a symlink
  silently — that case is always detected — but "same-size regular file swap on a
  filesystem without inode identity" is a documented gap, not a guarantee. Node
  exposes no `openat`/`fdopendir`, so the directory `lstat` → `readdir` window
  from ADR-0012 also remains.
- Nothing from the scanned tree is executed or imported; the reader only opens,
  reads, hashes and closes.

## Alternatives considered

- **Trust `fstat().size`, keep `readFile()`.** Rejected: the defect.
- **`readFile()` then check the buffer length.** Rejected: the memory has already
  been consumed, which is the failure being prevented.
- **Reject files whose size is not stable across two stats.** Still a check-then-use
  window, and forces two passes over every file.
- **Windows `CreateFile` with `FILE_FLAG_OPEN_REPARSE_POINT`.** Requires a native
  binding; not available through Node's `fs` API (ADR-0007).
- **Copy the tree first, then hash the copy.** Doubles I/O and does not remove the
  copy-time race.
