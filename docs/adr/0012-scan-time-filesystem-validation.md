# 0012 — Scan-time filesystem validation (TOCTOU)

- Status: Accepted
- Date: 2026-11-15

## Context

The scanner walks a user-supplied directory. A path is not a stable object: between
`lstat(path)` (the check) and `readFile(path)` (the use), the entry can be replaced
by a symbolic link pointing at `~/.ssh/id_rsa`, by a different file, or deleted.
Checking the path and then reading the path leaves that window open, and a snapshot
that silently hashed something else would be a false record — the whole product is
about evidence.

Two adversarial shapes matter:

1. **Link substitution.** Discovery sees a regular file; by read time it is a symlink
   to a file outside the project. Following it would read data the user never
   imported.
2. **Identity substitution.** The path is re-pointed at another regular file whose
   content is hashed while the snapshot still claims the original entry.

## Decision

1. **Never follow symbolic links.** A `Dirent` that is a symlink is counted and
   skipped; no `stat`, `readFile` or traversal ever happens through it.
2. **Open with `O_NOFOLLOW`.** Files are opened with
   `O_RDONLY | O_NOFOLLOW`, so a substitution between discovery and open fails with
   `ELOOP` instead of silently opening the target. On platforms without the flag
   (Windows) it degrades to `O_RDONLY` and step 4 is what protects the read.
3. **Validate the descriptor, not the path.** Immediately after opening, `fstat`
   the handle and require: it is a regular file; its size is within the per-file
   limit; and, where the platform reports meaningful inode numbers, its
   `dev` + `ino` match the entry discovered moments earlier. A mismatch means the
   path was re-pointed, and the scan aborts.
4. **Read from the validated handle.** Bytes are read from the same descriptor that
   was validated, so the content cannot be swapped again after the check.
5. **Directories are re-checked before traversal.** Each directory is `lstat`-ed
   immediately before `readdir` and must still be a real directory (not a symlink).
6. **Fail loudly, once.** Any detection raises `scan_entry_changed` (a discovered
   entry that vanished, changed type or changed identity) and aborts the whole
   import. There is no partial snapshot, no retry loop and no silent skip: the user
   re-runs the import against a tree that is not moving.
7. **No execution.** Nothing from the scanned tree is imported, evaluated or run;
   the scanner only opens, hashes and closes.

## Consequences

- Content reads are protected end to end: a swapped symlink or a swapped file is
  detected before any byte is hashed.
- **Residual limitation — directories.** Node exposes no `openat`/`fdopendir`, so
  between the `lstat` and the `readdir` of a directory there remains a narrow
  window in which it could be replaced by a symlink. The scanner re-validates as
  late as it can; closing the window fully would require a native binding or a
  container, which ADR-0007/ADR-0005 do not justify for Phase 1. This is documented
  in the README rather than glossed over.
- **Platform difference.** `O_NOFOLLOW` is POSIX-only; on Windows the post-open
  `fstat` identity check is the sole protection, and filesystems that report
  `ino === 0` make identity comparison impossible — the scanner then relies on the
  type and size checks and documents that a same-size replacement may go unnoticed.
- A project that is genuinely being edited during an import now fails instead of
  producing a snapshot of an inconsistent moment. That is the intended trade.
- The `beforeRead` hook exists so tests can reproduce the race deterministically;
  production code never sets it.

## Alternatives considered

- **Check, then read the path** (status quo). Rejected: the defect this ADR exists
  to remove.
- **Copy the tree, then hash the copy.** Too expensive (doubles I/O and disk use)
  and does not protect the copy step against the same race.
- **Walk twice and compare digests.** Detects changes after the fact but still
  reads the substituted file first, and doubles the work.
- **Native `openat`/`fdopendir` bindings.** Would close the directory window, but a
  native dependency for a rare race is not justified under ADR-0007.
- **Refuse to scan any directory that is being written to.** There is no portable
  way to ask that question.
