
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