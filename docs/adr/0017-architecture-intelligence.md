# 0017 — Architecture intelligence: a derived, non-persisted projection

- Status: Accepted
- Date: 2026-11-16
- Builds on: [0005](0005-execution-isolation.md), [0006](0006-evidence-integrity.md),
  [0016](0016-static-analysis-boundary.md)

## Context

Phase 2A produces an immutable `AnalysisSnapshot`: files with their declarations
and, crucially, every import with a classification
(`resolved-relative`, `unresolved-relative`, `external`, `outside-root`).

Phase 2B must answer structural questions — who depends on whom, which
directories group into modules, where cycles are, which files are isolated — in a
way a reviewer can check. Five decisions are expensive to reverse:

1. **Where does the architecture layer get its input?** Re-reading the project
   would duplicate the parser and reintroduce every filesystem risk Phase 2A
   closed. The analysis is already the evidence.
2. **What is a module?** Inferring layers from names such as `services` or `utils`
   would manufacture a claim the code does not make.
3. **Which observations are findings, and how sure are they?** A fan-in of 30 is a
   measurement; calling it a bottleneck is an interpretation.
4. **Is the result stored?** A second document that must stay consistent with the
   analysis is a liability unless it carries something the analysis does not.
5. **How are the algorithms bounded?** The graph is attacker-influenced data; a
   recursive traversal is a stack-overflow waiting for a deep dependency chain.

## Decision

**1. Derive from the analysis; never re-read the project.**

The only input is one stored `AnalysisSnapshot`, loaded through the existing
`AnalysisRepository` port. The engine imports no filesystem, process or network
module, and a test asserts that by reading its sources. The analysis digest is
re-verified before deriving, and every model records `analysisId` and
`analysisDigest`, so an architecture report is traceable to the exact snapshot and
revision it describes.

**2. Only `resolved-relative` imports become edges.**

An edge exists only where the analysis named another analysed file. Packages,
unresolved relative paths and paths above the root produce no edge: they are not
internal structure, and inventing a node for them would describe a project that
is not the one analysed. Duplicate imports collapse into one edge that keeps every
kind, every specifier and the number of statements merged.

**3. A module is a directory — stated as a policy, not inferred.**

`src/domain/architecture.ts` → module `src/domain`; a root file → module `.`.
Directory names never influence findings. Convention-based layer inference is
explicitly **not** implemented; if it is ever added it must be opt-in, documented
as a guess, and carry its own evidence.

**4. Facts, calculations and heuristics are separated by `certainty`.**

Cycles, self-imports and isolation are read off the graph: `certain`. Anything
whose inclusion depended on a threshold (`fan-in`, `fan-out`, cross-module
concentration) is `conditional` and its message says the threshold is a heuristic,
not a rule. Metrics are recomputed by the domain, so a model cannot carry counts
that disagree with its own graph. No finding claims a vulnerability, a runtime
failure, a performance defect or a wrong architecture.

**5. Nothing is persisted in this phase.**

The model is a pure function of the analysis: same analysis, same limits, same
thresholds, same digest — no timestamp, no generated id. Storing it would create a
second artifact to keep consistent while adding no information that the analysis
and the engine version do not already carry. `voldbase architecture` recomputes it
on demand. A durable architecture record (for review decisions, annotations or
history) is a **separate** decision: it needs its own ADR, its own schema and its
own immutability rules.

**6. Bounded, iterative, deterministic algorithms.**

Cycle detection is iterative Tarjan with an explicit frame stack (O(V + E), no
recursion depth risk). Nodes, edges, modules and findings are capped (5 000 /
20 000 / 2 000 / 1 000 by default); exceeding a cap **fails** with
`architecture_limit_exceeded` instead of returning a truncated graph. Every
collection is ordered by locale-independent code-unit comparison, and JSON output
is key-sorted.

## Consequences

- The architecture layer inherits Phase 2A's limits: what the parser could not
  resolve is absent from the graph, and the Phase 2A findings already report it.
- Modules follow folders, so a feature-grouped project sees folder-shaped modules.
  This is documented rather than guessed around.
- Thresholds are generic defaults, recorded in every model and overridable per
  run; changing them changes the digest, so two reports with different thresholds
  are distinguishable.
- Because nothing is stored, `voldbase architecture` costs one derivation per run.
  That is deliberate: the derivation is linear in the graph and cheaper than a
  consistency problem.
- Text output summarises long lists and points at `--format json`; the JSON is
  never truncated.

## Alternatives considered

- **Re-scan and re-parse the project in the architecture layer.** Rejected: it
  duplicates the parser, duplicates the filesystem risk, and could disagree with
  the analysis it claims to explain.
- **Treat the graph as a general code graph** (symbols, classes, calls). Rejected
  for this phase: call edges need resolution Phase 2A deliberately does not do, so
  they would be guesses.
- **Infer layers from directory names.** Rejected: it turns naming conventions
  into architectural claims, and would flag well-organised projects for using
  different words.
- **Persist architecture snapshots next to analyses.** Rejected for now: no
  demonstrated need, and it would create a second immutable document with its own
  migration story for data that can be recomputed deterministically.
- **Report high fan-in and fan-out as warnings.** Rejected: severity would imply a
  defect the graph cannot establish. They are `info` and `conditional`.
- **Render cycles as errors.** Rejected: many codebases legitimately contain
  cycles, and an import cycle does not by itself break anything at runtime.
- **Recursive Tarjan / DFS.** Rejected: unbounded recursion on attacker-influenced
  graph depth.
