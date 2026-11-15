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

**Phase 1 — a working local CLI.** You can import a local project, get a
reproducible SHA-256 snapshot of its contents, see its detected dependency
manifests, store it durably, and list or inspect it later. It runs entirely on
your machine: no account, no network, no telemetry.

**No project code is ever executed.** There is no executor, no install step and no
`child_process` in the product. Verifying experiments (Phases 2–3) is still ahead;
see the [roadmap](#roadmap) and [ADR-0005](docs/adr/0005-execution-isolation.md).

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
```

## Installation

Requires **Node.js >= 22.18** (24 or 26 recommended). The package has **zero
runtime dependencies**.

```bash
npm ci          # install the two dev dependencies (typescript, @types/node)
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
└── projects.json      # schemaVersion + imported projects
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
  import summary).
- **Limits**: 20 000 files, 256 MiB total, 8 MiB per file by default. Exceeding a
  limit aborts the import rather than storing a partial snapshot.
- An empty directory (or one containing only excluded entries) is rejected with
  `empty_project`.
- File modes, ownership, and empty directories are not represented; only regular
  file contents are hashed.
- A project that changes on disk *during* a scan still produces a consistent
  snapshot (each file is read once), but it may not match any single point in time.

## Security model

- **No execution.** VOLDBASE never runs `npm install`, `pip install`, `cargo
  build`, project scripts, tests or any other code from the imported project.
  `src/` contains no `child_process` import.
- **No secrets collected.** Only relative paths, byte sizes and SHA-256 digests are
  stored. File contents are hashed in memory and never persisted or logged; the
  imported project's environment variables are never read.
- **Local-only.** No network calls, no account, no telemetry.
- **Read-only.** Importing writes nothing outside `VOLDBASE_HOME`.

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
│  ├─ ports: repositories, scanner, clock, ids, executor    │
│  └─ ProjectImportService                                  │
├───────────────────────────────────────────────────────────┤
│  Domain layer — entities, invariants, result taxonomy     │
│  (pure; no I/O, no framework, no third-party runtime deps)│
└──────────────────────────┬────────────────────────────────┘
                           │ adapters
┌──────────────────────────▼────────────────────────────────┐
│  Infrastructure — local scanner, JSON storage, ids, clock │
└───────────────────────────────────────────────────────────┘
```

Dependency direction is strictly inward: `infrastructure → application → domain`.
The domain layer never imports from application or infrastructure, and no
filesystem API appears outside `src/infrastructure`.

Further reading:

- [Domain model](docs/architecture/domain-model.md)
- [Phase 1 import and storage](docs/architecture/phase-1-import-and-storage.md)
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
│   ├── infrastructure/          # Adapters: fs scanner, JSON store, ids
│   └── index.ts                 # Public module surface
├── tests/                       # Node test runner suites
├── .github/workflows/ci.yml     # Typecheck + build + tests on every PR
├── .env.example                 # Documented configuration surface
└── LICENSE                      # MIT
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
  auditable offline (see [ADR-0007](docs/adr/0007-dependency-policy.md)).
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
| **1 — Walking skeleton** (current) | Local import with content snapshots, durable JSON storage, `import` / `list` / `show` CLI, distribution build |
| 2 — Core domain MVP | Experiments + runs end to end, isolated executor, artifacts |
| 3 — Evidence integrity | Content-addressed artifacts, reproducible environment manifests, report export |
| 4 — Production hardening | Auth/tenancy design for hosted mode, observability, backups, SLOs |
| 5 — Generalization | Only after two concrete non-software/AI use cases justify it |

## License

MIT — see [LICENSE](LICENSE). VOLDBASE V0.1 is a public, open-source project.
