# 0007 — Dependency policy

- Status: Accepted
- Date: 2026-11-15

## Context

VOLDBASE runs on developers' machines and will eventually handle untrusted
projects. Every runtime dependency is code that users install and execute, and
every dependency is a supply-chain and maintenance liability. The current
foundation has zero runtime dependencies.

## Decision

1. **Zero runtime dependencies in `src/domain`.** Adding one requires a
   superseding ADR.
2. **Any new runtime dependency requires an ADR** that states: what it does, why
   the standard library is insufficient, its license, maintenance status, and how
   it will be removed if abandoned.
3. **Dev dependencies are cheap but not free.** Tooling stays minimal: today only
   `typescript` and `@types/node`.
4. **No frameworks in the core.** A web framework may be added in the layer that
   actually serves HTTP, never in domain or application code.
5. **Exact, committed lockfile.** `npm ci` in CI; upgrades arrive as reviewed PRs.
6. **Prefer standard library.** `node:crypto`, `node:test`, `node:util` cover the
   Phase 0–1 needs.

## Consequences

- Some utilities are written in-house (canonical JSON, id creation). They are
  small, tested, and fully visible in review.
- Occasional reinvention of a wheel; accepted in exchange for auditability.
- If the ecosystem need becomes real (e.g. a validated CLI argument parser),
  adding it is a one-page decision, not a debate.

## Alternatives considered

- **Curated-but-loose policy.** Rejected: "looks maintained" is not a criterion.
- **Vendoring a utility library.** Rejected: copying transitive code without
  upstream patching is worse than either depending or writing it.
