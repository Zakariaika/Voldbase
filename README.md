# VOLDBASE

**Universal Experiment & Verification Infrastructure for software and AI projects.**

VOLDBASE turns "it should work" into evidence. You connect a GitHub repository or
import a local software project; VOLDBASE analyzes its structure, revision,
dependencies and configuration, identifies testable components, helps you design
reproducible experiments, and records what happened when (and if) they ran.

Every verification result is classified as exactly one of:

| Status | Meaning |
| --- | --- |
| `PASS` | The experiment ran under the recorded conditions and every stated expectation was met. |
| `FAIL` | The experiment ran and at least one stated expectation was not met. |
| `INCONCLUSIVE` | The experiment ran, but the observations do not support a definitive verdict. |
| `NOT_TESTED` | No execution was attempted. |
| `BLOCKED` | Execution was attempted but could not proceed (missing toolchain, unreachable dependency, isolation unavailable, …). |

`UNKNOWN`, "probably fine" and silent omissions are not valid results. If a
component was never exercised, the honest answer is `NOT_TESTED`, and VOLDBASE
should say so.

## Project status

**Phase 0 — foundation only.** This repository currently contains the product
definition, the architecture decision records, the domain model, and a
dependency-free TypeScript domain skeleton with tests. There is **no execution
engine, no runner, and no UI** yet, and therefore no runnable product.

Do not read this repository as a claim that arbitrary projects can be verified
today. See [Scope](#scope) and the [roadmap](#roadmap).

## Scope

Initial focus is **software and AI repositories**. Universal support is a
long-term direction, not a present-tense claim: it will be earned by real use
cases proving the model generalizes, not by designing for imagined ones.

**In scope (target)**

- Importing a project from GitHub or a local path, with a pinned revision.
- Structural analysis: languages, layout, dependency manifests, configuration.
- Identifying testable components and designing reproducible experiments.
- Executing experiments in isolated environments with recorded evidence.
- Producing structured verification reports with a fixed result taxonomy.

**Explicitly out of scope for V0.1**

- A hosted multi-tenant service (the architecture keeps the door open).
- Arbitrary code execution without the isolation design in
  [ADR-0005](docs/adr/0005-execution-isolation.md). **No execution backend exists
  in this repository**, by design.
- A plugin marketplace, workflow designer, or generic entity platform.
- Claims about non-software domains.

## Architecture at a glance

VOLDBASE V0.1 is **local-first**: it runs on the user's machine, stores its own
data locally, and requires no account. It is built as a **modular monolith** with
explicit ports at every boundary, so a hosted service can later reuse the same
domain and application layers.

```
┌───────────────────────────────────────────────────────────┐
│  CLI / future web client                                  │
└──────────────────────────┬────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────┐
│  Application layer — use cases, orchestration             │
│  ├─ ports: repositories, clock, ids, executor             │
│  └─ domain services                                       │
├───────────────────────────────────────────────────────────┤
│  Domain layer — entities, invariants, result taxonomy     │
│  (pure; no I/O, no framework, no third-party runtime deps)│
└──────────────────────────┬────────────────────────────────┘
                           │ adapters
┌──────────────────────────▼────────────────────────────────┐
│  Infrastructure — local persistence, artifacts, executor  │
│  (Phase 0: in-memory adapters used by tests only)         │
└───────────────────────────────────────────────────────────┘
```

Dependency direction is strictly inward: `infrastructure → application → domain`.
The domain layer never imports from application or infrastructure.

Full detail:

- [Domain model](docs/architecture/domain-model.md)
- [Architecture decision records](docs/adr/README.md)

### Repository layout

```
.
├── docs/
│   ├── adr/                     # Architecture decision records
│   └── architecture/            # Domain model and system design
├── src/
│   ├── domain/                  # Entities, invariants, result taxonomy
│   ├── application/             # Use cases and port definitions
│   ├── infrastructure/          # Adapters (in-memory in Phase 0)
│   └── index.ts                 # Public module surface
├── tests/                       # Node test runner suites
├── .github/workflows/ci.yml     # Typecheck + tests on every PR
├── .env.example                 # Documented configuration surface
└── LICENSE                      # MIT
```

## Getting started

Requires **Node.js >= 22.18** (Node 24 or 26 recommended). There are no runtime
dependencies; `typescript` and `@types/node` are the only development
dependencies.

```bash
npm ci
npm run typecheck
npm test
```

Node's built-in type stripping runs the TypeScript sources directly, so there is
no build step yet. A distribution build is introduced in Phase 1 together with
the CLI (see [ADR-0002](docs/adr/0002-language-and-runtime.md)).

## Engineering conventions

- **No runtime dependencies without an ADR.** The core must stay installable and
  auditable offline (see [ADR-0007](docs/adr/0007-dependency-policy.md)).
- **Domain layer stays pure.** No `fs`, no `http`, no framework imports.
- **Results are typed, never thrown strings.** Domain violations raise a
  `DomainError` with a stable `code`.
- **No execution without isolation.** See
  [ADR-0005](docs/adr/0005-execution-isolation.md); a PR that shells out to user
  code before that design is implemented will be rejected.
- **Every change is a pull request.** CI must pass before merge. Branch
  protection is **not yet enabled** on `main`, so this is currently a review
  convention rather than a technical control; enabling it is a repository-settings
  task, not a code change.

## Roadmap

| Phase | Outcome |
| --- | --- |
| **0 — Foundation** (current) | Product definition, ADRs, domain model, skeleton, CI |
| 1 — Walking skeleton | Import a local project, persist it, list it; CLI surface |
| 2 — Core domain MVP | Experiments + runs end to end, isolated executor, artifacts |
| 3 — Evidence integrity | Content-addressed artifacts, reproducible environment manifests, report export |
| 4 — Production hardening | Auth/tenancy design for hosted mode, observability, backups, SLOs |
| 5 — Generalization | Only after two concrete non-software/AI use cases justify it |

## License

MIT — see [LICENSE](LICENSE). VOLDBASE V0.1 is a public, open-source project.
