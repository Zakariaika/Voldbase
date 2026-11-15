# 0009 — Local storage format

- Status: Accepted
- Date: 2026-11-15

## Context

Phase 1 needs project metadata to survive restarts, on a user's machine, with no
cloud account and no database dependency (ADR-0004, ADR-0007). The data is small
(tens to hundreds of projects of a few hundred bytes each), users must be able to
read, back up and hand-edit it, and a crash must never leave it half-written.

## Decision

1. **One JSON document per VOLDBASE home**: `projects.json`, next to any future
   artifacts. Directory created with mode `0700`, file written with mode `0600`.
2. **Versioned schema**: `{ "schemaVersion": 1, "projects": [...] }`. The version
   is stored in the file, not inferred.
3. **Ordered migrations** in `STORAGE_MIGRATIONS`. Version 0 is the pre-versioning
   layout (a bare array). A document from a *newer* schema version is rejected
   with `storage_unsupported_schema` instead of being partially read.
4. **Atomic writes**: serialize → write a temporary file in the same directory →
   `rename` over the target. In-memory state is replaced only after the rename
   succeeds, so a failed write is invisible to the caller.
5. **Validation on load**: every record is rebuilt through `createProject`, so a
   corrupted or hand-edited file cannot inject an unpinned revision or a
   malformed dependency entry. Invalid data fails with `storage_corrupted`; the
   file is never silently reset.
6. **Snapshot guard on save**: `assertProjectSnapshotCompatible` runs before the
   write, so storage cannot re-point a project id at different content.
7. **Copies at the boundary**: stored projects are cloned on save and on read, so
   a caller mutating its object cannot mutate the stored snapshot.

## Consequences

- Every save rewrites the whole document. At V0.1 scale that is microseconds, and
  it keeps the format trivially inspectable.
- Two concurrent VOLDBASE processes are not coordinated: last write wins. That is
  acceptable for a single-user CLI and must be revisited before any daemon or
  hosted mode writes the same file.
- No transactions across entities. Projects are the only persisted entity today;
  experiments and runs will need a layout decision (per-document vs per-record)
  in Phase 2.
- A durable relational adapter can replace this behind `ProjectRepository`
  without touching the domain or the CLI.

## Alternatives considered

- **SQLite** (`node:sqlite` or better-sqlite3). Better concurrency and querying,
  but it is a new storage dependency and a schema/migration system of its own.
  Deferred until there is a query or concurrency need; the port already isolates
  the choice.
- **One file per project.** Smaller writes, but makes the "all projects saved"
  invariant harder and adds a directory scan on every `list`.
- **YAML.** No standard-library parser, and hand-editing is a marginal benefit over
  JSON for machine-written data.
