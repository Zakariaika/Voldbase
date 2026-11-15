# 0004 — Local-first V0.1 with a hosted-ready seam

- Status: Accepted
- Date: 2026-11-15

## Context

Target users are developers, AI engineers, open-source maintainers and software
teams. The most sensitive thing VOLDBASE touches is **their source code and
their execution environment**. A hosted requirement would block adoption for
anyone working on private or regulated code, and would force multi-tenancy,
billing and abuse handling before the product is even useful.

Execution is also resource-heavy and machine-specific (toolchains, GPUs, local
caches). Running it where the code already lives is simpler and more faithful.

## Decision

1. **V0.1 runs entirely on the user's machine.** No account, no remote service,
   no telemetry by default.
2. **All local state lives under a single configurable root** (`VOLDBASE_HOME`),
   layout:
   ```
   $VOLDBASE_HOME/
   ├── voldbase.db        # project/experiment/run metadata
   ├── artifacts/         # content-addressed evidence blobs
   └── logs/
   ```
3. **The domain and application layers must contain no assumption of locality.**
   No direct `fs` access, no `process.env` reads outside the configuration
   adapter, no absolute paths in domain entities.
4. **Hosted mode is a future deployment of the same code**, not a fork. It
   replaces adapters (storage, identity) and adds a tenancy column; it does not
   change domain rules.
5. **Identity and tenancy are out of scope in V0.1.** No `userId` field is added
   to entities "just in case"; tenancy is introduced with an ADR when the hosted
   path is actually built.

## Consequences

- No multi-user collaboration, sharing, or server-side scheduling in V0.1.
- Data portability is the user's responsibility until export tooling exists; this
  makes an export command a Phase 3 priority.
- A future hosted mode must not silently change result semantics; the same run
  recorded locally and remotely must mean the same thing.
- Because there is no telemetry, defect discovery depends on user reports and
  reproducible local diagnostics.

## Alternatives considered

- **Hosted-only SaaS.** Rejected: blocks private code, premature ops burden.
- **Hybrid from day one.** Rejected: doubles the surface area before validation.
- **Local-first with cloud sync in V1.** Deferred: sync conflict resolution for
  append-only evidence is a real design problem, not a checkbox.
