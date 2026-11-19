# Architecture Decision Records

Every decision that is expensive to reverse is written down here before it is
implemented. An ADR is one page: the context, the decision, the consequences, and
the alternatives that were rejected.

## Format

```
# NNNN — Title

- Status: Proposed | Accepted | Superseded by NNNN | Deprecated
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives considered
```

Rules:

1. ADRs are **immutable once accepted**. To change a decision, add a new ADR and
   mark the old one `Superseded by NNNN`.
2. A pull request that introduces a new runtime dependency, a new external
   service, or a change in a layering rule must reference an ADR.
3. Numbers are never reused.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-product-scope.md) | Product scope and result taxonomy | Superseded by 0020 (decision 5 only; decisions 1–4 remain in force) |
| [0002](0002-language-and-runtime.md) | Language, runtime and toolchain | Accepted |
| [0003](0003-modular-monolith.md) | Modular monolith with ports and adapters | Accepted |
| [0004](0004-local-first.md) | Local-first V0.1 with a hosted-ready seam | Accepted |
| [0005](0005-execution-isolation.md) | Execution isolation and the no-execution rule | Accepted |
| [0006](0006-evidence-integrity.md) | Evidence integrity and reproducibility | Accepted |
| [0007](0007-dependency-policy.md) | Dependency policy | Accepted |
| [0008](0008-ci-and-quality-gates.md) | CI and quality gates | Accepted |
| [0009](0009-local-storage-format.md) | Local storage format | Accepted |
| [0010](0010-build-and-distribution.md) | Build and distribution for the CLI | Accepted |
| [0011](0011-storage-write-locking.md) | Cross-process write locking for the local store | Superseded by 0013 |
| [0012](0012-scan-time-filesystem-validation.md) | Scan-time filesystem validation (TOCTOU) | Superseded by 0014 |
| [0013](0013-lock-capture-and-restore.md) | Lock removal by capture, verification and restore | Superseded by 0015 |
| [0014](0014-bounded-reads-and-path-revalidation.md) | Bounded reads and post-read path revalidation | Accepted |
| [0015](0015-liveness-based-lock-recovery.md) | Lock safety: liveness-based recovery and the displaced-owner guard | Accepted |
| [0016](0016-static-analysis-boundary.md) | Static analysis: parser choice and the syntax-only boundary | Accepted |
| [0017](0017-architecture-intelligence.md) | Architecture intelligence: a derived, non-persisted projection | Accepted |
| [0018](0018-execution-control-plane-and-sandbox-boundaries.md) | Execution control plane and sandbox boundaries | Proposed |
| [0019](0019-isolation-runtime-selection.md) | Isolation runtime selection for the execution engine | Proposed |
| [0020](0020-licensing-model.md) | Licensing model: source-available, non-commercial by default | Proposed |
