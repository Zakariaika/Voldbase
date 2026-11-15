# 0010 — Build and distribution for the CLI

- Status: Accepted
- Date: 2026-11-15

## Context

ADR-0002 deferred a distribution build to Phase 1, when a CLI has to be
installable. The sources use explicit `.ts` import specifiers with
`allowImportingTsExtensions`, which Node's type stripping handles but which is not
a distributable artifact: it depends on the consumer's Node version and flags, and
`tsc` normally refuses to emit when `.ts` specifiers are imported.

TypeScript 5.9 provides `rewriteRelativeImportExtensions`, which rewrites
`./module.ts` to `./module.js` in the emitted JavaScript. That is exactly the
missing piece between the existing convention and a plain `tsc` build.

## Decision

1. **Build with the existing TypeScript compiler.** `tsc -p tsconfig.build.json`
   emits ES modules to `dist/`, with `rewriteRelativeImportExtensions: true`.
   No bundler, no transpiler, no new dependency (ADR-0007).
2. **`bin/voldbase.js` is the npm entry point.** It is plain ESM JavaScript, imports
   `../dist/cli/main.js`, assigns `process.exitCode`, and never imports sources.
3. **Tests keep running against sources** (`node --test tests/*.test.ts`). The
   build is verified separately by `tests/dist-cli.test.ts`, which spawns the bin
   entry, so the emitted JavaScript and the rewrite step are exercised for real.
4. **`npm run check` = typecheck → build → test.** CI runs the same sequence, so
   the distribution test cannot pass trivially by skipping.
5. **Only `src/` is compiled.** Tests, docs and the bin script are not emitted.
   The published `files` allowlist is `bin/`, `dist/`, `README.md`, `LICENSE`;
   sources and tests stay out of the package.
6. **No declarations, no source maps** in Phase 1: there is no library consumer
   yet, and source maps would ship more surface than they help.

## Consequences

- `dist/` mirrors `src/` as a tree of ES modules rather than one bundled file. For
  a CLI of this size startup cost is negligible; a bundler can be added later
  without changing source conventions.
- The build requires TypeScript ≥ 5.7 for `rewriteRelativeImportExtensions`;
  `package.json` pins `typescript@^5.9`.
- `.ts` specifiers remain in source, so `tsc --noEmit` and `node --test` stay the
  fast inner loop while the shipped artifact is real JavaScript.
- `engines.node = ">=22.18.0"` still applies to the artifact, which uses only
  standard-library APIs available on 22.18+.
- The CI gate now includes a build step. This ADR extends the gate described in
  ADR-0008 rather than superseding it.

## Alternatives considered

- **Node type stripping in production.** Rejected: it is a development
  convenience, not a distribution format, and its behavior differs across the
  supported Node versions.
- **tsc plus a path-rewriting post-processing script.** Rejected: fragile regex
  edits over emitted files when the compiler itself now supports the rewrite.
- **esbuild / tsup / rollup.** Rejected for Phase 1: a new build dependency and an
  ADR of its own, for a benefit (single-file bundle) nobody needs yet.
