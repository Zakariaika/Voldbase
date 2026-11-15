# 0006 — Evidence integrity and reproducibility

- Status: Accepted
- Date: 2026-11-15

## Context

A verification report is only as good as its auditability. If an experiment
definition is edited after a run, or an artifact is overwritten, past verdicts
become unfalsifiable claims. VOLDBASE's differentiator is that a `PASS` can be
traced to what was actually executed.

## Decision

1. **Runs pin the definition they executed.** Each run stores
   `experimentDefinitionHash`, a SHA-256 over a canonical serialization of the
   experiment (steps, expectations, determinism). Editing the experiment
   afterwards does not change history.
2. **Content-addressed evidence.** Every artifact reference carries the SHA-256
   digest, byte size and media type. Digests are validated at the domain boundary
   (`src/domain/evidence.ts`); a malformed digest is a domain error.
3. **Runs are immutable once terminal.** A run in `completed`, `failed` or
   `cancelled` state cannot be overwritten; corrections are new runs, not edits.
   The in-memory repository enforces this and every adapter must.
4. **Environment is recorded, not assumed.** Each run carries an
   `EnvironmentManifest`: OS, architecture, runtime and version, plus lockfile and
   container image digests when available.
5. **`PASS`/`FAIL` require evidence.** Enforced in `completeRun`; a verdict with
   nothing attached is rejected.
6. **Canonical serialization for hashing.** Keys are sorted and `undefined` is
   omitted, so the same definition hashes identically across machines.

## Consequences

- Storage grows append-only. Retention and compaction policy is deferred, but
  deletion must never mutate an existing run — it can only remove a whole run
  or project, and that is a user action.
- Hashing in the domain layer means the domain imports `node:crypto`. This is a
  deliberate, single, documented exception to domain purity.
- Cross-machine reproduction is *supported in principle*, not guaranteed: a
  recorded manifest makes non-reproduction diagnosable rather than invisible.

## Alternatives considered

- **Mutable run records.** Rejected: destroys the audit trail, which is the point.
- **Hash only the artifacts.** Rejected: allows the procedure to drift while the
  verdict still looks attached to old evidence.
- **Signing keys / attestations.** Deferred: valuable for third-party trust, but
  requires an identity model that V0.1 does not have.
