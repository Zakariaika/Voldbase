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

**Phase 3B — isolation runtime decision.** Phases 1, 2A, 2B and 3A are implemented:
local import with reproducible snapshots, durable storage, syntax-level static
analysis, architecture intelligence, and the execution safety specification, through
the `import` / `list` / `show` / `analyze` / `analysis` / `architecture` CLI. The
current phase selects, and does not build, the future execution engine's isolation
runtime. It runs entirely on your machine: no account, no network, no telemetry.

**No project code is ever executed.** There is no executor, no install step and no
`child_process` in the product; the analyzer parses text, it does not run it, type
check it or resolve packages, and the architecture layer reads only that analysis
— never the project files again. Verifying experiments (Phases 3C onward) is still
ahead; see the [roadmap](#roadmap) and
[ADR-0005](docs/adr/0005-execution-isolation.md).

**Phase 3A adds no execution capability.** The
[execution safety specification](docs/security/execution-safety-specification-v1.md)
defines the trust boundaries, threat model, control matrix and acceptance tests a
future engine must satisfy before any project code may run. Nothing in this repository
implements it: there is no executor, no sandbox and no `PASS` — an experiment that was
never executed is `NOT_TESTED`.

**Phase 3B adds no runtime.** [ADR-0019](docs/adr/0019-isolation-runtime-selection.md)
compares rootless containers, Firecracker microVMs and Kata Containers against the
Phase 3A controls, excludes a shared kernel as the sole isolation boundary, and leaves
the product choice **pending** the reproducible benchmark it defines. No runtime, no
launcher and no sandbox dependency is added, and no project code is executed.

## What works today

```bash
$ voldbase import ~/code/demo
Imported project proj_df02e24be8d04a2390f3
  name        demo
  source      /home/me/code/demo
  revision    sha256:c5dfb407e8b95c551285a3ddcd1e4d1510fcdd9c67d8cf60f287f83644b001bf
  files       1842 (12.4 MiB)
  manifests   2
    npm       package.json                sha256:e55654f16429…
    npm       package-lock.json           sha256:9d1b0a17c3ef…
  skipped     3 excluded directories, 0 symbolic links

$ voldbase list
ID                          NAME                    REVISION              IMPORTED
proj_df02e24be8d04a2390f3   demo                    sha256:c5dfb407e8b9…  2026-11-15

$ voldbase show proj_df02e24be8d04a2390f3
Project proj_df02e24be8d04a2390f3
  name        demo
  source      local /home/me/code/demo
  revision    sha256:c5dfb407…44b001bf
  imported    2026-11-15T20:27:42.760Z
  manifests   2
    npm       package.json                sha256:e55654f1…
    npm       package-lock.json           sha256:9d1b0a17…

$ voldbase analyze proj_df02e24be8d04a2390f3
Analysed project proj_df02e24be8d04a2390f3 (demo)
  project      proj_df02e24be8d04a2390f3
  revision     sha256:c5dfb407e8b9…
  analyzer     1.0.0
  analysed     2026-11-16T09:00:00.000Z
  source       184 source files (javascript, typescript)
  declarations 1204
  imports      638 (512 resolved)
  findings     9 (0 error, 7 warning, 2 info)
  digest       sha256:41c0a7…
  Note: syntax-level analysis only. No findings does not mean the code is safe.
  voldbase analysis ana_7f31…   # findings in detail

$ voldbase analysis ana_7f31…
Analysis ana_7f31…
  …the same summary…
SEVERITY  RULE    LOCATION                                   EXPLANATION
WARNING   VB002   src/index.js:1:24                          This relative import does not
                                                             match any analysed file…
          evidence: ./missing

$ voldbase architecture ana_7f31…
Architecture of analysis ana_7f31…
  project     proj_df02e24be8d04a2390f3
  revision    sha256:c5dfb407e8b9…
  analysis    sha256:8eee98350f90…
  engine      1.0.0 (schema 1)
  files       61
  graph       192 edges, 194 imports merged
  modules     10
  cycles      0 (largest 0)
  isolated    2 files, 1 modules
  fan-in/out  max 28 / 29
  findings    17 (0 error, 0 warning, 17 info)
  digest      sha256:1d78a613b081…

MODULES (10)
ID                                FILES  FAN-IN  FAN-OUT  ISOLATED
src/application                   6      5       1        no
src/domain                        11     6       0        no
…

FINDINGS (17)
SEVERITY  RULE   CERTAINTY    SUBJECT              EXPLANATION
INFO      VA003  conditional  src/cli/main.ts      This file imports 18 other internal files…
          evidence: src/cli/main.ts -> src/application/ports.ts
…
```

## Installation

Requires **Node.js >= 22.18** (24 or 26 recommended). The package has exactly one
runtime dependency: `typescript`, used as the parser for JavaScript and TypeScript
(justified in [ADR-0016](docs/adr/0016-static-analysis-boundary.md)). It installs
no scripts and needs no network at run time.

```bash
npm ci          # install the runtime dependency (typescript) and @types/node
npm run build   # emit the distribution to dist/ (ADR-0010)
npm link        # optional: put `voldbase` on your PATH

# or run the built CLI directly
node bin/voldbase.js import ./some-project
```

From a checkout, `node bin/voldbase.js …` and `npx voldbase …` (after `npm link`)
are equivalent.

## CLI

| Command | Description |
| --- | --- |
| `voldbase import <path>` | Scan a directory and store its snapshot |
| `voldbase import <path> --name "Project Name"` | Same, with an explicit name |
| `voldbase list` | List imported projects |
| `voldbase show <project-id>` | Show one project in detail |
| `voldbase analyze <project-id>` | Statically analyse an imported snapshot (no execution) |
| `voldbase analysis <analysis-id>` | Show a stored analysis: summary and findings |
| `voldbase architecture <analysis-id>` | Derive the file/module dependency graph from a stored analysis |
| `voldbase architecture <analysis-id> --format json` | Same model as canonical JSON |
| `voldbase help` | Usage (also shown when no arguments are given) |

`<path>` may be absolute or relative to the current directory. Exit codes: `0`
success, `1` runtime failure (missing path, unreadable file, storage error), `2`
usage error (unknown command or option, missing/extra arguments). Errors are
printed to stderr with the error code, for example:

```
error: /home/me/missing does not exist
  code: path_not_found
```

### Duplicate imports

A project is an immutable snapshot, so the same directory cannot silently change
under the same id:

| Situation | Result |
| --- | --- |
| Re-import, contents unchanged | `Already imported: <id>` |
| Re-import, contents changed | Refused; tells you to import with `--name` |
| Re-import, contents changed, new `--name` | Recorded as a new project |
| Two directories with identical contents | Two projects |

## Storage

Everything lives under `VOLDBASE_HOME` (default `~/.voldbase`):

```
~/.voldbase/
├── projects.json      # schemaVersion + imported projects
└── analyses.json      # schemaVersion + analysis snapshots (append-only)
```

Override it for a portable or throwaway store:

```bash
VOLDBASE_HOME=/tmp/voldbase-dev voldbase import ./demo
```

The store is **versioned** (`schemaVersion: 1`), **migrated** forward when an
older layout is found (version 0 = a bare array), **written atomically** (temporary
file + rename), and **validated on load** — a corrupted file fails with
`storage_corrupted` instead of being silently discarded. A document written by a
newer VOLDBASE is refused rather than partially read. Format details:
[ADR-0009](docs/adr/0009-local-storage-format.md).

**Concurrent writes are serialized.** A `projects.json.lock` file is created with
`O_EXCL` around each read-modify-write; the store is re-read while the lock is held,
so two `voldbase` processes cannot lose each other's projects. Waiting is bounded
(5 s by default).

A lock is recovered only when its owner is **provably gone** — same host and a PID
that no longer exists — never merely because the lock is old. A paused, stalled or
long-running writer therefore keeps its exclusion. If a lock is ever displaced while
its owner is alive, the displaced file blocks every other writer
(`storage_lock_unsafe`) until that owner releases, instead of admitting a second
writer; release never deletes or moves a lock it does not own. The quarantine check
fails closed: a lock directory that cannot be listed, or a quarantined file that
cannot be read, refuses entry rather than being treated as empty. Limits that matter:
a PID check cannot prove death across PID namespaces/containers or reused PIDs (the
store then stays locked until a human removes the file), the check is POSIX-verified
only, and this is cooperative locking for local filesystems — a tool that ignores
the lock can still overwrite the store. See
[ADR-0015](docs/adr/0015-liveness-based-lock-recovery.md).

### Analysis storage

Analyses live in their own document, `analyses.json`, so a damaged analysis file
can never affect project data. They are append-only and content-addressed: an
analysis id may not be re-saved with different content (`analysis_immutable`), and
every snapshot's digest is recomputed when it is loaded — a file that was edited by
hand is refused with `analysis_corrupted` rather than displayed as evidence.
Writes are atomic and use the same lock as projects. Details:
[Phase 2A architecture](docs/architecture/phase-2a-static-analysis.md).

**Architecture models are not stored.** `voldbase architecture` derives them from a
stored analysis on demand and prints them; the result is a pure function of that
analysis (no timestamp, no generated id), so re-running the command reproduces the
same model and digest. See
[ADR-0017](docs/adr/0017-architecture-intelligence.md).

## Supported dependency manifests

| Ecosystem | Files |
| --- | --- |
| `npm` | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` |
| `pypi` | `requirements.txt`, `pyproject.toml`, `poetry.lock` |
| `cargo` | `Cargo.toml`, `Cargo.lock` |
| `gomod` | `go.mod`, `go.sum` |
| `composer` | `composer.json`, `composer.lock` |

Manifests are found at any depth. Phase 1 records their path, ecosystem and
SHA-256 digest; it does not parse or resolve dependencies.

## How the snapshot revision works

The revision describes **the imported bytes**, not the Git HEAD — an uncommitted
working tree is described by what is actually on disk.

1. Each included file is hashed with SHA-256.
2. A canonical manifest is built, one line per file, sorted by relative path:
   `<file sha256>  <size>  <relative path>`.
3. The snapshot revision is the SHA-256 of that manifest.

The digest is deterministic, independent of absolute paths (two copies of a tree
share a revision) and sensitive to any content, addition or removal. See
[Phase 1 architecture](docs/architecture/phase-1-import-and-storage.md).

## Scanner limitations

- **Excluded directories** are never traversed: `.git`, `.hg`, `.svn`,
  `node_modules`, `vendor`, `dist`, `build`, `coverage`, `target`, `.cache`,
  `.next`, `.nuxt`, `.turbo`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`,
  `.mypy_cache`, `.ruff_cache`, `.gradle`, `.terraform`.
- **Symbolic links are skipped**, never followed (they are reported in the
  import summary). Files are opened with `O_NOFOLLOW` where the platform has it,
  the open descriptor is validated (type, device/inode, size), and the path is
  checked again after the read, so an entry swapped for a link or another file
  mid-scan aborts the import with `scan_entry_changed` instead of hashing the wrong
  content. That post-read check is what protects Windows, where `O_NOFOLLOW` does
  not exist; the one case it cannot prove is a same-size regular-file swap on a
  filesystem that reports no inode numbers. Directory entries are re-checked
  immediately before traversal; that check cannot be made atomic with Node's
  standard library, so a directory replaced *during* the scan is a documented
  residual window ([ADR-0014](docs/adr/0014-bounded-reads-and-path-revalidation.md)).
- **Limits**: 20 000 files, 256 MiB total, 8 MiB per file by default. Exceeding a
  limit aborts the import rather than storing a partial snapshot. Limits are
  enforced on the bytes actually read (in 64 KiB chunks), so a file that grows
  after the size check aborts the scan instead of being read in full.
- An empty directory (or one containing only excluded entries) is rejected with
  `empty_project`.
- File modes, ownership, and empty directories are not represented; only regular
  file contents are hashed.
- A project that changes on disk *during* a scan aborts the import with
  `scan_entry_changed`; re-run the import against a stable tree.

### Analysis limits

The analyzer reuses the scanner's walk and reader, and adds one bound of its own:

| Limit | Default | On exceeding |
| --- | --- | --- |
| Files | 20 000 | `scan_limit_exceeded` |
| Total bytes | 256 MiB | `scan_limit_exceeded` |
| Per file | 8 MiB | `file_too_large` |
| Source files parsed | 5 000 | `analysis_limit_exceeded` |

Every limit aborts the analysis; none of them silently produces a partial result.

## Security model

- **No execution.** VOLDBASE never runs `npm install`, `pip install`, `cargo
  build`, project scripts, tests or any other code from the imported project.
  `src/` contains no `child_process` import. The analyzer parses source text with
  the TypeScript Compiler API over an in-memory host: no `tsconfig` is loaded, no
  module is resolved, no package is installed.
- **Untrusted input stays data.** Parsed sources are never evaluated; findings are
  syntax-level observations with an explicit certainty, and an analysis with no
  findings is not described as safe.
- **Architecture is derived, not re-read.** `voldbase architecture` reads only the
  stored analysis through the repository port: it opens no project file, re-parses
  no source and resolves nothing. Every model records the analysis id and digest it
  came from.
- **Execution safety is specified, not implemented.** The
  [execution safety specification](docs/security/execution-safety-specification-v1.md)
  states how a future engine must isolate runs: no host execution and no bypass mode,
  network off by default, an explicit mount allowlist, mandatory resource limits,
  digest-pinned images with attested toolchain identity, evidence collected outside
  the sandbox, cleanup owned by an independent reconciler, and a verdict decided by
  a fixed precedence independently of the executed program. No part of it is code yet.
- **No secrets collected.** Only relative paths, byte sizes and SHA-256 digests are
  stored. File contents are hashed in memory and never persisted or logged; the
  imported project's environment variables are never read.
- **Local-only.** No network calls, no account, no telemetry.
- **Read-only.** Importing and analysing write nothing outside `VOLDBASE_HOME`.

This is *analysis* security, not *execution* security. Running untrusted code is a
separate problem with nine mandatory preconditions in
[ADR-0005](docs/adr/0005-execution-isolation.md); until they are implemented and
tested, there is no executor.

## Architecture at a glance

VOLDBASE V0.1 is **local-first**: it runs on your machine, stores its own data
locally, and requires no account. It is a **modular monolith** with explicit ports
at every boundary, so a hosted service can later reuse the same domain and
application layers.

```
┌───────────────────────────────────────────────────────────┐
│  CLI (src/cli) / future web client                        │
└──────────────────────────┬────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────┐
│  Application layer — use cases, orchestration             │
│  ├─ ports: repositories, scanner, analyzer, clock, ids    │
│  └─ ProjectImportService, ProjectAnalysisService          │
├───────────────────────────────────────────────────────────┤
│  Domain layer — entities, invariants, result taxonomy     │
│  (pure; no I/O, no framework, no third-party runtime deps)│
└──────────────────────────┬────────────────────────────────┘
                           │ adapters
┌──────────────────────────▼────────────────────────────────┐
│  Infrastructure — scanner, analyzer, JSON storage, ids    │
└───────────────────────────────────────────────────────────┘
```

Dependency direction is strictly inward: `infrastructure → application → domain`.
The domain layer never imports from application or infrastructure, and no
filesystem API appears outside `src/infrastructure`.

Further reading:

- [Domain model](docs/architecture/domain-model.md)
- [Phase 1 import and storage](docs/architecture/phase-1-import-and-storage.md)
- [Phase 2A static analysis](docs/architecture/phase-2a-static-analysis.md)
- [Phase 2B architecture intelligence](docs/architecture/phase-2b-architecture-intelligence.md)
- [Execution safety specification v1](docs/security/execution-safety-specification-v1.md)
- [Architecture decision records](docs/adr/README.md)

### Repository layout

```
.
├── bin/voldbase.js              # npm CLI entry point (runs dist/)
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
```

`npm test` runs the sources directly through Node's type stripping. The
distribution test (`tests/dist-cli.test.ts`) spawns `bin/voldbase.js`, so run
`npm run build` first; it skips with an explicit message when `dist/` is absent.
CI runs build before tests, so nothing is skipped there.

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
permits personal, educational and other non-commercial use, personal
non-commercial modification, and non-commercial contributions. Commercial use
— including internal business use — selling, sublicensing and commercial
redistribution each require prior written permission from the copyright holder.

- [LICENSE](LICENSE) — the license text (draft, not legally reviewed)
- [NOTICE](NOTICE) — copyright, third-party components, prior licensing and
  current product-scope statements
- [TRADEMARKS.md](TRADEMARKS.md) — name, logo and brand-use rules

The license text is a draft: it has not been reviewed by a lawyer and is not a
claim of enforceability in any jurisdiction. Versions distributed before this
license were published under the MIT License and remain available under MIT for
anyone who obtained them; versions that include this license are offered under
the draft only. The change and its open questions are recorded in
[ADR-0020](docs/adr/0020-licensing-model.md).
