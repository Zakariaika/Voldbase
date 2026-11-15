# Domain model

The model has three primary entities and one supporting concept.

```
Project ──1:N──▶ Experiment ──1:N──▶ Run
  ▲                                     │
  └──────── projectId ──────────────────┘
                                        ▼
                                    Evidence (content-addressed artifacts)
```

The source of truth is `src/domain/`. This document explains the intent; the
TypeScript types are normative where they differ.

---

## 1. Project

*"A software or AI repository, including its identity, revision, dependencies,
and configuration."*

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `ProjectId` | Stable, generated locally. |
| `name` | `string` | Human label; not an identifier. |
| `source` | `{ kind: 'github' \| 'local', location, ref? }` | Where the code came from. `location` is a URL or path. |
| `revision` | `RevisionId` | **Pinned** revision: a full 40-char Git commit SHA or a 64-char SHA-256 digest (lowercase hex). Never `HEAD`/`main`, never an abbreviated SHA. |
| `dependencies` | `DependencySnapshot[]` | `{ ecosystem, manifestPath, digest }`. A digest, not a resolved tree. |
| `configuration` | `Record<string, string>` | Non-secret, observed configuration. Secrets must never be stored here. |
| `createdAt` | `Date` | Injected clock. |

**Invariants**

- `revision` must be a validated immutable identifier: `git-sha1` (40 lowercase
  hex) or `sha256` (64 lowercase hex). Floating refs (`main`, `HEAD`, `latest`,
  `refs/heads/*`, `refs/tags/*`), abbreviated SHAs (`9a3f1c2`), uppercase hex and
  arbitrary hash-shaped strings (`deadbeef`) are rejected.
- **A stored snapshot is immutable.** A project id may not be re-pointed at a
  different revision, source, **name, dependency set or configuration**;
  `assertProjectSnapshotCompatible` enforces all of it, and every repository
  adapter must call it before saving. Source identity is `kind` + `location` +
  the requested `ref` (adding, dropping or changing the ref is a change), so
  `main` and `v1.0.0` are never treated as the same origin. Dependency
  comparison is order-insensitive (the set is what matters), while configuration
  comparison uses a canonical digest. `createdAt` is provenance, not content: an
  identical re-save is idempotent and keeps the original value.
- **`readonly` is compile-time only.** A caller still holds the nested `source`,
  `dependencies`, `configuration` and `createdAt` objects and can mutate them
  after handing a project over. Adapters must therefore copy on save and on every
  read (`cloneProject`), or a stored snapshot can drift without ever passing
  through the guard.
- Registering the same source at a new revision creates a **new project**. A
  project is a snapshot, not a live pointer — that is what makes a verdict
  reproducible and keeps every run attached to the code it examined.

---

## 2. Experiment

*"A defined verification procedure associated with a project."*

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `ExperimentId` | |
| `projectId` | `ProjectId` | Owning project. |
| `name` | `string` | |
| `hypothesis` | `string` | The falsifiable claim being verified. |
| `steps` | `ExperimentStep[]` | Ordered, `index` starting at 0, contiguous. |
| `determinism` | `'deterministic' \| 'statistical' \| 'unknown'` | Drives how many runs are meaningful. |
| `expectedObservations` | `string[]` | What would count as `PASS`. |
| `definitionVersion` | `number` | Starts at 1; incremented on edit. |
| `createdAt` | `Date` | |

`ExperimentStep` = `{ index, description, command? }`. A step without a command is
a manual/observational step.

**Invariants**

- At least one step; indices contiguous from 0.
- At least one expected observation — an experiment that cannot fail is not an
  experiment.
- Editing an experiment bumps `definitionVersion`. It **does not** alter existing
  runs, which pin `experimentDefinitionHash` (see ADR-0006).

---

## 3. Run

*"A specific execution of an experiment, containing its environment, inputs,
observations, results, logs, artifacts, and integrity metadata."*

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `RunId` | |
| `projectId` | `ProjectId` | Denormalized for querying. |
| `projectRevision` | `RevisionId` | The exact project revision this run verified, copied at creation so evidence stays traceable. |
| `experimentId` | `ExperimentId` | |
| `experimentDefinitionHash` | `string` | SHA-256 of the canonical experiment definition at creation. |
| `environment` | `EnvironmentManifest` | OS, arch, runtime, runtime version, lockfile digest, image digest. |
| `state` | `'queued' \| 'running' \| 'completed' \| 'failed' \| 'cancelled'` | Lifecycle, distinct from verdict. |
| `result` | `ResultStatus?` | Set only when the run reaches a verdict. |
| `startedAt` | `Date?` | |
| `finishedAt` | `Date?` | |
| `evidence` | `EvidenceRef[]` | Content-addressed artifacts. |
| `notes` | `string?` | Human context; never a substitute for a result. |

**Lifecycle**

```
queued ──start──▶ running ──complete──▶ completed   (PASS | FAIL | INCONCLUSIVE | NOT_TESTED)
                    │
                    ├──▶ failed        (BLOCKED only)
                    └──▶ cancelled     (no result)
```

Transitions are one-way. A terminal run is immutable: corrections are recorded as
new runs.

**Invariants (enforced in `src/domain/run.ts`)**

- `complete` requires `state === 'running'`.
- `complete` maps `BLOCKED` to `failed`; every other verdict maps to `completed`.
  `FAIL` therefore ends `completed` with `result: 'FAIL'` — the experiment ran and
  produced a negative observation, which is a different fact from being unable to
  run at all.
- `PASS` and `FAIL` require at least one `EvidenceRef`.
- `queued` runs have no `startedAt`; completed runs have `finishedAt >= startedAt`.
- A cancelled run never acquires a `result`.

---

## 4. Evidence

`EvidenceRef = { artifactId, sha256, mediaType, bytes, description? }`

- `sha256` is 64 lowercase hex characters; anything else is a domain error.
- Artifacts are **content-addressed**: the digest is the identity, so storage can
  deduplicate and corruption is detectable.
- Evidence is produced by the executor, never written by hand in production code.

---

## 5. Result taxonomy

Closed set (`src/domain/result.ts`):

| Status | Assigned when | Evidence required |
| --- | --- | --- |
| `PASS` | Ran; all expectations met | Yes |
| `FAIL` | Ran; at least one expectation unmet | Yes |
| `INCONCLUSIVE` | Ran; observations do not decide the hypothesis | No |
| `NOT_TESTED` | No execution attempted | No |
| `BLOCKED` | Execution attempted, could not proceed | No |

The distinction between `NOT_TESTED` and `BLOCKED` is deliberate: the first is a
gap in coverage, the second is an environmental failure. Collapsing them hides
infrastructure problems inside a coverage number.

---

## 6. Ports (application layer)

| Port | Responsibility | Phase 0 implementation |
| --- | --- | --- |
| `ProjectRepository` | Save/find/list projects; rejects any change to a stored snapshot | In-memory (tests) |
| `ExperimentRepository` | Save/find, list by project | In-memory (tests) |
| `RunRepository` | Save, find, list by experiment; rejects overwriting a terminal run | In-memory (tests) |
| `Clock` | Current time | Fixed clock (tests) |
| `IdGenerator` | New identifiers | Counter / UUID |
| `Executor` | Isolated execution | **None — intentionally absent** (ADR-0005) |

---

## 7. Deliberately absent

These are *not* in V0.1 and must not be added speculatively:

- `User`, `Organization`, `Team` — no identity model locally.
- `Verdict`, `Score`, `Grade` — the taxonomy is the verdict.
- `Plugin`, `Connector`, `Workflow` — no extension system before a second real
  integration exists.
- `Tag`, `Label`, `Folder` — organizational sugar, not core model.
