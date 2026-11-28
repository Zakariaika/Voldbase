# 0021 — Python parsing, analysis schema evolution and migration integrity (analysis and storage schema versions deferred to a unified decision)

- Status: Proposed
- Date: 2026-11-23
- Builds on: [0005](0005-execution-isolation.md), [0006](0006-evidence-integrity.md),
  [0007](0007-dependency-policy.md), [0009](0009-local-storage-format.md),
  [0016](0016-static-analysis-boundary.md), [0017](0017-architecture-intelligence.md)
- Amends: [0016](0016-static-analysis-boundary.md) (its "Tree-sitter" rejection applies
  to the JavaScript/TypeScript phase only; a second front end is added behind the
  existing `SourceFrontEnd` seam)

## Context

VOLDBASE is a platform for researching, studying, experimenting with and verifying
software and AI projects: it imports a project, pins and describes its revision,
helps design reproducible experiments, and records what happened when (and if) they
ran. Static analysis is one capability inside that direction — Phase 2A covers
JavaScript and TypeScript through the TypeScript compiler API (ADR-0016). Python is
the largest remaining language in the projects VOLDBASE is built for, and it is not
reachable through that parser. Adding it widens what the platform can observe; it
does not change what the platform is.

Three things make this expensive to reverse, and therefore an ADR:

1. **A second parser runtime.** ADR-0007 requires an ADR for every new runtime
   dependency, and a Python grammar is a parser we would then own the packaging of.
2. **A recorded-format change.** Analyses are content-addressed records on disk
   (ADR-0009, ADR-0016). Recording Python files requires new domain vocabulary, and
   the `schemaVersion` field is *inside* the hashed content, so adding vocabulary
   moves digests and, whenever a new version is assigned, forces a migration of
   existing records.
3. **A migration that must not damage evidence.** Existing v1 records are the
   product's evidence. A migration that recomputes a digest before proving the
   original is intact would launder a modified record into a "valid" one, and the
   current read path has exactly that shape.

The recorded-format change in item 2 needs a version number, and this ADR does not
choose one. `ANALYSIS_SCHEMA_VERSION` (the meaning of one analysis record) and
`ANALYSES_STORAGE_SCHEMA_VERSION` (the envelope document) are **independent version
dimensions**: this ADR does not assume they advance together, and it does not assume a
compatibility pair must be `(next, next)`. Both numbers are deferred to a unified
schema-evolution decision that covers every recorded format — including the Python
vocabulary in item 2, the Workspace Resolution values `resolved-workspace` and its
`resolvedPath` invariants, and any other approved change to persisted analysis records
or storage compatibility. Until that decision is accepted and implemented, this ADR
allocates no version, claims no migration path and is not implemented. The
version-specific vocabulary, envelope and migration material below is a set of
conditional requirements on that decision, not an allocation. Naming Workspace
Resolution here records that dependency only; it does not implement it, change its
design or authorize implementation.

What the investigation established (Steps 3R–3R.3, all read-only, no code changed):

- The current read path (`analysis-storage-schema.ts`) rebuilds every entry through
  `createAnalysisSnapshot` and only then compares the digest. `summary` is derived by
  `summarizeAnalysis()` and is not part of `StoredAnalysis`; an injected `summary` key
  is ignored and dropped on write. So there is no summary-integrity vulnerability to
  fix, only a derived value to keep deriving.
- `ANALYSIS_SCHEMA_VERSION` (domain content) and `ANALYSES_STORAGE_SCHEMA_VERSION`
  (document envelope) are both `1`; `schemaVersion` participates in the digest.
- A stored entry whose `schemaVersion` is unknown to the build currently surfaces as
  `analysis_corrupted`, because `storedToAnalysis` rewrites every `DomainError` from
  the domain constructor. That is a false diagnostic, not a corruption.
- `AnalysisSettings` counters (`maxFiles`, `maxTotalBytes`, `maxFileBytes`,
  `maxSourceFiles`) are copied into the digest without validation: a forged record
  with `maxFiles: "lots"` and `maxTotalBytes: -1` plus a recomputed digest is
  accepted. Digest recomputation is an unkeyed SHA-256, so this is reachable by
  anyone who edits the file.
- The JSON repository loads entries into a `Map` keyed by `analysisId`, so a document
  with two entries for one id silently keeps the last one.
- The Python resolver (`python-imports.ts`) is pure and tested, and its outcome
  vocabulary (`resolved`, `unresolved`, `external`, `unknown-root`, `outside-root`,
  `ambiguous`) is deliberately *not* the domain's `ImportEdge.resolution`
  vocabulary (`resolved-relative`, `unresolved-relative`, `external`,
  `outside-root`).
- `web-tree-sitter@0.27.2` (MIT, ESM, no `engines` field) plus a vendored
  `tree-sitter-python` grammar at ABI 15 parses Python in WASM. The probe ran on
  **Node 26.13.1 only**; Node 22.18.0 was never exercised.

The work is therefore staged: the parser, its grammar asset, the encoding subset and
the domain mapping are decided here; the schema-version allocation and the migration
are conditional requirements in decision 5, and `.py` activation is a separate, later
review.

## Decision

### 1. Python extends the analysis architecture; it does not replace it

VOLDBASE remains the platform ADR-0001 describes — a local-first product for
researching, studying, experimenting with and verifying software and AI projects —
with its closed verdict taxonomy (`PASS`, `FAIL`, `INCONCLUSIVE`, `NOT_TESTED`,
`BLOCKED`) unchanged and its static phase still reading code without running it
(ADR-0005). A static reader is one capability of that platform, not its identity:
Python support widens what VOLDBASE can observe, and does not turn VOLDBASE into a
linter or replace any other capability.

Python is a **second `SourceFrontEnd`** in the existing pipeline. It contributes
only which extensions it owns and how verified text becomes declarations, import
edges and findings. It does not walk the tree, select files, enforce limits, read
from the filesystem, build a result, or choose a schema version — those stay in
`analysis-runner.ts`, exactly once, for every language. A Python analysis is the
same `AnalysisSnapshot`, stored in the same append-only document, projected by the
same architecture layer.

**The parser never executes project code.** A tree-sitter parse builds a syntax tree
from bytes; it does not import, evaluate, compile to bytecode or spawn an
interpreter. There is no Python runtime dependency, no `sys.path` inspection, no
`pip`, no `site-packages` lookup and no network. The resolver that classifies imports
is a pure function over the path list the runner already verified.

**`.py` activation stays deferred.** Nothing in this ADR turns Python on. Activation
requires, each reviewed on its own:

1. the parser adapter (pinned runtime, vendored grammar, ABI assertion, integrity
   check, cancellation budget);
2. the extractor (declarations, imports, findings) with its tests;
3. the domain mapping (decision 8) and the schema migration the unified decision
   assigns (decision 5);
4. integration review: limits, encoding behaviour, error precedence and the
   regression tests in the testing section below, plus Node 22.18.0 verification
   (decision 2).

Until all four are complete, `.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts` remain the only
extensions the analyzer owns, and a project of only `.py` files still fails with
`analysis_unsupported_source`.

### 2. Parser runtime and grammar

**Decision: `web-tree-sitter@0.27.2` as a runtime dependency, with the Python grammar
vendored as a WASM asset — `tree-sitter-python` is not an npm runtime dependency.**

Evidence (measured, Steps 3R–3R.2):

| Item | Value |
| --- | --- |
| Runtime package | `web-tree-sitter@0.27.2`, MIT, ESM (`type: module`, also CJS), **no `engines` field**, published from Node 24.22.2 |
| Runtime WASM | `tree-sitter.wasm`, 210,688 bytes, SHA-256 `488beeff7adb7fd7e21e97cc29a43dc6d031977755eda892d6d96c7f456cfdec` |
| Grammar package | `tree-sitter-python@0.25.0`, MIT |
| Grammar WASM | 457,883 bytes, SHA-256 `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| Grammar ABI | `abi` 15; `LANGUAGE_VERSION` 15; minimum compatible 13; 274 node types |
| Observed on Node 26.13.1 | `Parser.init` ≈ 10 ms; grammar loads as `python`; ABI 13–15 accepted; 1.69 M chars / 40 k lines → 16,404 progress callbacks |

Why vendoring the grammar and not installing it:

- `tree-sitter-python` is a native addon package: it declares `node-addon-api` and
  `node-gyp-build` and has an install-script path. Adding it as a runtime dependency
  would make VOLDBASE's install depend on a compiler toolchain for a file we only
  need as bytes.
- The grammar is generated, immutable and small. A checked-in asset is reviewable,
  hashable and loadable offline; a dependency is neither pinned to a digest nor
  inspectable in review.
- The runtime stays a normal dependency because it is JavaScript that loads and
  drives the WASM; reimplementing its binding would be a much larger surface.

Packaging rules for the asset (`vendor/tree-sitter-python/`):

- the WASM file, the upstream `LICENSE`, and a `PROVENANCE.md` recording the upstream
  repository, tag (`v0.25.0`), the `tree-sitter` CLI/ABI used to generate it, the
  generating command, the source commit and the file's SHA-256;
- the asset is shipped in the package (`files` must list the vendor directory, which
  today contains only `bin/`, `dist/`, `README.md`, `LICENSE`, `NOTICE`,
  `TRADEMARKS.md` and `CONTRIBUTING.md`) and loaded by path resolved from the package
  root, not from `dist/`; never fetched at run time, so no CDN, no network and no
  install-time build;
- before `Parser.Language.load`, the loader hashes the bytes and refuses to proceed
  unless they match the pinned SHA-256 — an offline integrity check, reported as
  `analysis_parser_failure`, never as a finding about the project;
- the loaded language reports ABI 15 and `Parser.Language` accepts it; the adapter
  asserts both the ABI range (13–15) and the language name, so a substituted asset
  fails loudly instead of mis-parsing;
- the runtime's own `tree-sitter.wasm` is located explicitly (`Parser.init({ locateFile })`)
  from the installed package and hashed the same way.

**Node compatibility is not proven.** The only runtime in which the parser, the ABI
acceptance and the cancellation behaviour were observed is Node 26.13.1. The project
supports `>=22.18.0` (`package.json`), and CI's `22.x` entry floats to the newest 22
release, so 22.18.0 itself is never exercised. Before activation:

- add a CI job pinned to **Node 22.18.0 exactly** (not `22.x`) that runs the parser
  probe and the analysis tests;
- treat `web-tree-sitter`'s missing `engines` field as "unconstrained and therefore
  unverified", not as support;
- record the resulting matrix in the analyzer version's release notes.

### 3. Cancellation and resource limits

**Verified behaviour (Node 26.13.1):**

- The progress callback is passed as `parse(text, undefined, { progressCallback })`,
  not as the second positional argument (that slot is `oldTree`). It is invoked
  periodically while a parse is in progress; the parse stops only when it returns the
  **literal boolean `true`**, after which `parse` returns `null`. Returning
  `undefined`, `false` or a non-empty string such as `'stop'` does not cancel. A
  numeric `1` was observed to cancel, but that is an implementation accident, not a
  contract; the front end returns `true` or `false` and nothing else.
- **The callback is not guaranteed to run.** For a 12-character file no progress
  callback was invoked and `parse` returned a tree; the same callback on a
  937,780-character file was invoked once, and returning `true` there produced `null`.
  A callback-count budget can therefore only cancel a parse long enough to report
  progress.
- A cancelled parser must be `reset()` before reuse. Verified on Node 26.13.1: after a
  cancelled 937,780-character parse, parsing `x = 1\ny = 2\n` **without** `reset()`
  returned a tree carrying 51 nodes — duplicated structure for an 11-node input,
  including a stale `binary_operator` subtree — while the same parse after `reset()`
  returned exactly the 11-node tree a fresh parser produces. The abort leaves state
  behind; `reset()` is not optional.
- `parse` also returns `null` when no language has been assigned. That is a
  configuration error, not cancellation: initialization and `setLanguage` run once per
  run before any file, and their failure aborts the run (decision 10.3).
- `currentOffset` is a **UTF-16LE byte offset** into the source, not a character
  index and not a fraction: for a 1.69 M-character source the maximum observed value
  was `3,373,330 = 2 × (length − 1)`. Any progress fraction is
  `(currentOffset / 2) / text.length`.
- Cancellation is **cooperative**. Nothing interrupts a running parse from outside
  the callback: there is no thread, no `AbortSignal`, no worker and no memory guard.
  A parse with no progress callbacks cannot be stopped, and a callback that never
  returns `true` runs to completion.

**Proposed limits (not implemented; values are proposals to be measured):**

- a **deterministic step budget** per file — cancel after a fixed number of progress
  callbacks (initial proposal: 250,000 for one file) and report
  `analysis_limit_exceeded` naming the file and the budget. A step budget is chosen
  over a wall-clock deadline because it does not depend directly on machine speed.
  That is **not** a universal determinism guarantee: callback counts depend on the
  pinned runtime and grammar versions, and an identical input can produce different
  counts across versions. The snapshot digest makes analysis *records* reproducible;
  it says nothing about how the parser executes. Determinism must be established for
  the pinned runtime and grammar with a fixed input before a value is relied on.
  **250,000 is provisional**: it is not a measured safe limit and not a timeout. Before a
  production value is chosen the following are required: (a) callback counts and
  parse wall time per budget on a corpus that includes adversarial input, measured on
  the minimum supported Node version; (b) peak memory per budget on the same corpus;
  (c) a latency target agreed for one analysis run; (d) tests proving the budget is
  reached deterministically for a fixed input, that the error is
  `analysis_limit_exceeded`, and that `reset()` makes the next parse independent
  (D20). Cancellation is never reported as `VB001`; that finding exists only for a
  returned tree (decision 10).
- the existing input bounds apply unchanged before the parser is called:
  `maxSourceFiles` 5,000, `maxFileBytes` 8 MiB, `maxFiles` 20,000,
  `maxTotalBytes` 256 MiB (`DEFAULT_ANALYSIS_LIMITS`). They bound *input*; they do not
  bound parser CPU or memory.
- if measurement later justifies a wall-clock ceiling, it is a safety valve recorded
  as such, and its nondeterminism is documented rather than hidden.

**What this ADR does not claim:** no hard CPU bound, no memory bound, no process
isolation and no timeout guarantee. The parser is a library call in the same process;
worst-case time and memory for adversarial input are not bounded by anything decided
here, and the honest statement is that analysis of a hostile file can be slow.

### 4. Python source encoding (PEP 263 subset)

The shared runner keeps its current behaviour for every language: a file with a
source extension that contains a NUL byte fails with `analysis_unsupported_source`,
and the runner decodes bytes as UTF-8 (`decodeSource`). **Neither is changed here**,
and TypeScript behaviour is untouched.

Because a PEP 263 source may be neither UTF-8 nor NUL-free-in-the-UTF-8-sense, the
Python front end re-decodes from `SourceEntry.bytes` and treats `SourceEntry.text` as
a UTF-8 view it does not use. The decoding rule is a bounded subset of PEP 263,
verified against CPython 3.12.3's `tokenize.detect_encoding`:

- **Cookie pattern:** `^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)`, matched
  against the raw bytes of a physical line. `coding` is lowercase — `# CODING:` is not
  a cookie. The name may be preceded by `-*-` or embedded in a vim modeline
  (`# vim: set fileencoding=…`) because the pattern only requires `coding[:=]` later
  in the comment. A mention inside a string literal is not a cookie, because the line
  must start with optional whitespace and `#`.
- **Position:** the cookie is read from physical line 1, or from physical line 2 only
  when line 1 is blank or a comment (`^[ \t\f]*(?:[#\r\n]|$)`). A cookie on line 2
  after a line of code is ignored, and that is what CPython does (verified).
- **Default:** UTF-8. **UTF-8 BOM:** stripped and recorded as `utf-8-sig`. A BOM with
  a conflicting non-UTF-8 cookie is contradictory; CPython raises
  `SyntaxError: encoding problem: utf-8`. VOLDBASE treats that pair as an
  unsupported-encoding file (rule `VB006`, no extraction) instead of guessing which
  half is right, and never calls the source invalid.
- **Supported declared encodings (bounded allowlist):** `utf-8`, `utf8`,
  `utf-8-sig`/`utf8-sig`, `ascii`/`us-ascii`, `latin-1`/`iso-8859-1`/`iso8859-1`, and
  `cp1252`/`windows-1252`, each only when the decoder used is byte-exact for it.
  Everything else (`cp1251`, `shift_jis`, `big5`, …) is **not** supported.
- **Unsupported or contradictory declared encoding:** the file is **not decoded on a
  guess and not extracted from**. It yields a file-level conditional diagnostic
  (`VB006`, see decision 8) and **no declarations and no import edges**, so no
  confirmed dependency can come from source we could not read as declared.
  Byte-offset preservation is a different property from semantic decoding: even a
  byte-exact fallback decoding (for example ISO-8859-1, which maps one byte to one
  UTF-16 code unit) would keep line and column offsets usable while still
  misrepresenting non-ASCII identifiers and string contents, and a syntactically
  plausible tree over that text would not be evidence about the original source. No
  such tree is produced or interpreted.
- **Remaining representation gap, stated rather than hidden:** no version decided
  here has a per-file "not analysed" status. A file refused for encoding is still
  recorded (path, size, digest) with empty declaration and import lists plus its
  `VB006` finding. The finding is the statement that the file was not read; no
  consumer may interpret the empty lists as "this module has no declarations or
  imports". A per-file status is a later schema decision (see Open questions).
- **UTF-16 / UTF-32 are binary for this path,** not "another unsupported PEP 263
  codec". The shared runner's NUL check runs first: UTF-16/32 text containing any code
  point in `U+0000–U+00FF` carries NUL bytes and is already refused with
  `analysis_unsupported_source`. The Python decoder additionally sniffs the UTF-16/32
  BOMs (`FF FE`, `FE FF`, `00 00 FE FF`, `FF FE 00 00`), but this is **defense in
  depth, not an independently verified path**: it is reachable only for byte sequences
  containing no NUL bytes (pure non-ASCII UTF-16/32, or a lone BOM), and that case was
  not exercised in the probe. The runner's NUL rule is unchanged; an ASCII file that
  merely *declares* `# coding: utf-16` is contradictory and falls under the
  unsupported-encoding rule above.

Codec details that still need implementation-time verification:

- WHATWG `TextDecoder` maps the label `iso-8859-1` (and `latin1`) to **windows-1252**,
  which differs from Python's `iso-8859-1` for bytes `0x80–0x9F`. This must be
  resolved before either name is implemented: `iso-8859-1` needs a true ISO-8859-1
  decoder (for example `Buffer.toString('latin1')`) and `cp1252` needs its own, because
  a single label lookup would silently alias two different codecs and mis-decode the
  same bytes under Python and VOLDBASE. Confirmed on Node 26.13.1:
  `new TextDecoder('iso-8859-1')` reports `windows-1252` and maps `0x80` to `€`, while
  `Buffer.from([0x80]).toString('latin1')` maps it to `U+0080`.
- CPython's cookie regex character class is `[-\w.]` over bytes; the pattern above is
  the ASCII-anchored equivalent. Whether non-ASCII bytes inside the comment before
  `coding` change matching must be tested, not assumed.
- Whether `unused-coding-cookie`/BOM-plus-cookie cases deserve their own diagnostic
  text is a wording question for implementation.

### 5. Analysis schema evolution and migration integrity (version numbers deferred)

**Version numbers are deferred.** This ADR does not assign a value to
`ANALYSIS_SCHEMA_VERSION` or to `ANALYSES_STORAGE_SCHEMA_VERSION`. Both numbers are
deferred to a single unified schema-evolution decision covering every recorded format,
not only analysis. Until that decision is accepted and implemented, this ADR allocates
no version and claims no migration path; the requirements below are what such a
decision must satisfy for Python, with the numbers left as placeholders.

**Two versions, two jobs.** `ANALYSIS_SCHEMA_VERSION` names the meaning of one
analysis record: which vocabularies and rules its fields obey. It is part of the
hashed content. `ANALYSES_STORAGE_SCHEMA_VERSION` names the envelope document
(`{ schemaVersion, analyses }`): which entry versions it may contain and how it is
laid out. It is not hashed. A Python vocabulary change alters the record vocabulary,
and accepting new entry versions alongside v1 is an envelope statement, but neither
statement makes the two numbers equal or ties them to a single move. They must stay
separate constants, because an envelope-only change (a new top-level field) may bump
only the storage version, while a record-only change leaves the envelope number to the
unified decision.

**Independent axes, not one number twice.** `ANALYSIS_SCHEMA_VERSION` and
`ANALYSES_STORAGE_SCHEMA_VERSION` are separate dimensions: this ADR assumes neither
that a new record version forces the same envelope version nor the reverse. The
**declared compatibility matrix** is where the two axes meet, and each pair it declares
carries both numbers explicitly alongside its validator, digest rules and migration
behaviour — so a declared pair whose two numbers differ is as valid as (v1, v1).
`(next, next)` is not an assumed default, and no pair is derived from arithmetic on the
other number.

**Scope of the unified decision.** That decision must account for every approved change
to the recorded format, not only Python's:

- Python analysis vocabulary additions: the domain values `unresolved-root` and
  `ambiguous` (decision 8), plus `python` as a language value.
- Workspace Resolution: the `resolved-workspace` resolution value and its
  `resolvedPath` invariants.
- Any other approved change that affects persisted analysis records or storage
  compatibility.

Recording Workspace Resolution in this scope records its dependency on the version
decision only. It does not implement Workspace Resolution, change its design, or treat
its earlier approval as authorization to implement it.

**What the unified decision must determine, and this ADR must not.** For each change in
scope that decision must record a versioning treatment and a compatibility declaration,
not leave them implied by a number, an adjacency or an equality. For the Python
vocabulary additions — the domain values `unresolved-root` and `ambiguous`, `python` as
a language value, and the resulting six-value import-resolution vocabulary (the existing
`resolved-relative`, `unresolved-relative`, `external` and `outside-root` plus those
two) — it must answer each of the following explicitly, with reasons:

- Whether the additions share **one** new analysis schema version, or whether they
  require **independent** versioning — for example `python` as a language widening and
  the two resolution values as a resolution widening treated as separate moves.
- Whether any part of the change requires **no version increment at all** — for example
  a value already present in the domain vocabulary but never produced by a v1 analyzer
  and never accepted by the frozen v1 rules, or a change the current envelope can carry
  unchanged.
- Whether adopting the additions changes what an existing `ANALYSIS_SCHEMA_VERSION`
  value means, because a value the number previously excluded becomes legal under it.
- Which (envelope, entry) **compatibility pairs** the move declares, which validators
  each declared pair requires, and therefore whether `ANALYSES_STORAGE_SCHEMA_VERSION`
  moves with the entry number, moves on its own, or stays where it is.

This ADR chooses none of those answers. Its only requirement here is procedural: the
unified decision must contain an explicit determination for each question and must
declare its compatibility pairs rather than deriving them from arithmetic. A record that
says "some version, to be decided" satisfies neither this ADR nor the matrix rule above
that an undeclared pair is `analysis_corrupted`.

**What a new version must add (conditional).** Once a version is assigned, the record
vocabulary it defines must contain the `python` language value (already present in the
domain vocabulary since the Stage 1 widening, but never produced by a v1 analyzer and
not accepted by the frozen v1 rules) and six import-resolution values instead of four:
the existing `resolved-relative`, `unresolved-relative`, `external`, `outside-root`
plus `unresolved-root` and `ambiguous` (decision 8). Which versioning treatment
applies to each addition, and which schema versions carry those changes, is the
unified decision's to determine and record against the questions above.
Canonicalisation — key ordering, array ordering, which fields the digest covers — must
be **unchanged**: a new version changes which values are legal, not how bytes are
hashed.

**Frozen v1.** The v1 normaliser and v1 vocabularies are copied into a frozen module
(`IMPORT_RESOLUTIONS_V1`, `DECLARATION_KINDS_V1`, `ANALYSIS_LANGUAGES_V1`,
`ANALYSIS_SETTINGS_RULES_V1`, `normalizeAnalysisContentV1`) and are not edited again.
`ANALYSIS_LANGUAGES_V1` is `['javascript', 'typescript']`: a real v1 analyzer could
not produce `python`, so a v1 record containing it is corrupt, not "forward
compatible". The next version's vocabularies are separate constants; v1 validation
must never be widened to accept a value the new version introduces, and the new
validation must not be used to verify a v1 record. The v1 canonicalisation is pinned
by a literal digest taken from that pre-freeze implementation and reproduced by the
frozen normaliser (D22); that pin is a mandatory regression requirement, not an open
question.

**Migration order (mandatory, once a version is assigned).** Every step is observable
and aborts on failure. Steps 1–4 are shared by both read paths; steps 5–9 run only for
a (v1, v1) entry, and step 10 only for an entry at the assigned version. The version
numbers in these steps are placeholders; the order and the verify-before-transform
property are the requirement.

1. Validate the storage envelope version. An envelope version this build does not
   support stops here with `storage_unsupported_schema`; no entry version, pair,
   validator or digest is inspected afterwards.
2. Look the (envelope, entry) pair up in the **declared compatibility matrix**. An
   entry version that is missing, not an integer, or paired with this envelope without
   being declared there stops here with `analysis_corrupted`. Version equality is not
   the rule; the matrix is, and a declared pair's two numbers may differ.
3. Check that every validator the declared read path requires is available in this
   build, before any structural or semantic validation, digest work or migration
   begins. A (v1, v1) entry requires both the frozen v1 validator and the validator
   for the assigned version that validates the migrated record; an entry at the
   assigned version requires that validator. If any validator the selected path needs
   is unavailable, stop here with
   `analysis_unsupported_schema`.
4. Branch on the declared pair. A (v1, v1) entry continues with steps 5–9; an entry at
   the assigned version continues with step 10. The other path's steps are skipped
   entirely, so a record at the assigned version is never validated, migrated or
   hashed as if it were v1.
5. **(v1, v1) Validate with frozen rules.** Apply the **frozen v1** structural and
   semantic validation to the entry and reconstruct the original v1 canonical content
   from it (same normaliser as the v1 build used, including the recomputed `summary`).
6. **(v1, v1) Verify the recorded v1 digest.** Recompute the **v1 digest** under the
   pair's declared digest rules and compare it with the recorded digest — before any
   data is changed. A mismatch is `analysis_corrupted`.
7. **(v1, v1) Migrate in memory.** Transform the validated record into the assigned
   version (`schemaVersion` set to that number, its vocabulary). Nothing is written by
   the read.
8. **(v1, v1) Validate the result independently.** Apply the assigned version's
   validation to the transformed record.
9. **(v1, v1) Compute the new digest and persist.** Compute the **digest under the
   assigned version's rules** for the transformed record, then persist the complete
   migrated document atomically on the next save (`#writeToDisk`: temporary file +
   rename under the existing exclusive lock). Failure behaviour is decision 9.
10. **(assigned entry version) Validate and verify.** Apply the **assigned entry
    version's** structural and semantic validation to the entry and recompute its
    digest under the declared pair's rules, comparing it with the recorded digest. An
    entry in this pair is not migrated, not transformed and not hashed twice; a
    mismatch is `analysis_corrupted`.

**The matrix decides compatibility; equality is not a substitute.** The only pair
declared today is (v1, v1); every further pair is declared when its envelope number,
its entry number, its validator, its digest rules and its migration behaviour are
decided and implemented, never in advance. The two numbers of a declared pair are
independent and may differ; `(next, next)` is not a default, and no pair is inferred
from the other number. A future mixed pair — a newer envelope with an older entry
version, or an older envelope with a newer entry version — is accepted only once it is
explicitly declared with its validator, its digest verification rules and its
migration behaviour, never because the two versions happen to be adjacent, one of them
matches the envelope, or both would carry the same number.

Under the proposed migration, the v1 read path transforms the whole document in memory;
nothing is written by a read. That transformation and its cache semantics are the
intended post-implementation behaviour (decision 9); today the read path validates v1
records and does not transform them to a newer version. Because the digest covers
`schemaVersion`, a migrated v1 record has a **different**
digest from the v1 record it came from. That is intended: the v1 digest is preserved
only as a check, never as the current digest. The repository's immutability rule
(`analysis_immutable`) compares an incoming save against a fresh read of the document
under the lock (which is itself migrated on read), so re-saving a migrated record is a
no-op and not a false conflict; a v1 digest is never compared against a newer digest.

**`summary` is derived, never stored and never trusted.** `StoredAnalysis` has no
`summary` field; `summarizeAnalysis()` recomputes it from the validated files and
findings during step 5 (v1) and step 10 (the assigned version). An injected `summary`
key is ignored in memory and dropped on the next write. There is no summary
comparison to add.

**Settings counters are validated.** `maxFiles`, `maxTotalBytes`, `maxFileBytes` and
`maxSourceFiles` must be positive safe integers (`Number.isSafeInteger(value) &&
value >= 1`). This is the only constraint the domain actually has: no cross-field
relation (`maxFileBytes ≤ maxTotalBytes`) is asserted, because none is implemented
today and inventing one would reject legitimately recorded settings. No numeric
limit is invented here; the values in the snapshot remain whatever the run used.

**Duplicate `analysisId` is rejected.** A document containing the same `analysisId`
twice fails with `analysis_corrupted` naming the id, instead of the current silent
last-entry-wins behaviour of `new Map(...).set(...)`. The message reports both
positions so a hand-edited file can be repaired deliberately.

### 6. Error precedence

One rule per failure, decided in this order:

| Condition | Error |
| --- | --- |
| Envelope `schemaVersion` is a supported integer but **newer** than this build | `storage_unsupported_schema` |
| Envelope `schemaVersion` is a supported integer but **older** than any migration path this build has (today: `< 1`) | `storage_unsupported_schema` |
| Envelope `schemaVersion` missing, non-numeric, non-integer, or the document is not an object | `analysis_corrupted` |
| Entry `schemaVersion` missing or not an integer | `analysis_corrupted` |
| Envelope version is supported but the (envelope, entry) pair is absent from the declared compatibility matrix | `analysis_corrupted` |
| The (envelope, entry) pair is declared but this build lacks the validator it requires | `analysis_unsupported_schema` |
| Invalid entry structure, invalid semantic values (including settings), duplicate id | `analysis_corrupted` |
| Reconstructed content does not match the recorded digest | `analysis_corrupted` |

**Envelope/entry compatibility pairs.** The table is a matrix over
(`ANALYSES_STORAGE_SCHEMA_VERSION`, entry `schemaVersion`) pairs, declared explicitly
in the storage-schema module and read top to bottom as the validation order: envelope
first, pair second, validator third, content fourth, digest last. A pair is classified
by looking it up in that matrix; neither equality between the two numbers nor the
adjacency of the versions is consulted.

- Under a supported envelope, an **undeclared** pair — an envelope/entry version pair
  that is absent from the explicitly declared compatibility matrix — is rejected with
  `analysis_corrupted`. No validator runs and no digest rule is applied, because there
  is no declared meaning to check.
- A **declared** pair with no available validator in this build returns
  `analysis_unsupported_schema`: an upgrade instruction, not corruption, with no
  validation or digest rule applied.
- Only a **declared** pair whose required validator exists proceeds to structural and
  semantic validation, and then to digest reconstruction and comparison.

Two corrections to today's behaviour are explicitly part of this decision:

- `storedToAnalysis`'s catch-all must **not** rewrite `analysis_unsupported_schema`
  into `analysis_corrupted`. Only genuinely structural/semantic failures keep the
  corruption code; a known-but-unavailable entry version is an upgrade instruction.
- A malformed envelope version is a **structural** failure (`analysis_corrupted`),
  matching the current `detectVersion` behaviour. It is not reported as
  "unsupported schema", because nothing in the document proves which schema it meant.

### 7. Digest security boundary

The recorded digest is an **unkeyed SHA-256** over canonical JSON. It detects
accidental corruption, truncation, hand-edits and inconsistencies between a record and
the evidence it claims to summarise. It is **not** a digital signature, not a MAC and
not authentication: an actor who can write `analyses.json` can also recompute the
digest, and a record with a recomputed digest is accepted — this was observed in the
Step 3R.3 probe and is a property of the design, not a bug to paper over. Nothing here
may be described as tamper-proof, tamper-evident against a deliberate editor, or
"cryptographically verified evidence". Integrity against a local attacker is out of
scope; the architecture layer re-verifies the digest it is given (ADR-0017) for
consistency, not for authenticity.

### 8. Domain mapping and diagnostics

The resolver's vocabulary and the domain's vocabulary are **not the same**, and must
not be merged by widening the domain to match the resolver. The mapping is explicit:

| `PythonImportStatus` | `ImportEdge.resolution` | `resolvedPath` | Evidence kept |
| --- | --- | --- | --- |
| `resolved` | `resolved-relative` | the resolved file (module or `__init__.py`) | the path the snapshot proves |
| `unresolved` | `unresolved-relative` | — | containing packages are known, the module is not |
| `external` | `external` | — | nothing in the snapshot names it anywhere |
| `outside-root` | `outside-root` | — | the dots climb above the project root |
| `unknown-root` | **`unresolved-root`** (new) | — | a plausible local module exists under a single top-level directory |
| `ambiguous` | **`ambiguous`** (new) | — | the layout cannot prove a unique target |

Both `unresolved-root` and `ambiguous` are conditional requirements: they need a new
analysis schema version to be assigned (decision 5). Until then the four-value v1
vocabulary remains the only recorded vocabulary.

- `unknown-root` must **not** map to `external`: the point of the outcome is that the
  snapshot contains a plausible local module and the import root is unconfigured.
- `ambiguous` must **not** map to `unresolved-relative`: "the path matches nothing" and
  "the paths conflict" are different statements, and only one of them is about a
  missing file.
- **What the implementation actually proves** (checked against `python-imports.ts` and
  `tests/python-imports.test.ts`): `external` means no analysed path names the module
  anywhere; `unknown-root` means nothing at the project root names it but a module or
  package for that dotted name exists under **exactly one** top-level directory, so the
  import root is unconfigured; `unresolved` means the containing packages are visible
  and the leaf is not; `ambiguous` means the layout cannot establish a unique target
  (module and package of the same name, a missing `__init__.py` in the chain, a bare
  directory, or a root-level relative import whose root package cannot be known).
  Tests pin each case, including "a `src/`-layout package is unknown-root, not
  external" and "a genuinely absent name stays external".
- **Limits of that distinction, kept as limits:** `unknown-root` is conservative by
  design. It is only considered for absolute imports and only for a module under a
  single top-level directory, so a root such as `backend/src` stays `external`, while
  a `docs/` or `examples/` directory holding a same-named module can produce
  `unknown-root` where nothing local is intended. The snapshot alone cannot separate
  documentation or fixtures from an import root; the ADR records that as an open
  limitation rather than adding heuristics.
- `implicitPaths` and `itemCandidates` are **conditional evidence and do not become
  edges.** They are not fields of `ImportEdge` in the new version: the architecture
  layer turns
  every `resolved-relative` edge into a dependency edge (ADR-0017), so putting
  implicit `__init__.py` files or `from package import item` candidates into `edges`
  would silently manufacture dependencies that Python may not have (CPython imports
  `package.item` only when the package does not already define that name). Carrying
  them in the snapshot needs its own field and its own ADR (a later schema version).
- The invariant "`resolvedPath` is present if and only if `resolution` is
  `resolved-relative`" (and names an analysed file) is kept for a later version and
  becomes that vocabulary constant's rule; the frozen v1 rule stays exactly as it is.
- **JavaScript/TypeScript behaviour is unchanged.** Their front end keeps producing
  the four v1 values for the same inputs, and the same digests for the same content.

Diagnostics: a parser diagnostic is evidence of a limit of our reading, not a verdict
on the source.

- **`VB001` for Python keeps its identity but not its severity:** rule id, meaning
  ("the parser could not read this file"), location and evidence stay; severity is
  `warning` and certainty is `conditional`. Tree-sitter recovers from syntax errors and
  returns a tree containing `ERROR`/`MISSING` nodes for constructs it cannot place;
  that is the only case `VB001` covers for Python (decision 10.1). Parser
  initialization, grammar loading, language loading, ABI mismatch and runtime parser
  failures are not syntax recovery: they fail before or during the call and are
  reported as `analysis_parser_failure`, never as `VB001` (decision 10.3). Calling a
  recovered tree an `error` about the project
  would be a false claim, so the message states what could not be read and that
  VOLDBASE does not conclude the file is invalid Python. TypeScript's `VB001` stays
  `error`/`certain`.
- **`VB005` (new, proposed):** `warning`/`conditional` — an absolute import is
  classified `unresolved-root`, i.e. a plausible local module exists but the import
  root is not configured. Message names the candidate directories, never a verdict.
- **`VB006` (new, proposed):** `warning`/`conditional` — the file declares an encoding
  outside the supported subset (including a contradictory BOM/cookie pair). The message
  names the declared encoding and states that the file was not read or extracted from,
  so no declarations or imports exist for it.
- `ambiguous` resolutions carry no separate finding: the resolution value is the
  statement, and a finding would duplicate it in every list.

### 9. Migration persistence failure and repository state

`save()` in `json-analysis-repository.ts` builds the next in-memory map, awaits
`#writeToDisk(next)`, and only then assigns `this.#analyses = next`. The consequences
are decided here explicitly because a migration is written by exactly this path:

- **Memory is updated after a successful write, never before.**
- `#writeToDisk` serialises the whole document, writes
  `<file>.${pid}.${uuid}.tmp` with mode `0600`, then renames it onto the document. A
  temporary-file creation or write failure is caught there: the temporary file is
  removed (best effort) and `storage_write_failed` is thrown.
- **A rename failure takes the same path:** the temporary file is removed, the error
  is `storage_write_failed`, and the original document is untouched. Rename within one
  directory is atomic on POSIX, so a concurrent reader sees either the whole old
  document or the whole new one — never a partial one.
- **Cache state, narrowed to what the code proves:** the cache mechanics below are
  current; the migrated form and migration retry semantics are intended behaviour once
  the decision 5 migration is implemented. Today `ANALYSES_STORAGE_SCHEMA_VERSION` is `1`
  and a read validates v1 records without transforming them. `this.#analyses` still
  holds the map from the last successful `#load()` or the last successful write.
  `findById` and `listByProject` go through `#load()`, which returns that map and
  **never re-reads** while it is defined (`json-analysis-repository.ts:118–125`).
  Under the proposed migration, a map populated by a read is already in migrated
  form, so after a failed migration write the cache can hold migrated records while
  the document is still v1: the records are equivalent, but the cache is not byte-identical
  to the file. If no read has populated the cache, the
  next `findById`/`listByProject` calls `#readFromDisk()` and migrates the unchanged
  v1 document again. After a failed save the reader therefore sees this process's
  pre-save state, which matches disk only while no other process has written since the
  map was loaded or assigned. `save()` is different: it always calls
  `#readFromDisk()` under the lock
  (`json-analysis-repository.ts:84`), so a write is based on fresh disk state.
  Read freshness after a concurrent writer is **not** guaranteed and is not claimed
  here. The lock is released in `finally` in every case.
- **Leftovers:** if removing the temporary file also fails, a `*.tmp` file may remain.
  It is never the document, and reads ignore it.
- **Reads never write.** A migration that fails in memory (bad v1 digest, assigned-
  version validation failure) persists nothing. It is recomputed only on the next read
  that actually reaches disk: `#load()` returns the cached map without re-reading once
  `this.#analyses` is populated (`json-analysis-repository.ts:118–125`), so an
  already-loaded repository instance does not retry the migration on every subsequent
  read. This retry statement is part of the intended post-implementation behaviour,
  not current code.
- **Next save** starts from a fresh `#readFromDisk()` under the lock, so a migrated
  document is re-derived and written once, and a repeated failure leaves the v1 file
  readable again next time.
- **Process death** between the temporary write and the rename leaves at most a stray
  temporary file; the document remains the previous complete one.

What is *not* claimed: none of these failure paths has a failure-injection test today,
which is why D16 and D17 exist. Directory problems are reported as
`storage_write_failed`, but not always before locking: `save()` prepares the directory
before taking the lock (`json-analysis-repository.ts:75–80`), while `#writeToDisk()`
calls `mkdir` again inside the locked section (`:165`). Disk-full and power-loss
durability (`fsync`) are not addressed by the current implementation and are not
claimed here.

### 10. Parser failure categories and partial recovery

Tree-sitter is error-tolerant: it returns a tree even when it could not place every
construct, marking nodes `ERROR`/`MISSING` and the tree `hasError`. A recovered tree is
not a reading of valid Python, and treating it as one would fabricate confirmed
structure.

**Detection.** A file is *partially read* when the returned tree has `hasError` or
contains any node with `isError`/`isMissing`. The flags are per node: a probe of
`def f(:` returned a tree whose root reported `isError = false` while the root's
`hasError` was `true`, so testing the root's own flags alone is insufficient; the tree
is scanned.

Three failure categories are separated on purpose. They produce different evidence and
must not be collapsed into one another.

**10.1 A returned tree containing `ERROR`/`MISSING` (syntax recovery).**

- **Extraction:** none. Zero declarations and zero import edges.
- Exactly one file-level `VB001` finding (`warning`/`conditional`) naming the first
  error range, with bounded evidence quoted.
- **No confirmed dependency can come from it.** `ImportEdge` has no uncertainty field
  and the architecture layer turns every `resolved-relative` edge into a dependency
  edge (ADR-0017), so the only guarantee that cannot be violated is that no edge is
  emitted. Emitting `VB001` alongside extracted edges would not be a safeguard:
  consumers read `imports[]`, not the finding list.
- **Representation:** the file record keeps path/size/digest with empty lists, and
  `VB001` is the statement that it was not read. This is the same representation gap as
  decision 4 — no version decided here has a per-file status — and it is recorded
  as an open question rather than disguised.
- **Deliberate cost:** one unparsable line loses that file's declarations and imports.
  That is coarse on purpose. Per-subtree extraction guarded by "no `ERROR`/`MISSING`
  ancestor", with an explicit certainty marker on `ImportEdge`, is a later schema
  design that needs its own schema and its own evidence.

**10.2 Cancellation by the deterministic step budget.**

- `Parser.parse` returns `null` when the progress callback fires and returns `true`
  (a parser with no assigned language also returns `null`, which initialization and
  the ABI/name assertion prevent from reaching this path); no partial result is used
  and no declarations or edges are produced for the file.
- The run fails with `analysis_limit_exceeded`, naming the file and the budget.
- The parser is `reset()` before reuse, and the next parse must be independent of the
  aborted one (decision 3, D20).
- Cancellation is **not** `VB001`: no tree was returned to diagnose, and the finding
  list describes what was read, not a limit of the run.

**10.3 Parser initialization, grammar loading, ABI or runtime failure.**

- Initialization, grammar-loading, ABI or runtime parser failures abort the whole
  analysis run. No per-file record is persisted for that failed run; no partial
  analysis result is used, and no declarations or edges are produced.
- The run fails with `analysis_parser_failure`, the existing documented contract for
  "a front end could not account for a file it was given" (`analysis-runner.ts`). A
  more specific code is used only where an existing documented contract already
  requires one — for example `analysis_unsupported_source` for a binary source, which
  is a source-selection decision made before the parser is called, not a parser
  failure.
- **Not** `VB001`: these are failures of the parser or its environment, not syntax
  recovery in a returned tree. Verified runtime behaviour (Node 26.13.1,
  `web-tree-sitter@0.27.2`, grammar `tree-sitter-python@0.25.0` at ABI 15; cases that
  could be masked by `Parser.init` caching were run in a fresh process):
  - `Language.load` on bytes without a WASM header throws
    `Error: need to see wasm magic number`; on a WASM file lacking the dylink section
    the same call threw `Error: need the dylink section to be first`.
  - `Language.load` on a missing grammar path throws an `Error` with code `ENOENT`.
  - `Parser.init` with a missing runtime WASM rejects with
    `RuntimeError: Aborted(Error: ENOENT: …)`; with invalid runtime bytes it rejects
    with `RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): expected
    magic word …)`.
  - An incompatible language version makes `setLanguage` throw
    `Error: Incompatible language version 99. Compatibility range 13 through 15.`
    This was induced by writing version 99 into the loaded grammar's version field in
    WASM memory, because no genuinely incompatible grammar binary was built; it
    exercises the runtime's ABI guard, not a real version-skew pair.
  - `parse` on a deleted parser throws `RuntimeError: memory access out of bounds`.
  None of these returns a tree; no tree exists to contain `ERROR`/`MISSING` nodes, and
  `parse` is never reached for the initialization and language-loading cases.
- Initialization and language loading happen once per run, before any file is parsed;
  a failure there aborts the analysis instead of producing per-file findings.

A tree is only ever examined by 10.1; 10.2 and 10.3 abort the run.

## Rationale

**Why a second front end rather than a second analyzer.** The expensive properties of
Phase 2A — revision verification before and after parsing, per-file digest re-checks,
source selection, bounds, deterministic result assembly — live in `analysis-runner.ts`.
A second analyzer class would have to call that runner anyway, so a front end that
only owns extensions and extraction is the smallest seam that cannot re-implement (and
thus weaken) the integrity checks. It also makes the language boundary testable: a
front end cannot touch the filesystem because it is handed text and bytes.

**Why WASM rather than a native grammar.** A native addon reintroduces exactly what
ADR-0016 rejected for this phase: a build step at install time, platform binaries and
a supply chain users cannot inspect. A generated grammar is a single immutable file;
vendoring it makes the parser's input to the analysis auditable and the install
network-free. The trade-off is real — WASM is slower than a native parse and the
runtime is a dependency we do not control — and is accepted because correctness and
reviewability matter more here than parse throughput, which the input bounds already
cap.

**Why the digests must move, and why that is safe.** `schemaVersion` is hashed, so a
record at a new version cannot keep a v1 digest. Keeping v1 digests valid would mean
hashing `schemaVersion` out of the content, which would invalidate every existing v1 digest
(all of them were computed with it) and destroy the only check that proves an old
record is intact. Instead, the v1 digest is verified under frozen v1 rules before any
transformation, and the new digest is computed afterwards. Old evidence keeps its
integrity check; new evidence gets a digest that describes the record as it now is.

**Why verify before transforming.** Validating a v1 record with the next version's
rules and hashing the result would accept a record whose stored digest was never
valid — exactly the laundering the migration must avoid. It would also silently
reinterpret v1 data (a v1 `resolved-relative` entry is valid under the next version's
wider vocabulary but the reverse is not). Frozen rules plus "verify first, transform second" keeps both
directions honest.

**Why `unknown-root` and `ambiguous` are new domain values.** They describe things the
snapshot can see and the existing four values cannot say. Collapsing them into
`external` or `unresolved-relative` would make the recorded analysis assert something
it did not establish, and the architecture layer would then draw a graph edge or omit
one for the wrong reason. Adding values costs a schema bump; asserting a false
classification costs the product's credibility.

**Why the encoding subset is explicit and small, and why there is no fallback.** PEP
263 permits any registered codec. Implementing "any codec" means shipping a codec
table and trusting a decoder per label; the failure mode is silent mis-decoding. A
short allowlist whose decoders are byte-exact plus a conditional diagnostic for
everything else is honest about the limit. A fallback decoding was considered and
rejected as *evidence*: preserving byte offsets is a property of the mapping, not of
the characters. A tree built over ISO-8859-1 readings of, say, cp1251 bytes has the
right line and column numbers and the wrong identifiers, so its declarations and
imports would be confident statements about text nobody decoded. The diagnostic is the
one honest output for such a file, and it is emitted without extraction. Treating
UTF-16/32 as binary is not a gap being hidden: those files do not satisfy the "source
text" assumption the pipeline is built on, and the existing NUL rule already says so.

**Why a partially recovered tree is not extracted from.** Tree-sitter's recovery is a
feature for editors and a hazard for evidence: the tree always exists, so "the parser
produced a tree" proves nothing about the source. Since `ImportEdge` cannot express
uncertainty and the architecture layer trusts every `resolved-relative` edge, the only
policy that cannot manufacture a dependency is to extract nothing from a tree that
reports an error and to record the limitation as a finding. The cost — losing a whole
file's structure to one bad construct — is accepted because a missing edge is visible
as a finding, while a fabricated edge is not visible at all.

**Why the digest boundary is stated so bluntly.** The audit's probe showed a record
with a recomputed digest is accepted, including nonsense settings. The mitigation is
validation of the record's values, not a stronger digest: a local-first tool cannot
keep a key the user cannot read, and pretending SHA-256 is authentication would invite
reliance it cannot support. Validation closes the reachable false-acceptance cases;
the remaining boundary is documented rather than described as security.

## Alternatives considered

- **Install `tree-sitter-python` as a runtime npm dependency.** Rejected: native
  addon, install-script path, per-platform build, for a file whose only role is bytes.
  Installing with `--ignore-scripts` and reaching into `node_modules` for the WASM
  would still make installability depend on the package's build metadata.
- **Fetch the grammar WASM from a CDN at run time.** Rejected: network at analysis
  time, unpinned bytes, and a hash that cannot be verified before use is decoration.
- **Port the grammar to a pure-JS parser / use a regular-expression reader.**
  Rejected: regex cannot distinguish strings from code, and a hand-written Python
  parser is a much larger, less reviewable surface than a generated grammar.
- **Keep one schema version and add Python under v1.** Rejected: v1 records would then
  contain `unresolved-root`/`ambiguous`/`python`, which v1-era builds reject — the
  vocabulary would silently widen historical rules, which is what this ADR forbids.
- **Bump only `ANALYSIS_SCHEMA_VERSION` and leave both the envelope number and the
  compatibility matrix untouched.** Rejected as a shape, independent of the numbers: an
  envelope that accepts an entry version its declared matrix does not pair with it is
  lying about what it contains. Whether the envelope *number* must change, or whether
  the new entry version is declared as a pair under the existing envelope number, is
  the unified decision's to make (decision 5). Moving only `ANALYSIS_SCHEMA_VERSION` is
  therefore not rejected as such — only the undeclared widening of entry versions is.
- **Keep v1 digests valid by excluding `schemaVersion` from the hash.** Rejected: it
  invalidates every existing v1 digest and removes the check that proves old records
  are intact. A categorical version marker outside the hash was also rejected:
  it is the same information with weaker guarantees.
- **Trust `summary` from the stored record to avoid recomputation.** Rejected: it is
  derived in one line, it is not stored, and a stored summary would be a second source
  of truth that can disagree with the files it counts.
- **Compare the stored summary against the recomputed one as an integrity check.**
  Rejected: there is nothing stored to compare; a forged summary is inert because the
  digest is computed from the recomputed value.
- **Migrate lazily per record on read and keep mixed versions in the envelope.**
  Rejected: mixed entry versions would make the declared pairs ambiguous and invite
  the exact precedence ambiguity decision 6 exists to remove.
- **Map `unknown-root` to `external`, or `ambiguous` to `unresolved-relative`.**
  Rejected: both assert a conclusion the snapshot does not support.
- **Record `implicitPaths`/`itemCandidates` as edges.** Rejected: the architecture
  layer would turn conditional candidates into confirmed dependencies.
- **Make Python `VB001` an error like TypeScript.** Rejected: tree-sitter's recovery
  means an `ERROR` node is evidence about our reading, not about the project.
- **Wall-clock-only cancellation.** Rejected as the primary mechanism: nondeterministic
  results for identical input. Kept only as a possible documented safety valve.

## Security considerations

- **No project code is executed.** Parsing is a pure function of bytes. There is no
  Python interpreter, no `pip`, no `site-packages` access, no import hooks and no
  `child_process`. The resolver reads a set of paths, not a filesystem.
- **Untrusted input reaches a WebAssembly parser.** The attack surface is a WASM
  module processing bytes: malformed input, deeply nested expressions, pathological
  repetition and very large tokens. The mitigations decided here are input bounds
  before parsing, an ABI/name assertion, and a deterministic cancellation budget after
  which the parse is abandoned. What is *not* mitigated: the parser runs in-process
  with the CLI's memory, so a WASM bug or an adversarial input can still consume CPU
  or memory until the process is killed by the OS. No sandbox is introduced, and none
  is claimed.
- **Grammar and runtime bytes are pinned and verified offline.** Substituting either
  WASM file is detected before it is loaded (SHA-256 of both assets). This protects
  against corrupted downloads and accidental version skew, not against an attacker who
  can modify the installed package and its expected hash.
- **Encoding handling is a parsing decision, not a trust decision.** A cookie cannot
  make VOLDBASE read outside the snapshot, change a path or execute anything; the
  worst outcome is a file that is recorded but not extracted, with a conditional
  diagnostic and no structure claimed for it.
- **The digest is not authentication.** Stated in decision 7. A local actor able to
  rewrite `analyses.json` can forge a self-consistent record; value validation (settings
  counters, duplicate ids, vocabularies, path invariants) removes the cheap forgeries
  that previously slipped through, and nothing more is claimed.
- **Licensing and provenance.** Both packages are MIT. The vendored grammar keeps the
  upstream copyright and permission notice next to the asset and in `NOTICE`; MIT
  permits redistribution of the binary, and the repository's own source-available
  licence (ADR-0020) does not relicense the vendored file. Provenance (upstream commit,
  tag, generating command, hash) is recorded so the asset can be rebuilt and compared.
- **No new network, telemetry or credential surface.** The parser loads local bytes and
  returns a tree.

## Compatibility and migration strategy (conditional)

Everything in this section is conditional on the unified schema-evolution decision
assigning a version (decision 5); the version numbers are placeholders.

**Reading.**

- Envelope v1: the (v1, v1) pair is declared and supported; validated with frozen v1
  rules and the v1 digest verified. Once a new version is assigned, the v1 record is
  transformed in memory to that version. Reading never writes.
- The envelope version the unified decision pairs with the assigned entry version —
  which may be a different number — is declared as a pair once it exists, and its
  entries are validated with that pair's rules and its digest verified.
- Any pair the matrix does not declare — including an envelope/entry combination whose
  two numbers differ that the unified decision has not declared — is rejected per
  decision 6, before any validation or digest work: undeclared pairs are
  `analysis_corrupted`, and a declared pair this build cannot validate is
  `analysis_unsupported_schema`.
- Envelope newer than the build: `storage_unsupported_schema` with an upgrade message.
  This is what an older VOLDBASE says when it meets a file at a newer schema version,
  and it is correct — the alternative (trying to read it) would be guessing. The
  envelope version is checked first (decision 5 step 1), so an unsupported envelope
  never surfaces an entry-version error such as `analysis_corrupted`.
- Envelope older than any path this build has: `storage_unsupported_schema`
  ("no migration path"), also at step 1.
- Structural damage anywhere: `analysis_corrupted`, file left byte-for-byte as found.

**Writing.** New and migrated records are written under the declared pair's envelope
version (which may differ from the entry version) with entries at the assigned entry
version, by `#writeToDisk` under the exclusive lock, atomically (temporary file +
rename). A failed migration never writes; a successful read followed by an
unrelated save persists the migrated document. There is no down-migration: a file at
the new version is not readable by a v1 build, which is why the error must be a clear
upgrade instruction and never a corruption claim.

**Digest continuity.** A migrated record's new digest differs from its v1 digest by
design. The v1 digest is preserved only as the verification input at step 6; it is not
retained in the migrated record as a second digest, because two digests over the same
content invite the question of which one is authoritative. If provenance of the
migration itself is later required, it needs a field outside the hashed content and
its own decision.

**Compatibility with the rest of the product.** Import, storage and architecture
behaviour is unchanged. The architecture layer reads `resolved-relative` edges only;
`unresolved-root` and `ambiguous` produce no edge, which is the same treatment
unresolved imports already receive. JavaScript/TypeScript analyses keep their
vocabulary, their analysis behaviour and their CLI output, and v1 verification keeps its
frozen canonicalisation and digest rules (`normalizeAnalysisContentV1`). Their stored
digests do change when a v1 record is migrated: `schemaVersion` is part of the hashed
content, so the migrated record carries a new digest (step 9). That one-time
change applies to every migrated record, not only to JavaScript/TypeScript ones.

**Deployment order.** The new entry version, its declared envelope version and the
migration between them land **before** the Python front end is enabled, so that no
build can write a Python record it cannot read. Enabling `.py` without the migration would produce records that a v1 build
rejects as corrupt — the failure this ordering prevents.

## Testing and verification requirements

These are the regression tests the change must ship with; expected results are exact,
and each protects a named code path. None of them exists today. Tests that name a new
schema version (D4, D7–D9, D11–D13, D19) are conditional on the unified decision
assigning one; their version numbers are placeholders.

| # | Test | Expected | Protected path |
| --- | --- | --- | --- |
| D1 | Inject a `summary` object with wrong counts into a stored v1 entry, digest untouched | Loads; `summary` is the recomputed one; the key is absent after the next save | `storedToAnalysis`, `analysisToStored`, `summarizeAnalysis` |
| D2 | Alter a finding message in a v1 entry, keep the digest | `analysis_corrupted` | frozen v1 validation + v1 digest check |
| D3 | Alter a finding message **and** recompute the v1 digest | Accepted (documents the non-authenticating boundary) | decision 7 |
| D4 | Set an unknown `resolution` value with a recomputed digest | `analysis_corrupted` | v1 and next-version vocabularies |
| D5 | `settings: { maxFiles: "lots", maxTotalBytes: -1, … }` with a recomputed digest | `analysis_corrupted` (today: accepted) | settings validation |
| D6 | Two entries with the same `analysisId`, both otherwise valid | `analysis_corrupted` naming the id and both positions (today: last wins silently) | duplicate detection before the `Map` |
| D7 | Envelope at the assigned envelope version, entries at the assigned entry version — the pair the matrix declares — valid | Loads with no migration and no write | new-version path |
| D8 | Envelope at the assigned envelope version, one entry at a version the matrix does not pair with it (for example `schemaVersion: 1` when that pair is not declared) | `analysis_corrupted` (the pair is undeclared) | decision 6 row 5 |
| D9 | Envelope `schemaVersion: 99` | `storage_unsupported_schema` | envelope check |
| D10 | Envelope missing, `null`, `"1"`, `1.5` | `analysis_corrupted` | `detectVersion` policy |
| D11 | Envelope v1 document, all entries valid v1 | Transformed in memory to the new version; ids, timestamps and file content preserved; its digest differs from the v1 digest; save is not rejected as `analysis_immutable`; the file is unchanged until a save | steps 1–9 |
| D12 | Envelope v1 entry with `language: 'python'` and a valid-looking v1 digest | `analysis_corrupted` (v1 vocabulary is frozen) | `ANALYSIS_LANGUAGES_V1` |
| D13 | v1 entry whose recorded digest was computed over a **non-canonical input** (for example extensions hashed unsorted, or an extra key folded into the hash), so the digest cannot be reproduced from the canonical form | `analysis_corrupted` — the digest is over canonical JSON and is not recomputed under a looser rule | frozen v1 normaliser + `analysisContentDigest` |
| D14 | A `.py` file declaring `# coding: cp1251` (outside the allowlist) whose ASCII body contains a `def` and an `import pkg.mod`; a second file with a UTF-8 BOM plus `# coding: latin-1` | Both recorded (path, size, digest) with **zero** declarations and **zero** imports, one `VB006` `warning`/`conditional` finding each, and no `ImportEdge` at all | encoding gate before extraction (decision 4) |
| D15 | A `.py` file whose tree contains an `ERROR`/`MISSING` node while other lines are valid, including a resolvable `from pkg import mod` | Zero declarations and zero imports for that file; one `VB001` `warning`/`conditional` finding; no `resolved-relative` edge, therefore no architecture edge | partial-tree policy (decision 10) |
| D16 | A save that would persist a migrated document, with the temporary-file write forced to fail | `storage_write_failed`; the document on disk byte-identical to before; `listByProject` still returns the pre-save analyses; no `.tmp` left (or, if cleanup fails too, only a `.tmp`); a later save succeeds | `#writeToDisk` + `save` ordering (decision 9) |
| D17 | The same save with **rename** forced to fail | `storage_write_failed`; disk unchanged; in-memory map unchanged (record not added); a following successful save writes the complete document once, with no duplicate and no lost record | decision 9 |
| D18 | `fromPath: app.py`, paths `src/myapp/__init__.py`, `src/myapp/core.py`, import `myapp.core` | Resolver status `unknown-root` → domain `unresolved-root`; no `resolvedPath`; no architecture edge. A genuinely absent name (`requests`) stays `external`; neither becomes `unresolved-relative` | resolver → domain mapping (decision 8) |
| D19 | A valid v1 entry whose stored `files`/`declarations`/`imports`/`findings`/`supportedExtensions` arrays are permuted, digest left as recorded | The **original recorded v1 digest still verifies** — the frozen v1 normaliser sorts those arrays before hashing, so a permitted permutation is not a content change and preserves the original v1 digest. Migration then computes a **newly computed digest for the new version**, because `schemaVersion` is hashed and changes. The v1 and new digests are never expected to be equal and are never compared with each other: the v1 digest is only the pre-transform check, the new digest is the current record's digest. Re-saving writes the same document as saving the already-ordered record, that is, the ordered form plus its new-version digest | frozen v1 normaliser (permitted reordering) |
| D20 | Cancel a parse of a fixed, checked-in Python fixture using a deliberately small, explicit step budget (not the production proposal) chosen so the fixture demonstrably reaches it under the pinned runtime; the fixture and its expected callback count are recorded. The callback asserts every invocation and returns literal `true` when the configured threshold is reached; then call `reset()`, parse a second file and re-parse the first | The callback count reaches the configured threshold (the test asserts the counter equals the budget at cancellation); `parse` returns `null` at budget exhaustion; the run reports `analysis_limit_exceeded`; **no `VB001`** and no partial analysis result are produced; the parses after `reset()` each match a fresh parser's tree (same structure, no `ERROR` attributable to the aborted parse), proving the next parse is independent. This tests budget exhaustion only; it is not a hard timeout and not a CPU-time guarantee | cancellation + `reset()` (decisions 3, 10.2) |
| D21 | Parser/environment failures kept distinct: (a) grammar loading — invalid grammar WASM and a missing grammar file; (b) ABI incompatibility — a genuinely rebuilt incompatible grammar artifact (a patched version field may document the runtime guard but is not sufficient proof); (c) runtime initialization — missing and invalid runtime WASM rejected by `Parser.init`, with each scenario executed in a fresh Node.js process so cached `Parser.init()` state cannot hide the failure; (d) runtime parse failure — a `parse` call that throws. Add repository-level integration coverage that drives parser initialization and runtime parse failures through the analysis runner and repository boundary | `analysis_parser_failure` in every case; **no `VB001`**; no tree is used and no partial analysis result is produced; no analysis record is persisted for the failed run. Grammar loading, ABI incompatibility, runtime initialization and runtime parse failures remain distinct triggers: initialization cases are testable before any file is parsed, runtime parse failures during a parse | parser initialization, language loading, the parse call and the persistence boundary (decision 10.3) |
| D22 | A checked-in v1 fixture (specified below) canonicalised by the frozen v1 normaliser; the expected digest `36c3084b405194a16122df4c6d84a01a7d57740e684cfb2b4b2dd6d5b68c0028` is stored as a literal in the test source | The normaliser reproduces the literal exactly, with no ordering, escaping or key-order drift; the expected value is never computed from the implementation under test at run time and never regenerated dynamically | frozen v1 normaliser (`normalizeAnalysisContentV1`) + v1 canonical JSON ordering |

D13 and D19 are complementary on purpose: reordering of the arrays the canonical form
sorts is permitted and must not change the digest (D19), while a digest computed over a
different canonical layout is a mismatch (D13). Neither test changes the frozen v1
rules, and D16/D17 require a failure-injection seam that the repository does not have
today (see Open questions).

**D22 fixture and the source of its digest.** The fixture is one v1 `AnalysisContent`:
`schemaVersion: 1`, `analyzerVersion: "1.0.0"`, `projectId: "prj_frozen_v1"`,
`projectRevision` a 40-character `c` hex string; settings
`{ supportedExtensions: ["ts", "js"], maxFiles: 3, maxTotalBytes: 4096,
maxFileBytes: 2048, maxSourceFiles: 2 }` with the extension list deliberately unsorted;
two `typescript` files supplied in reverse path order — `src/b.ts` (size 12, digest
`"b"` × 64, one `static` import of `./a` at 3:1 with `typeOnly: false`, resolving to
`src/a.ts`) and `src/a.ts` (size 5, digest `"a"` × 64, no declarations or imports).
`src/b.ts` declares, in the original input order, `function zeta` at 2:1 with
`exported: true` first, then `class Alpha` at 1:1 with `exported: false`; normalisation
orders them `class Alpha` (1:1) followed by `function zeta` (2:1). Two findings come
in reverse rule order, both `warning`/`conditional` on `src/b.ts`: `VB002` at 3:1 with
message `Import specifier could not be read statically.` and evidence `./a`, then
`VB001` with no location, message
`File contains a syntax node the parser could not interpret.` and evidence `ERROR`.

Its expected digest, **`36c3084b405194a16122df4c6d84a01a7d57740e684cfb2b4b2dd6d5b68c0028`**,
was captured from the original v1 implementation — not from the frozen copy, which does
not exist yet, and not from any code implementing a later schema version:
`analysisContentDigest` over the normalised fixture in `src/domain/analysis.ts`
(`ANALYSIS_SCHEMA_VERSION = 1`, blob
`a4efe2e6f0f387893bfcfd640fff3438488991e3`) as merged on `main` at
`bed3f52a136d4b46d0361b3eee4c8cc2b3f21f3a`. The value was produced identically in
three independent processes, so the literal is reproducible from the fixture
description. The fixture and the literal **must be checked in as data when D22 is
implemented**; as of this ADR they are not yet in the repository. The test may not
derive the expected value from `normalizeAnalysisContentV1` or from any code
implementing a later schema version.

Additional verification required before activation (not migration tests): parser probe
on Node 22.18.0 exactly; grammar and runtime hash mismatch → `analysis_parser_failure`;
language name assertion; an incompatible `abiVersion` from a genuinely rebuilt grammar
artifact throwing at `setLanguage` rather than producing a tree (D21), with a
memory-patched version field used only to demonstrate the runtime guard; `Parser.init`
failure with missing and invalid runtime WASM; a runtime parse exception; cancellation
returning literal `true` → `null` →
`analysis_limit_exceeded`, and a clean tree after `reset()`; `undefined`/`false`/string
returns not cancelling; cookies on line 1, line 2 after a comment, line 2 after code
(ignored), inside a string (ignored), `# CODING:` (ignored); BOM + UTF-8 cookie, BOM +
conflicting cookie, declared `utf-16` in ASCII bytes, UTF-16LE bytes with BOM (noting
that most such files are refused by the runner's NUL rule before the Python decoder
runs); `unknown-root` → `unresolved-root` with no edge and no `resolvedPath`;
`ambiguous` → `ambiguous`; `implicitPaths`/`itemCandidates` never becoming edges; and
the JavaScript/TypeScript digest freeze
(`b155ad91a377dd900e17e6e50eabdcf598599efee76f67239ba70901aa970376`) still passing.

## Consequences

- Recording Python analyses requires a new analysis record version, and an envelope
  whose declared compatibility matrix accepts it — the two numbers need not be equal.
  A v1 build meeting such a file fails with `storage_unsupported_schema` and must be
  upgraded. Which numbers those are, and which pair is declared, remain deferred
  (decision 5). That is a visible, one-directional floor on supported
  versions.
- Every existing analysis is migrated in memory on first read and rewritten on the next
  save once the unified decision assigns a version and the migration is implemented.
  Ids, project revisions, files, findings and timestamps are preserved; digests change
  once, by design.
- The analysis document gains a stricter read path: settings counters are validated,
  duplicate ids are refused, and unknown entry versions stop being reported as
  corruption. A previously "readable" hand-edited file may now be refused; that is the
  intended direction.
- Python adds a second parser generation to the recorded `analyzerVersion`. A change in
  grammar or runtime version changes what is extracted, which is why the version is part
  of the snapshot and its digest.
- The vendored grammar becomes a maintained asset: upstream upgrades are a reviewed
  change with a new hash, a new provenance entry and a re-run of the parser tests.
- WASM parsing is slower than the TypeScript compiler path and allocates outside the
  heap VOLDBASE controls; large Python projects pay that cost, bounded only by the
  existing input limits and the proposed step budget.
- Python findings are deliberately weaker claims than TypeScript's: `VB001` is a
  warning with `conditional` certainty, so a Python file with a parse problem cannot be
  read as "this project is broken".
- `unresolved-root` and `ambiguous` appear in the stored vocabulary and in JSON output,
  so downstream consumers (architecture, future reports) must treat them as
  "no edge", not as errors.
- A file whose declared encoding is unsupported or contradictory is recorded but not
  extracted: it contributes a conditional `VB006` finding and no declarations or
  imports. A file containing a NUL byte is not in this category: the shared runner
  rejects it with `analysis_unsupported_source` before the Python decoder runs, and it
  is never recorded as an unsupported-encoding file. Reports must read that finding,
  because the empty lists alone do not mean "empty module".
- A file whose tree contains `ERROR`/`MISSING` nodes loses all of its declarations and
  imports, not just the affected region. That is a deliberate trade of recall for the
  guarantee that partial parsing cannot fabricate a dependency.

## Open questions

**Established by experiment (not assumptions).**

- `web-tree-sitter@0.27.2` loads the vendored Python grammar (ABI 15, minimum compatible
  13) and parses Python on **Node 26.13.1**; `Parser.init` ≈ 10 ms; 274 node types.
- Cancellation requires the progress callback to return literal `true` (then `parse`
  returns `null`); `undefined`, `false` and strings do not cancel; `reset()` after a
  cancelled parse yields a clean tree; `currentOffset` is UTF-16LE bytes
  (`2 × (length − 1)` maximum observed).
- The stored record has no `summary`; an injected one is inert and dropped on write.
- A stored semantic alteration with a recomputed digest is accepted; unknown
  resolutions and invalid settings were the reachable false-acceptance cases.
- CPython 3.12.3 cookie behaviour: line 1 always; line 2 only after a blank or comment
  line; `# CODING:` is not a cookie; a cookie inside a string literal is not a cookie; a
  BOM with a non-UTF-8 cookie is a `SyntaxError`.
- Parser failure modes (Node 26.13.1): malformed grammar bytes and a missing grammar
  path throw from `Language.load`; missing or invalid runtime bytes reject
  `Parser.init`; an ABI version outside 13–15 throws from `setLanguage` (probed by
  patching the loaded version field; a genuinely incompatible grammar artifact remains
  untested); a deleted parser throws `RuntimeError` from `parse`; none returns a tree.
  A 12-character input invoked no progress callback, so no callback-count budget could
  cancel it.
- Package metadata: both packages MIT; `web-tree-sitter@0.27.2` declares no `engines`
  and has `type: module`.

**Requires implementation-time verification (do not treat as settled).**

- Which version numbers the unified schema-evolution decision assigns to the analysis
  schema and to the storage envelope, which compatibility pairs it declares (including
  any pair whose two numbers differ), and how it schedules the recorded-format changes
  in decision 5's scope.
- Whether the parser and grammar actually work on **Node 22.18.0** exactly — never
  exercised; CI floats `22.x`. A pinned job is required before activation.
- The correct step-budget value: 250,000 callbacks per file is a proposal, not a
  measurement of acceptable latency or of worst-case adversarial input.
- Worst-case parse time and memory for hostile Python input, including deeply nested
  expressions, on the minimum supported Node version. No hard bound is claimed.
- Whether node 22's WebAssembly feature set accepts the same ABI 15 module without
  flags.
- The exact codec allowlist implementation: WHATWG label aliasing
  (`iso-8859-1` → windows-1252) must be resolved before `cp1252` and `iso-8859-1` can
  both be supported; non-ASCII bytes before the cookie keyword need a test.
- How a future version should represent a file that was deliberately not extracted
  from (unsupported encoding, partially recovered tree). Today the only carrier is a
  finding plus empty lists; a per-file status field would be a schema change of its
  own. Cancellation is not part of this question: it aborts the run with `analysis_limit_exceeded` and
  produces no persisted per-file record.
- Whether the whole-file loss on partial trees is acceptable in practice, or whether
  per-subtree extraction with an explicit certainty marker on `ImportEdge` is worth a
  later schema version.
- The failure-injection seam needed for D16/D17: the repository has no hook for
  injected filesystem failures today, so adding one is an implementation decision, not
  something this ADR can assume.
- Read freshness under concurrent writers: `#load()` never re-reads once it holds a map,
  so another process's write is invisible to an already-loaded repository instance.
  Whether that matters for the CLI (one process per command) or needs invalidation is
  undecided; nothing here claims reads are fresh.
- Whether `VB001` as `warning`/`conditional` is the right presentation for Python, or
  whether parse problems need a dedicated rule id. This needs a corpus of real files,
  not intuition.
- Whether `VB005`/`VB006` are the right rule ids and whether `ambiguous` needs its own
  finding in some contexts.
- How the Python extractor should set `Declaration.exported`: the working decision is
  `false` for every Python declaration (the language has no export modifier, and
  `__all__`/star-import rules are runtime facts), but a `visibility` field may be a
  better answer and would be a later schema decision.
- Whether `implicitPaths`/`itemCandidates` ever belong in the snapshot, and with what
  edge semantics — deliberately out of scope for a new version.
- Whether a future storage version should ever permit mixed entry versions (currently:
  no), and what would justify it.
- The removal path if `web-tree-sitter` is abandoned: it is reachable — the resolver,
  front end and schema are ours; only the WASM binding would need replacing — but no
  alternative binding has been evaluated.
- Whether a wall-clock safety valve is worth its nondeterminism, and if so, where it is
  recorded.
