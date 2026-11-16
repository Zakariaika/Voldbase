# 0016 — Static analysis: parser choice and the syntax-only boundary

- Status: Accepted
- Date: 2026-11-16
- Amends: [0007](0007-dependency-policy.md) (one runtime dependency, justified below)

## Context

Phase 2A needs to describe an imported project's source structure: declarations,
exports, imports and their relationships, plus a small set of explainable
findings. Two decisions are expensive to reverse:

1. **Which parser?** This is the first runtime dependency in the product, and
   ADR-0007 requires an ADR for one.
2. **What may the analyzer claim?** A static reader can see syntax. It cannot see
   runtime values, resolved packages, environment or behaviour. An analysis that
   quietly implies otherwise is worse than no analysis, because it will be trusted.

VOLDBASE analyses imported code **as untrusted data**. Nothing in this phase may
execute it, and no dependency may be added that would want to.

## Decision

**Parser: the TypeScript Compiler API (`typescript`), used purely as a parser.**

- It parses JavaScript, JSX, TypeScript and TSX with one implementation, and
  distinguishes `.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts` by `ScriptKind`, which is
  exactly the scope required.
- It is already the project's build tool, so the review surface is a version we
  depend on anyway, not a new supply chain.
- It is used through `ts.createProgram` over an **in-memory compiler host**: the
  host answers only from files VOLDBASE itself read, `noResolve` is set, `noLib`
  keeps the compiler from reaching for a default library, and `types: []` disables
  automatic type inclusion. The parser therefore cannot read a `tsconfig`, cannot
  resolve a package, cannot look at `node_modules`, and cannot touch the network.
- Diagnostics come from `program.getSyntacticDiagnostics`, which is public API and
  reports exactly "this text is not valid source of that language".

Cost: `typescript` becomes a **runtime** dependency (it moved from
`devDependencies` to `dependencies`). It is ~8 MiB, ships no install scripts, and
needs no network at run time. This is the single, explicitly justified exception
to the zero-runtime-dependency rule in ADR-0007; the reasoning is recorded here
rather than in a commit message.

**Boundary: syntax only, and every claim is labelled as such.**

The analyzer records:

- facts read directly from the AST: file path, language, size, content digest,
  declaration kind/name/exported flag, import specifier exactly as written,
  line/column;
- classifications of what it could *see*, not of what the code means: an import is
  `resolved-relative` only when the specifier names a file that was analysed;
  everything else is `external`, `unresolved-relative` or `outside-root`;
- findings with a stable rule id, a severity, a **certainty** (`certain` for
  syntax facts, `conditional` for statements a static reader cannot settle) and
  evidence quoted from the source.

It never: infers types, resolves packages or aliases, evaluates configuration,
checks behaviour, or calls anything a vulnerability. A project with no findings is
not described as safe — the CLI says so on every run.

## Consequences

- Import edges between analysed files are a real graph; edges to packages are
  deliberately stubs labelled `external`.
- Relative imports that rely on build aliases, generated files or `paths` in a
  `tsconfig` are reported as `unresolved-relative` with a warning. That is honest
  but noisy for some monorepos; the finding text says why.
- Analysis of a 5 000-file project allocates the file texts plus one AST per file.
  Large projects are bounded by the per-run file, byte and source-file limits, and
  the analysis aborts rather than degrading to a partial result.
- The analyzer version is part of the snapshot and of its digest, so a change in
  what is extracted produces a different, distinguishable analysis.
- Upgrading `typescript` can change diagnostics for the same source; that is why
  the recorded `analyzerVersion` covers the parser generation used.

## Alternatives considered

- **Regular expressions over source.** Rejected: it cannot distinguish a string
  from code, and its findings would be wrong in ways users cannot check.
- **Tree-sitter.** Rejected for this phase: a native build step, per-language
  grammars and no TypeScript types, for a scope the TS parser already covers.
- **Babel / SWC.** Rejected: another dependency that duplicates the parser we
  already ship, with worse TS-specific syntax coverage.
- **Running `tsc`, ESLint or a bundler on the project.** Rejected outright: it
  executes project configuration and, for ESLint, project plugins. That is the
  execution boundary ADR-0005 draws.
- **Type checking (`ts.Program` with real resolution) to produce semantic
  findings.** Rejected for Phase 2A: it reads `node_modules`, honours `tsconfig`
  plugins and makes claims that depend on the environment. It may be a later,
  separately bounded phase.
- **TypeScript as a dev-only dependency with the analyzer optional.** Rejected:
  the CLI's primary new command would not work in an installed package, which is
  worse than a documented dependency.
