
- [Phase 2A static analysis](docs/architecture/phase-2a-static-analysis.md)
- [Phase 2B architecture intelligence](docs/architecture/phase-2b-architecture-intelligence.md)
- [Execution safety specification v1](docs/security/execution-safety-specification-v1.md)
- [Architecture decision records](docs/adr/README.md)

### Repository layout

```
.
├── bin/voldbase.js              # npm CLI entry point (runs dist/)
├── scripts/
│   └── smoke-clean-checkout.mjs # clean-checkout smoke test (clone → ci → build → architecture)
├── docs/
│   ├── adr/                     # Architecture decision records
│   └── architecture/            # Domain model and system design
├── src/
│   ├── domain/                  # Entities, invariants, result taxonomy
│   ├── application/             # Use cases and port definitions
│   ├── infrastructure/          # Adapters: scanner, analyzer, JSON store, ids
│   └── index.ts                 # Public module surface
├── tests/                       # Node test runner suites
├── .github/workflows/ci.yml     # Typecheck + build + tests on every PR
├── .env.example                 # Documented configuration surface
├── LICENSE                      # Source-available license (draft)
├── CONTRIBUTING.md              # Contribution terms and consent procedure
├── NOTICE                       # Copyright, third-party and scope notices
└── TRADEMARKS.md                # Name, logo and brand-use policy
```

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit (strict, erasable syntax only)
npm run build       # tsc -p tsconfig.build.json → dist/
npm test            # node --test tests/*.test.ts
npm run check       # typecheck + build + test

# clean-checkout smoke test (see below)
npm run smoke:clean-checkout
```

`npm test` runs the sources directly through Node's type stripping. The
distribution test (`tests/dist-cli.test.ts`) spawns `bin/voldbase.js`, so run
`npm run build` first; it skips with an explicit message when `dist/` is absent.
CI runs build before tests, so nothing is skipped there.

`npm run smoke:clean-checkout` proves the first-run workflow from a state that
has never been built. It refuses to run on a dirty working tree, clones the
current commit (`HEAD` by default, or `--ref <git-ref>`) into a temporary
directory, runs `npm ci` and `npm run build` there, imports and analyses a small
prepared fixture, then runs `architecture --format json` through the built
`bin/voldbase.js`. The JSON must parse, carry canonically sorted keys, name the
fixture's files and cycles, and be byte-identical on a second run. Pass `--keep`
to inspect the temporary checkout; the command exits non-zero on any failure.
The test needs registry access for `npm ci`, nothing beyond that.

## Engineering conventions

- **No runtime dependencies without an ADR.** The core must stay installable and
  auditable offline (see [ADR-0007](docs/adr/0007-dependency-policy.md) and
  [ADR-0016](docs/adr/0016-static-analysis-boundary.md) for the one exception).
- **Domain layer stays pure.** No `fs`, no `http`, no framework imports; all
  filesystem access lives in `src/infrastructure`.
- **Results are typed, never thrown strings.** Domain violations raise a
  `DomainError` with a stable `code`.
- **No execution without isolation.** See
  [ADR-0005](docs/adr/0005-execution-isolation.md); a PR that shells out to user
  code before that design is implemented will be rejected.
- **Every change is a pull request.** CI must pass before merge. Branch protection
  is **not yet enabled** on `main`, so this is currently a review convention rather
  than a technical control; enabling it is a repository-settings task, not a code
  change.

## Roadmap

| Phase | Outcome |
| --- | --- |
| 0 — Foundation | Product definition, ADRs, domain model, skeleton, CI |
| 1 — Walking skeleton | Local import with content snapshots, durable JSON storage, `import` / `list` / `show` CLI, distribution build |
| 2A — Static analysis | Syntax-only analysis of JS/TS: declarations, import graph, explainable findings, versioned analysis snapshots, `analyze` / `analysis` CLI |
| 2B — Architecture intelligence | Derived file and module dependency graph, circular dependencies, fan-in/fan-out, explainable structural findings, `architecture` CLI with text and canonical JSON output |
| 2C — Experiments and runs (domain only) | Experiment and run records, their states and artifacts modelled and persisted end to end; **no project code is executed**, and every run records `NOT_TESTED` or `BLOCKED` |
| 3A — Execution safety specification | Trust boundaries, threat model, control matrix and negative acceptance tests for the future execution engine; documentation only, no execution capability |
| **3B — Isolation runtime decision** (current) | ADR-0019 compares rootless containers, Firecracker and Kata against the 3A controls, excludes a shared kernel as the sole boundary, and records the product choice as pending a reproducible benchmark; still no executor |
| 3C — Isolated execution engine | The executor itself, implementing the 3A controls and conformance-tested against them; may not start until 3A and 3B are accepted |
| 3D — Evidence integrity | Content-addressed artifacts, reproducible environment manifests, report export |
| 4 — Production hardening | Auth/tenancy design for hosted mode, observability, backups, SLOs |
| 5 — Generalization | Only after two concrete non-software/AI use cases justify it |

The order is binding, not advisory. **2C models experiments and runs without executing project code**; **3A** (the specification) and **3B** (the runtime decision) must both be accepted before **3C** may implement an executor (ADR-0005, ADR-0018). A change that adds execution ahead of that order is out of sequence, not an optimisation.

## License

VOLDBASE is **source-available, not open source**. The current draft license
permits personal, educational and other non-commercial use, non-commercial
modification, non-commercial contributions, and non-commercial distribution of
modified versions that are renamed, carry no official branding, state that they
are unofficial, and keep the notices. Commercial use — including internal
business use — selling, sublicensing and any commercial distribution of the
Software or of a modified version require prior written permission from the
copyright holder.

- [LICENSE](LICENSE) — the license text (draft, not legally reviewed)
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution terms and the procedure
  that records a contributor's explicit consent
- [NOTICE](NOTICE) — copyright, third-party components, prior licensing and
  current product-scope statements
- [TRADEMARKS.md](TRADEMARKS.md) — name, logo and brand-use rules

The license text is a draft: it has not been reviewed by a lawyer and is not a
claim of enforceability in any jurisdiction. Every commit on `main` up to and
including `1768aad` (2026-11-18) was distributed under the MIT License and
remains available under MIT for anyone who obtained it; the repository has no
tags and no releases, so there is no other release boundary. Versions that
include this license are offered under the draft only, from the commit that
introduces it onward — `NOTICE` section 3 records that boundary and the one part
of it that cannot be known before the change is merged. A contribution is
accepted only with a recorded, explicit acceptance of the contribution terms;
submitting a pull request alone does not record it (see
[`CONTRIBUTING.md`](CONTRIBUTING.md)). The change and its open questions are
recorded in [ADR-0020](docs/adr/0020-licensing-model.md).
