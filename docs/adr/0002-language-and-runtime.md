# 0002 — Language, runtime and toolchain

- Status: Accepted
- Date: 2026-11-15

## Context

VOLDBASE must inspect repositories, parse manifests, orchestrate processes,
record evidence, and eventually serve a web UI. The same types must be shared by
a local CLI, a local server, and a future hosted API. Contributors must be able
to clone and run it without a heavy toolchain, and the security surface of the
core must stay small.

## Decision

1. **TypeScript**, ESM only, targeting Node.js.
2. **One language across CLI, server, and future web client** so domain types are
   shared without code generation.
3. **No build step in Phase 0.** Sources run directly through Node's built-in
   type stripping; `tsc --noEmit` is the type gate. This requires:
   - `"erasableSyntaxOnly": true` — no enums, namespaces, or parameter
     properties, so the source is always valid strippable TypeScript.
   - `"allowImportingTsExtensions": true` with explicit `.ts` import specifiers.
   A distribution build (bundled CLI entry point) arrives in Phase 1.
4. **Node >= 22.18**, tested on 22, 24 and 26 in CI.
5. **`node --test`** as the test runner. No test framework dependency.
6. Domain code must not depend on any Node API beyond `node:crypto` for pure
   hashing; all I/O goes through ports.

## Consequences

- Contributors need only Node and npm. `npm ci && npm test` is the whole setup.
- Enums are unavailable. Discriminated string unions are used instead, which is
  better for JSON persistence and API contracts anyway.
- Because there is no emit step yet, there is no distributable artifact. Packing
  and publishing are Phase 1 work and will need a build ADR.
- Node-only: a browser bundle of the domain layer would need a bundler later. The
  domain layer is deliberately dependency-free so that remains possible.

## Alternatives considered

- **Python.** Rejected for the core: the orchestration and UI surfaces would then
  need a second language and a type bridge; the AI-ecosystem advantage applies to
  users' *projects*, which VOLDBASE executes as opaque processes, not to
  VOLDBASE's own code.
- **Bun/Deno runtime.** Rejected: narrower deployment compatibility for a
  local-first tool that must run on contributors' varied machines.
- **Go.** Rejected: excellent distribution story, but slower iteration on the
  web/UI surface that V0.1+ needs.
