# 0003 — Modular monolith with ports and adapters

- Status: Accepted
- Date: 2026-11-15

## Context

The product is pre-implementation. Microservices would impose network boundaries,
distributed transactions and deployment overhead before a single use case is
validated. At the same time, V0.1 is local-first while the roadmap includes a
hosted service, so storage and execution must be replaceable without rewriting
business rules.

## Decision

Three layers, one deployable:

| Layer | May import | Contains |
| --- | --- | --- |
| `src/domain` | nothing outside `src/domain` (plus `node:crypto`) | Entities, invariants, result taxonomy, hashing helpers |
| `src/application` | `src/domain` | Use cases, and **port** interfaces for everything external |
| `src/infrastructure` | `src/domain`, `src/application` | Adapters: persistence, artifact storage, executor, clock, ids |

Rules:

1. Dependencies point inward only. `domain` never imports `application` or
   `infrastructure`; `application` never imports `infrastructure`.
2. Use cases receive their dependencies as an explicit `deps` object. No service
   locator, no module-level singletons.
3. Ports are narrow: one interface per capability (`ProjectRepository`,
   `RunRepository`, `Clock`, `IdGenerator`, `Executor`), not one god-interface.
4. Adapters are swappable per environment: in-memory for tests today, embedded
   storage for the CLI, PostgreSQL for a hosted deployment.
5. A module split into a separate process happens only if a measured constraint
   (CPU, memory, trust boundary) demands it.

## Consequences

- Tests run entirely in memory with no database, network, or filesystem.
- Business rules are unable to reach the network by construction, which is also a
  security property given that VOLDBASE handles untrusted repositories.
- Some duplication in adapter code is accepted in exchange for substitutability.
- Layering must be reviewed in code review; there is no enforcement tool yet.
  A lint rule is deferred until a linter is justified by a dependency ADR.

## Alternatives considered

- **Microservices.** Rejected: premature distribution for a zero-user product.
- **Framework-coupled "clean architecture".** Rejected: ceremony without a
  second consumer. Ports are introduced only where a real seam exists today.
- **Single flat `src/` directory.** Rejected: no enforceable boundary, and the
  domain purity requirement would erode within weeks.
