# Phase 1 — local import, snapshots and storage

This document describes what the Phase 1 CLI actually does. The domain model is
unchanged ([domain-model.md](domain-model.md)); Phase 1 adds adapters and one use
case around it.

```
voldbase import <path>
        │
        ▼
  CLI (src/cli)                       parse args, render text, map errors to exit codes
        │  ImportProjectCommand
        ▼
  ProjectImportService                policy: naming, duplicates, snapshot creation
        │  scan(path)          │  save(project)            │ now() / next()
        ▼                      ▼                           ▼
  LocalProjectScanner     JsonProjectRepository     SystemClock / RandomIdGenerator
  (infrastructure/fs)     (infrastructure/fs)       (infrastructure)
        │
        ▼
  project directory (read-only: stat, readdir, readFile)
```

Dependencies point inward only. The use case never imports `node:fs`, and the
domain still knows nothing about files, paths or JSON.

## 1. Scanning rules

A scan is **read-only**. VOLDBASE opens files for reading, hashes the bytes and
closes them. It never installs dependencies, never executes scripts or project
code, and never runs a package manager.

**Included**

- Every regular file under the given directory, at any depth.

**Excluded — never traversed** (matched on the directory name at any depth):

```
.git .hg .svn node_modules vendor dist build coverage target
.cache .next .nuxt .turbo .venv venv __pycache__
.pytest_cache .mypy_cache .ruff_cache .gradle .terraform
```

**Skipped**

- Symbolic links, both to files and to directories. They are counted and reported
  but never followed, so a link cannot point the scan outside the project, loop,
  or resolve differently later.
- Sockets, FIFOs and device files, which are not project content.

**Limits** (`DEFAULT_SCANNER_LIMITS`, overridable per scanner instance)

| Limit | Default | Behavior when exceeded |
| --- | --- | --- |
| Files per snapshot | 20 000 | `scan_limit_exceeded`, import aborts |
| Total bytes | 256 MiB | `scan_limit_exceeded`, import aborts |
| Single file | 8 MiB | `file_too_large`, import aborts |

Limits abort rather than truncate. A snapshot that silently omitted files would
claim to describe a project it never read.

**Errors are explicit.** A missing path, a file instead of a directory, an
unreadable file or directory, and an empty result all fail with a code
(`path_not_found`, `not_a_directory`, `path_unreadable`, `empty_project`) instead
of producing an empty or partial snapshot.

**Verified, bounded reads (TOCTOU).** Discovery and read are separated in time, so
the scanner does not trust the path twice. Files are opened with `O_NOFOLLOW`
(where the platform provides it), the open descriptor is validated (`fstat`: still
a regular file, same `dev`/`ino` as discovered, within the allowance), the bytes are
read from that same descriptor in 64 KiB chunks with the limits enforced on what is
actually read, and the path is re-checked with `lstat` after the read. A symlink
substituted at any point fails (`ELOOP` at the open, or the symlink seen by the
post-read `lstat` — the case that protects Windows, which has no `O_NOFOLLOW`); a
file swapped for another fails the identity check. Either way the whole import
aborts with `scan_entry_changed` rather than hashing something the user did not
import. Directories are `lstat`-ed immediately before `readdir` for the same
reason. See [ADR-0014](../adr/0014-bounded-reads-and-path-revalidation.md) for the
remaining limitations, including the directory-level window.

**Limits are enforced on bytes read, not on a remembered size.** The allowance for
a file is `min(maxFileBytes, remaining total budget)`; the read stops at the first
chunk that crosses it, so a file that grows after the `fstat` is never buffered in
full. `file_too_large` and `scan_limit_exceeded` both abort the import.

**Path handling.** Relative paths are resolved against the process working
directory, then canonicalized with `realpath`, so the stored `source.location` is
absolute and stable. The project name defaults to the directory name and can be
overridden with `--name`.

## 2. Snapshot revision

The revision answers "exactly which bytes did we import?" — not "which commit?".
An imported working tree with uncommitted changes is described by its contents.

For each included file, the scanner computes the SHA-256 of the file's bytes. It
then builds a canonical manifest, one line per file, sorted by relative path:

```
<file sha256>  <size in bytes>  <relative path, POSIX separators>
```

The **snapshot revision is the SHA-256 of that manifest**, encoded as UTF-8 with a
trailing newline. Properties:

- **Deterministic**: same contents, same revision, regardless of filesystem order.
- **Location-independent**: absolute paths never enter the digest, so two copies of
  a tree share a revision.
- **Content-sensitive**: changing, adding or removing any included byte changes it.
- **Sorted by code unit**, not by locale.

Manifest files (`package.json`, `Cargo.lock`, …) additionally store their own
individual digest, so a dependency change is visible without re-scanning.

## 3. Supported manifests

| Ecosystem | File names |
| --- | --- |
| `npm` | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` |
| `pypi` | `requirements.txt`, `pyproject.toml`, `poetry.lock` |
| `cargo` | `Cargo.toml`, `Cargo.lock` |
| `gomod` | `go.mod`, `go.sum` |
| `composer` | `composer.json`, `composer.lock` |

Manifests are detected at any depth (monorepos keep them under `packages/*`). The
manifest *contents* are not parsed in Phase 1: only presence, path, ecosystem and
digest are recorded.

## 4. Storage

Location: `$VOLDBASE_HOME/projects.json`, default `~/.voldbase/projects.json`.
`VOLDBASE_HOME` accepts an absolute path, a relative path (resolved against the
working directory) or `~/…`. It exists so tests and users can keep state elsewhere;
nothing else is read from the environment.

```json
{
  "schemaVersion": 1,
  "projects": [
    {
      "id": "proj_df02e24be8d04a2390f3",
      "name": "demo",
      "source": { "kind": "local", "location": "/home/me/demo" },
      "revision": "c5dfb407…",
      "dependencies": [
        {
          "ecosystem": "npm",
          "manifestPath": "package.json",
          "digest": "e55654f1…"
        }
      ],
      "configuration": {},
      "createdAt": "2026-11-15T20:27:42.760Z"
    }
  ]
}
```

Guarantees (see [ADR-0009](../adr/0009-local-storage-format.md)):

- **Atomic**: temporary file + rename; a crash leaves the previous document.
- **Validated on load**: every record is rebuilt through the domain factory, so a
  corrupted file fails with `storage_corrupted` and is never silently reset.
- **Immutable snapshots**: a project id cannot be re-pointed at other content;
  that is rejected by the same guard the in-memory adapter uses.
- **Migrated, not guessed**: version 0 (a bare array) migrates to version 1;
  a newer `schemaVersion` is refused rather than partially read.
- **Writes are serialized across processes** by a lock file
  (`projects.json.lock`, created with `O_EXCL`, default timeout 5 s, abandoned
  after 30 s). The document is re-read while the lock is held, so a concurrent
  writer cannot be overwritten by a stale in-memory copy.
- **A live lock cannot be deleted by another process.** Release and stale reclaim
  capture the lock with an atomic `rename` to a private `*.quarantine` name, verify
  the captured file, then delete it — restoring it with `link` (which never
  overwrites) if it belonged to someone else. See
  [ADR-0013](../adr/0013-lock-capture-and-restore.md).

The storage document holds no file contents, only paths and digests.

## 5. Duplicate imports

| Situation | Result |
| --- | --- |
| Same directory, same contents | No-op; reports `Already imported: <id>` |
| Same directory, contents changed, no `--name` | Refused (`project_changed`) with a hint to use `--name` |
| Same directory, contents changed, new `--name` | New project at the new revision |
| Same directory, same contents, different `--name` | Refused (`project_name_conflict`) |
| Different directories, same contents | Two independent projects |

## 6. Security model

- **No execution.** There is no `child_process` import anywhere in `src/`. No
  package manager, no build, no test runner is invoked against an imported project.
  `Executor` remains a port with no implementation (ADR-0005).
- **No secrets collected.** Only relative paths, sizes and SHA-256 digests are
  stored. File contents are read into memory to be hashed and are never persisted,
  never logged, and no environment variable of the *imported* project is read.
  VOLDBASE's own environment is read only for `VOLDBASE_HOME`.
- **No network.** The CLI makes no network calls and requires no account.
- **Containment.** Symbolic links are not followed; excluded directories are not
  traversed; limits bound the work and the bytes read.
- **Read-only on the imported tree.** Import mutates nothing outside
  `$VOLDBASE_HOME`.

Known limits of this model: the digest covers file contents, not file modes or
ownership; a project that changes *during* a scan now aborts the import
(`scan_entry_changed`) instead of producing a snapshot of an inconsistent moment;
two VOLDBASE processes writing the store are serialized by the lock file, but an
external editor or a tool that ignores the lock can still overwrite it; the lock's
exclusivity assumes a local filesystem, not NFS/SMB; and on a filesystem that
reports no inode numbers, a same-size regular-file swap cannot be distinguished
from the file that was validated (symbolic-link substitution still is).

## 7. CLI

| Command | Behavior |
| --- | --- |
| `voldbase import <path> [--name "Name"]` | Scan, store, print snapshot summary |
| `voldbase list` | Table of imported projects, sorted by name |
| `voldbase show <project-id>` | Full detail, including manifest digests |
| `voldbase help` / no arguments | Usage text |

Exit codes: `0` success, `1` runtime failure (path, scan, storage), `2` usage
error (unknown command, missing or extra arguments, unknown option).
