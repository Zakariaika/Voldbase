# 0001 — Product scope and result taxonomy

- Status: Accepted
- Date: 2026-11-15

## Context

VOLDBASE is described as a "Universal Experiment & Verification Infrastructure
for software and AI projects". "Universal" is a direction, not a specification.
Products that start from a universal abstraction tend to ship a flexible nothing:
a plugin system, a generic entity model, and no usable workflow.

Verification products also fail in a specific way: they report success when
nothing was actually executed. A tool that cannot say "not tested" is worse than
no tool, because it produces false confidence.

## Decision

1. **Initial scope is software and AI repositories only.** Support for other
   domains is added only when at least two concrete use cases demonstrate that
   the model generalizes. No marketing or API surface may claim universality
   before that.
2. **Every verification outcome is classified as exactly one of** `PASS`,
   `FAIL`, `INCONCLUSIVE`, `NOT_TESTED`, `BLOCKED`. The taxonomy is a closed set
   in the domain layer (`src/domain/result.ts`), not a free-form string.
3. **`PASS` and `FAIL` require evidence.** A run cannot claim either without at
   least one evidence reference. The domain layer enforces this.
4. **Absence of execution is reported, never inferred.** If no run exists for an
   experiment, the report says `NOT_TESTED`.
5. **V0.1 is local-first and open source (MIT).**

## Consequences

- Reporting, storage and UI must all carry the five-state taxonomy; there is no
  "unknown" escape hatch to design around later.
- Some legitimate real-world outcomes (e.g. flaky behavior) must be modeled as
  `INCONCLUSIVE` with notes rather than as a new status. Adding a sixth status
  requires a superseding ADR.
- The claim "universal" stays out of the product copy until Phase 5 criteria are
  met.

## Alternatives considered

- **Open-ended status strings.** Rejected: untyped, unaggregatable, and invites
  silent success.
- **Two-state pass/fail.** Rejected: forces a false verdict when the environment
  is at fault (`BLOCKED`) or nothing ran (`NOT_TESTED`).
- **Design for all domains up front.** Rejected: unvalidated generality that
  costs velocity and clarity.
