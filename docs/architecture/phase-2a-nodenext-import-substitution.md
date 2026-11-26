# S2 — NodeNext relative import extension substitution

- Status: **Approved design — implemented in PR #29**
- Date: 2026-11-25
- Baseline: `main` at `345f2bf1abfd27473b1fc1c9ef9c5f4fa179c032`
  (`fix(analysis): resolve imports only against analysed source files (#28)`)
- Implementation: PR #29, merge commit
  `abd6238346c1363ac3a30497affd4a368fb75d78`
- Builds on: [Phase 2A](phase-2a-static-analysis.md),
  [ADR-0016](../adr/0016-static-analysis-boundary.md),
  [ADR-0017](../adr/0017-architecture-intelligence.md)

This document records the approved design for one narrowly scoped change to
Phase 2A import classification. The design was established before
implementation, and it was implemented in PR #29 (merge commit
`abd6238346c1363ac3a30497affd4a368fb75d78`). The change does not alter the
parser, declaration extraction, finding rules, snapshot shape or architecture
algorithms.

## 1. Verified current behavior

### 1.1 Resolver

`resolveImportSpecifier()` in
`src/infrastructure/fs/typescript-analyzer.ts` classifies every import at parse
time. It does not load a `tsconfig`, does not resolve packages, and never touches
the filesystem.

For a relative specifier it:

1. joins the specifier to the importing file's directory and normalizes it;
2. returns `outside-root` if the result is above the project root;
3. tries the normalized path literally, then the same path with each of
   `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` appended, then
   each `index<extension>` under the normalized path;
4. returns the first candidate present in the analysed source-path set, or
   `unresolved-relative`.

Consequences today:

- `./module.js` produces candidates such as `module.js`, `module.js.ts`, …; the
  final extension is never replaced. It resolves only when an actual `module.js`
  was analysed.
- The exact literal path is tried **first**. When both `module.js` and
  `module.ts` exist, VOLDBASE currently selects `module.js`.
- `.mjs` and `.cjs` behave the same way: only an exact `.mjs`/`.cjs` source
  resolves; there is no `.mjs` → `.mts` or `.cjs` → `.cts` substitution.
- The importing file's language is not consulted.
- Extensionless imports already select `.ts` before `.js` because `.ts` is the
  first appended extension; that behavior is independent of this proposal.

### 1.2 Language detection and source eligibility

`SOURCE_LANGUAGES` lists eight extensions: `.js`, `.jsx`, `.mjs`, `.cjs` as
`javascript`; `.ts`, `.tsx`, `.mts`, `.cts` as `typescript`.
`isSupportedSourcePath()` derives eligibility from `path.extname()`.

Because `extname('a.d.ts') === '.ts'`, `extname('a.d.mts') === '.mts'` and
`extname('a.d.cts') === '.cts'`, declaration files are **already** included in
the analysed source set, parsed as TypeScript, recorded as an `AnalyzedFile`, and
included in `sourcePaths`. They are not a separate parser path and require no
schema change to be graph targets.

The Phase 2A documentation correctly says declaration files are analysed but
**not semantically linked to their implementation**. Resolving an import to a
declaration file is not that linking: it records a syntactic edge to an analysed
file, the same kind of edge the resolver already records when a specifier names a
`.d.ts` exactly.

### 1.3 Snapshot and graph constraints

`createAnalysisSnapshot()` requires every `resolvedPath` to be one of the
analysed files (`seenPaths`); a resolved edge to anything else is
`invalid_analysis_snapshot`. The stored-analysis loader rebuilds each snapshot
through the same constructor and re-checks its digest. The architecture builder
converts only `resolved-relative` imports into edges and requires the target to be
in the analysis's file set.

Therefore a target is safe to record only if it is already an analysed source
file. This remains true after this proposal; no new eligibility rule or schema
field is needed.

### 1.4 Recorded baseline

The design-time baseline diagnostic at this SHA recorded: clean working tree,
`npm ci`, `typecheck`, `build` and `npm test` all successful, with **350 tests in
50 suites, 350 passing**. Those are design-time baseline figures, not current
figures. This design task did not re-run the suite (it changes no code), but the
repository state and SHA above were re-verified.

## 2. Proposed behavior

### 2.1 Scope and gate

Apply extension substitution **only** when all of the following hold:

- the specifier starts with `.` and is not classified `outside-root`;
- the importing file's language is `typescript` (`path.extname(fromPath)` maps to
  `typescript` through the existing language table);
- the specifier's final segment ends in `.js`, `.mjs` or `.cjs`.

There is no separate "exact source first" gate. The candidate order in §2.2 is
authoritative and is applied exactly as written: the literal JavaScript candidate
is evaluated only after every earlier eligible analysed TypeScript candidate has
failed.

The substitution is a candidate-generation rule only. All candidates continue to
be checked against the analysed `sourcePaths`; the resolver still never reads the
filesystem.

#### 2.1.1 Import kinds covered

The rule applies to every relative specifier that the existing resolver
classifies, whatever syntactic form produced it:

- static `import` declarations;
- literal dynamic `import('…')` expressions;
- literal `require('…')` calls and `import x = require('…')` declarations;
- `export … from` re-exports;
- type-only imports and re-exports (`import type … from`, `export type … from`),
  which carry the existing `typeOnly` flag.

The policy is therefore not limited to static imports. Computed dynamic imports
never reach the resolver — they are recorded as VB003 — and a computed
`require()` argument is not recorded at all; neither is affected. Non-relative
specifiers are classified `external` before any substitution.

### 2.2 Candidate order (TypeScript importers)

| Specifier suffix | Candidate order | Then |
| --- | --- | --- |
| `.js` | stem + `.ts`, stem + `.tsx`, stem + `.d.ts` | literal `specifier` |
| `.mjs` | stem + `.mts`, stem + `.d.mts` | literal `specifier` |
| `.cjs` | stem + `.cts`, stem + `.d.cts` | literal `specifier` |

`stem` is the normalized candidate path with the recognized JS extension removed.
The first **eligible analysed source** candidate wins. The literal file is the
last resort, so a real `module.js` remains a valid target when no earlier
eligible analysed TypeScript candidate exists.

This order was verified in one measured configuration: a probe with TypeScript
5.9.3, `module` and `moduleResolution` set to `nodenext`, ESM output and
`allowJs: true` resolved `.ts → .tsx → .d.ts → .js`, `.mts → .d.mts → .mjs` and
`.cts → .d.cts → .cjs`. That observation informs the order but is not a claim of
universal compiler parity: other compiler versions and configurations may differ,
and VOLDBASE models neither `tsconfig` nor `allowJs`. The literal JavaScript
candidate remains eligible solely because JavaScript files are eligible analysed
sources; it is not modeling `allowJs` behavior.

When both `module.js` and `module.ts` exist, a TypeScript importer therefore now
selects `module.ts`; that is a deliberate change from VOLDBASE's current
exact-first result, not an accidental side effect.

No new `ImportResolution` kind is introduced. A resolved substitution is still
`resolved-relative` with the selected `resolvedPath`, and the specifier remains
exactly as written.

### 2.3 JavaScript importers

JavaScript importers are **not** substituted. They retain the current
exact-source matching behavior: a literal `.js`, `.mjs` or `.cjs` file resolves;
a `.js` specifier whose only counterpart is `module.ts` remains
`unresolved-relative` and produces VB002.

This is an intentional VOLDBASE product policy, not full TypeScript compiler
parity. TypeScript with `allowJs: true` also resolves a JS importer's
`./module.js` to `module.ts`; VOLDBASE deliberately does not, because:

- its claims are source-graph claims and it has no `tsconfig`, `allowJs` or
  `outDir` model;
- a JS runtime resolves the literal path, and VOLDBASE cannot know whether the
  TS counterpart is compiled to that path;
- resolving in a plain-JS project with a stray `.ts` file would suppress a real
  VB002 and invent a dependency;
- all observed demand (Zod's 677 affected imports) is in TypeScript importers.

### 2.4 Boundaries and non-goals

- Relative specifiers only; package names, builtins and package subpaths remain
  `external`.
- The `outside-root` check happens before any substitution; an escaping path is
  `outside-root` and emits VB004, never a resolved edge.
- Only files in `sourcePaths` may be selected. `.css`, `.json`, `.svg` and other
  assets remain ineligible even if a file with that name exists.
- Aliases, `baseUrl`, `paths`, package `exports`, workspace resolution and package
  resolution remain out of scope.
- Extensionless imports are unchanged, including the existing `.ts`-before-`.js`
  preference and `index` resolution.
- No substitution other than the approved mappings is performed. In particular:
  - `.js` never maps to `.mjs`, `.mts` or `.cts`;
  - `.mjs` never maps to `.ts` or `.tsx`;
  - `.cjs` never maps to `.ts` or `.tsx`;
  - `.jsx` substitution (for example `.jsx` → `.tsx`) remains out of scope.
- Semantic linking of declaration files to implementations remains out of scope.

### 2.5 Declaration-file targets

`.d.ts`, `.d.mts` and `.d.cts` are eligible because they are already analysed
source files under the current extension table. Including them in the candidate
order adds no parser, snapshot or storage change:

- they already appear in `files` and in `sourcePaths`;
- `createAnalysisSnapshot()` already accepts them as `resolvedPath`;
- the architecture builder already creates a node for every analysed file,
  including declaration files;
- no existing ADR decision is changed: ADR-0016 permits syntactic facts, and
  ADR-0017 only requires that an edge target be an analysed file.

The only limit is conceptual: a declaration-file target is a syntactic dependency
edge only. It does not prove that an implementation file exists, that it is
emitted to the specifier's path, or that the declaration is linked to an
implementation. That is why this design does not claim semantic linking.
Declaration-file targets are an approved decision (§5), not an open option. If
that decision were ever reversed, the declaration candidates would be removed
from the order along with their acceptance tests; the Zod measurements below
would be unaffected because Zod has no declaration candidates.

## 3. Impact analysis

| Area | Expected effect |
| --- | --- |
| `resolvedImportCount` | Rises by exactly the number of previously unresolved imports that now select an eligible candidate. Unaffected imports keep their classification. |
| VB002 | Falls for imports resolved by substitution. No new rule id; the message and certainty are unchanged. Unresolved imports, including JS-importer cases, still produce VB002. |
| VB003 / VB004 | Unchanged. Computed dynamic imports and out-of-root paths are outside this rule. |
| Architecture edges | Each newly `resolved-relative` import becomes (part of) an edge. Edges are deduplicated by file pair; `importCount`, `kinds` and `specifiers` can change. |
| Architecture metrics | Node count and module count are unchanged (the same files are analysed). Edge count, fan-in/out, isolated flags, cycle membership and module metrics can change; new VA001/VA00x findings are possible. |
| Snapshot digest | Changes for a re-analysis of the same revision, both because import content changes and because `analyzerVersion` participates in the digest. No digest value is prescribed; it must remain deterministic. |
| `ANALYZER_VERSION` | Bump `1.0.1` → **`1.0.2`**. The analyzer produces different content from the same input. |
| `ANALYSIS_SCHEMA_VERSION` | **Remains 1.** No field, resolution kind or invariant changes; `resolvedPath` still names an analysed file. The analyzer version distinguishes the behavior. |
| Storage document version | Remains 1. No migration is needed. |

### 3.1 Existing stored snapshots

Existing snapshots remain readable. The loader accepts schema version 1,
reconstructs the snapshot with the stored `analyzerVersion` (`1.0.1`), stored
content and stored schema version, and recomputes the digest against the recorded
one. Nothing in the loader consults the current analyzer version or re-runs
resolution. Old snapshots therefore keep their original classification, digest
and findings; a new analysis creates a separate immutable record with analyzer
version `1.0.2` and a new digest. No migration or schema bump is required.

### 3.2 Zod acceptance target

Subject: `colinhacks/zod` at
`d40c329910436e528d3c26cb1b9179e05abebf05`.

Recorded diagnostic baseline at this revision (full repository analysis):

| Measurement | Baseline |
| --- | --- |
| Files walked / analysed source files | 741 / 525 |
| Imports | 1,471 |
| Resolved imports | **2** (both exact `../../vitest.root.mjs`) |
| VB002 findings | **678** (677 `.js` specifiers + 1 `./global.css`) |
| Architecture | 2 edges, 522 isolated files, 52 modules, 49 isolated modules |

Candidate eligibility was validated before projecting post-change numbers:

- all **677** unresolved relative `.js` imports are in **TypeScript** importers
  (0 JavaScript importers);
- every one has exactly **one** candidate in the analysed source set;
- all 677 candidates are **`.ts`** files: 0 `.tsx`, 0 `.d.ts`, 0 `.d.mts`,
  0 `.d.cts`;
- 0 ambiguous cases and 0 missing targets;
- the two resolved `.mjs` imports are exact matches and are unaffected;
- non-relative `.js`/`.cjs` package subpaths remain `external`.

Projected post-implementation measurements, if the policy above is implemented
exactly:

| Measurement | Expected |
| --- | --- |
| Resolved imports | **679** (2 existing + 677 substituted) |
| VB002 findings | **1** (`./global.css` only) |
| Analysis findings total | **3** (1 warning + the 2 unchanged VB003 info findings) |
| Architecture edges | **642 distinct directed file-to-file edges** (including the 2 existing) |
| `internalImportCount` | **679** |
| Isolated files | **250** (from 522) |
| Modules | **52** |
| Distinct module-to-module pairs | **41** |
| Isolated modules | **22** (from 49) |
| Cycle components | **2** |
| Node count | 525 (unchanged) |
| Architecture findings (default thresholds) | **295** (including the 2 VA001 cycle findings) |

The 679 resolved import statements collapse into **642 distinct directed
file-to-file edges**. Twenty-nine edges represent more than one import statement,
the maximum `importCount` is 5, and 37 statements are merged into existing edges;
`internalImportCount` is **679**, equal to the 679 resolved import statements. The
41 module-to-module figure is a derived count of distinct cross-module directory
pairs, not an existing architecture model metric.

Terms used in these tables:

- **Isolated file:** an analysed file with no fan-in, no fan-out and no self-loop.
- **Isolated module:** in a project with more than one module, a module with no
  cross-module edges.
- **Cycle component:** a strongly connected component of the file graph that
  contains more than one node or a self-loop. The cycle count is the number of
  such components; the projected graph has **2 cycle components**.

The **3 analysis findings** are distinct from the **295 architecture findings**.
The architecture-findings count is produced under the default architecture
thresholds and must not be treated as a fixed acceptance criterion; changing
those thresholds changes the count. The **2 cycle components**, by contrast, are
structural facts of the projected graph.

These are read-only projections over the stored analysis, not an implementation
run, and they have **not been re-measured** after implementation. Because there
are no declaration candidates or ambiguous cases in Zod, the declaration-target
decision does not change these numbers. If either approved decision were
reversed, the projection must be recomputed rather than copied.

## 4. Regression test matrix

All tests below use fixture projects through the existing analyzer helper, so the
assertions cover classification, snapshot creation and (where relevant)
architecture derivation. Every expected result is stated as an observable value:
a `resolution`, a `resolvedPath`, a finding rule id, a snapshot validation result
or an architecture edge.

| # | Case | Expected |
| --- | --- | --- |
| 1 | TS importer, `./module.js`, only `module.ts` | `resolved-relative` → `module.ts`; no VB002 |
| 2 | TS importer, `./module.js`, only `module.tsx` | `resolved-relative` → `module.tsx` |
| 3 | TS importer, `./module.js`, only `module.d.ts` | `resolved-relative` → `module.d.ts`; no VB002 |
| 4 | TS importer, `./module.mjs`, only `module.mts` | `resolved-relative` → `module.mts` |
| 5 | TS importer, `./module.mjs`, only `module.d.mts` | `resolved-relative` → `module.d.mts` |
| 6 | TS importer, `./module.cjs`, only `module.cts` | `resolved-relative` → `module.cts` |
| 7 | TS importer, `./module.cjs`, only `module.d.cts` | `resolved-relative` → `module.d.cts` |
| 8 | TS importer, literal fallback: only `module.js` | `resolved-relative` → `module.js` |
| 9 | TS importer, literal fallback: only `module.mjs` / `module.cjs` | resolves the literal `.mjs` / `.cjs` file |
| 10 | TS importer, `module.js` + `module.ts` | selects `module.ts` (substitution before literal) |
| 11 | TS importer, `module.js` + `module.tsx` | selects `module.tsx`, not `module.js` |
| 12 | TS importer, `module.js` + `module.d.ts` | selects `module.d.ts`, not `module.js` |
| 13 | TS importer, `module.mjs` + `module.mts` | selects `module.mts`, not `module.mjs` |
| 14 | TS importer, `module.mjs` + `module.d.mts` | selects `module.d.mts`, not `module.mjs` |
| 15 | TS importer, `module.cjs` + `module.cts` | selects `module.cts`, not `module.cjs` |
| 16 | TS importer, `module.cjs` + `module.d.cts` | selects `module.d.cts`, not `module.cjs` |
| 17 | TS importer, `module.js` + `module.ts` + `module.tsx` | selects `module.ts` |
| 18 | TS importer, `module.js` + `module.ts` + `module.d.ts` | selects `module.ts`; `.d.ts` only when no earlier candidate |
| 19 | TS importer, `module.mjs` + `module.mts` + `module.d.mts` | selects `module.mts` |
| 20 | TS importer, `module.cjs` + `module.cts` + `module.d.cts` | selects `module.cts` |
| 21 | TS importer, `./dir/index.js`, only `dir/index.ts` | `resolved-relative` → `dir/index.ts`; no VB002 |
| 22 | TS importer, `./module.js`, no candidate | `unresolved-relative`, VB002, no `resolvedPath` |
| 23 | TS importer, `./module.js` outside root | `outside-root`, VB004, no substitution |
| 24 | JS importer, `main.js`, `./module.js`, only `module.ts` | remains `unresolved-relative`; VB002; no edge |
| 25 | JS importer, `main.js`, `./module.js`, only `module.d.ts` | remains `unresolved-relative`; VB002; no edge (declaration-only counterpart is not substituted) |
| 26 | JS importer, `main.js`, `./module.js`, `module.js` + `module.ts` | resolves `module.js` (exact behavior preserved) |
| 27 | JS importer, `main.js`, `./module.mjs` with `module.mjs` + `module.mts` | resolves the literal `module.mjs`, not `module.mts` |
| 28 | JS importer, `main.js`, `./module.cjs` with `module.cjs` + `module.cts` | resolves the literal `module.cjs`, not `module.cts` |
| 29 | JS importer, literal dynamic `import('./module.mjs')`, `module.mjs` + `module.mts` | `resolution: 'resolved-relative'`, `kind: 'dynamic'`, `resolvedPath` is `module.mjs`; no VB002 |
| 30 | Literal dynamic `import('./module.js')` from a TS importer, only `module.ts` | `resolution: 'resolved-relative'`, `kind: 'dynamic'`, `resolvedPath` is `module.ts` |
| 31 | Literal `require('./module.js')` from a TS importer, only `module.ts` | `resolution: 'resolved-relative'`, `kind: 'require'`, `resolvedPath` is `module.ts` |
| 32 | `import x = require('./module.js')` from a TS importer, only `module.ts` | `resolution: 'resolved-relative'`, `kind: 'require'`, `typeOnly: false`, `resolvedPath` is `module.ts` |
| 33 | `export { x } from './module.js'` from a TS importer, only `module.ts` | `resolution: 'resolved-relative'`, `kind: 'export-from'`, `resolvedPath` is `module.ts` |
| 34 | `import type { T } from './module.js'` from a TS importer, only `module.ts` | `resolved-relative` → `module.ts`; import records `typeOnly: true` |
| 35 | `export type { T } from './module.js'` from a TS importer, only `module.ts` | `resolved-relative` → `module.ts`; `kind: 'export-from'`, `typeOnly: true` |
| 36 | Computed dynamic import in a TS importer | unchanged: `kind: 'dynamic'` import is absent, VB003 is reported, no substitution |
| 37 | Extensionless `./module` with `module.ts` and `module.js` | unchanged: selects `module.ts` |
| 38 | Extensionless `./dir` with `dir/index.ts` | unchanged: selects `dir/index.ts` |
| 39 | Non-source `.css`, `.json`, `.svg` existing files | still unresolved after S1; no resolved target |
| 40 | Non-relative `pkg/x.js` | remains `external` |
| 41 | `.js` specifier with only `module.mjs`, `module.mts` and `module.cts` present | `unresolved-relative`, VB002; no `.js` → `.mjs`/`.mts`/`.cts` mapping |
| 42 | `.mjs` specifier with only `module.ts` and `module.tsx` present | `unresolved-relative`, VB002; no `.mjs` → `.ts`/`.tsx` mapping |
| 43 | `.cjs` specifier with only `module.ts` and `module.tsx` present | `unresolved-relative`, VB002; no `.cjs` → `.ts`/`.tsx` mapping |
| 44 | TS importer, `./module.jsx`, only `module.tsx` | `unresolved-relative`, VB002; `.jsx` substitution out of scope |
| 45 | Snapshot creation for a substituted `.ts` import | summary `resolvedImportCount` increases by 1; snapshot validation passes; digest is reproducible |
| 46 | Declaration target `.d.ts`: TS importer, `./module.js`, only `module.d.ts` | snapshot validates; `resolvedPath` is exactly `module.d.ts`; the architecture edge runs from the importer to `module.d.ts` |
| 47 | Declaration target `.d.mts`: TS importer, `./module.mjs`, only `module.d.mts` | snapshot validates; `resolvedPath` is exactly `module.d.mts`; the architecture edge runs from the importer to `module.d.mts` |
| 48 | Declaration target `.d.cts`: TS importer, `./module.cjs`, only `module.d.cts` | snapshot validates; `resolvedPath` is exactly `module.d.cts`; the architecture edge runs from the importer to `module.d.cts` |
| 49 | Architecture derivation for a substituted `.ts` import | one directed edge exists from importer to selected file; fan-in/out updated |
| 50 | Existing suite plus new tests | all 350 existing tests in 50 suites remain green; every new test above passes; `npm run typecheck`, `npm run build` and `npm test` pass |

The declaration-target cases are required by this design because eligibility could
otherwise be mistaken for semantic support. They follow the approved decision in
§5; if that decision were reversed, rows 3, 5, 7, 12, 14, 18, 25 and 46–48 would
be replaced with an explicit documented limitation and `.d.ts`, `.d.mts` and
`.d.cts` removed from the order.

## 5. Approved decisions

These decisions are approved and closed for S2. The implementation must not
reopen them.

| # | Decision | Approved choice |
| --- | --- | --- |
| 1 | Importer language gate | Substitution applies only to TypeScript importers. JavaScript importers keep exact-source behavior (§2.3). |
| 2 | Candidate precedence | `.js` → `.ts`, `.tsx`, `.d.ts`, literal; `.mjs` → `.mts`, `.d.mts`, literal; `.cjs` → `.cts`, `.d.cts`, literal. The literal JavaScript candidate is always last. |
| 3 | Declaration targets | `.d.ts`, `.d.mts` and `.d.cts` may be selected as syntactic graph targets. No semantic linking to implementations is claimed. |
| 4 | Import kinds | The rule covers every relative specifier the resolver classifies: static imports, literal dynamic imports, literal `require()` and `import x = require()`, `export … from`, and type-only imports/re-exports. Computed dynamic imports are unaffected. |
| 5 | Analyzer version | `ANALYZER_VERSION` becomes **`1.0.2`**. |
| 6 | Analysis schema version | `ANALYSIS_SCHEMA_VERSION` remains **1**. |
| 7 | Storage schema version | Remains **1**; no migration is introduced. |

Consequences that follow from these decisions, not new choices:

- The existing exact-first result for a TypeScript importer is deliberately
  replaced by the approved precedence in decision 2.
- No new resolution kind, finding rule, snapshot field or architecture algorithm
  is added; `resolved-relative` keeps its existing meaning.
- Existing stored snapshots keep their recorded `analyzerVersion`, content and
  digest; new analyses are recorded separately as `1.0.2`.

Implementation follow-ups, which are documentation tasks rather than open
decisions:

- Update the `1.0.1` samples in `README.md` and
  `docs/architecture/phase-2a-static-analysis.md` to `1.0.2` and record the new
  behavior and its limitation. This design task intentionally edits only this
  document.
- No new ADR is required: the parser boundary, dependency policy, layering and
  architecture projection are unchanged, and ADR-0016 and ADR-0017 already permit
  the resulting syntactic edges between analysed files.

## 6. Implementation acceptance criteria

The S2 implementation is acceptable only when all of the following hold:

- [ ] Current `main` is used as the base; no unrelated resolver changes.
- [ ] Substitution runs only for relative specifiers from TypeScript importers,
      after the outside-root check, and only for `.js`, `.mjs`, `.cjs` suffixes.
- [ ] The rule covers every relative specifier the resolver classifies — static
      imports, literal dynamic imports, literal `require()`/`import x = require()`,
      `export … from`, and type-only imports/re-exports — and is not narrowed to
      static imports. Computed dynamic imports still produce VB003.
- [ ] Candidate order is exactly `.ts`, `.tsx`, `.d.ts`, literal for `.js`;
      `.mts`, `.d.mts`, literal for `.mjs`; `.cts`, `.d.cts`, literal for `.cjs`.
- [ ] The first candidate present in `sourcePaths` wins; no filesystem access and
      no non-source target is ever selected.
- [ ] JavaScript importers keep current exact-source behavior, including
      `module.js` winning over `module.ts` when both exist.
- [ ] Extensionless imports, `index` resolution, `external` classification and
      `outside-root`/VB004 behavior are unchanged.
- [ ] No substitution outside the approved mappings is performed: `.js` never
      maps to `.mjs`, `.mts` or `.cts`; `.mjs` never maps to `.ts` or `.tsx`;
      `.cjs` never maps to `.ts` or `.tsx`; `.jsx` remains out of scope.
- [ ] Resolved imports keep the original specifier and use the existing
      `resolved-relative` resolution; no new resolution kind or finding rule.
- [ ] `ANALYZER_VERSION` is `1.0.2`; `ANALYSIS_SCHEMA_VERSION` remains 1 and the
      storage document version remains 1.
- [ ] Existing snapshots still load and retain their recorded digest and
      `analyzerVersion`; no migration is introduced.
- [ ] New snapshots validate, their digests are reproducible, and existing tests
      remain valid.
- [ ] The full regression matrix in §4 passes, including declaration-target,
      JS-importer, precedence, snapshot and architecture tests.
- [ ] The Zod acceptance target in §3.2 is re-measured after implementation; the
      recorded baseline is 2 resolved imports, 678 VB002, 2 architecture edges,
      522 isolated files, 52 modules and 49 isolated modules. Expected post-change
      values are **679 resolved imports, 1 VB002, 3 analysis findings, 642
      distinct file-to-file edges, `internalImportCount` 679, 250 isolated files,
      52 modules, 41 distinct module-to-module pairs, 22 isolated modules and 2
      cycle components**, exactly as approved in §5. The
      295 architecture findings are threshold-dependent and are not an acceptance
      criterion.
- [ ] `README.md` and `docs/architecture/phase-2a-static-analysis.md` samples are
      updated from `1.0.1` to `1.0.2`, and the new behavior/limitation is
      documented.
- [ ] The 350 existing tests in 50 suites remain green, every new regression
      test in §4 passes, and `npm run typecheck`, `npm run build` and `npm test`
      pass.
