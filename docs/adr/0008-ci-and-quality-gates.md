# 0008 — CI and quality gates

- Status: Accepted
- Date: 2026-11-15

## Context

The repository had no automation, no protection on `main`, and Dependabot
security updates disabled. Before code volume grows, the merge gate must exist so
that regressions are caught by a machine rather than by production.

## Decision

1. **`main` is never pushed to directly.** All work lands via pull request.
2. **Required gate** (`.github/workflows/ci.yml`), on every PR and on pushes to
   `main`:
   - `npm ci` (frozen lockfile),
   - `npm run typecheck`,
   - `npm test`,
   on Node 22, 24 and 26.
3. **CI runs with `permissions: contents: read`** — least privilege by default.
4. **Concurrency cancels superseded runs** on the same ref, to keep feedback fast.
5. **Adding a linter, formatter gate, coverage threshold or SAST tool requires an
   ADR**, because each one is a new dependency or a new blocking rule.
6. **No skipped tests and no suppressions to make CI green.** A failing check is
   a finding, not an obstacle.

## Consequences

- Contributors pay for one round trip of CI per push; in exchange `main` is
  always type-clean and test-clean.
- The matrix triples wall-clock usage but catches Node-version-specific breakage,
  which matters for a local-first tool.
- Branch protection must be enabled in repository settings to make the gate
  actually blocking; CI alone does not prevent a direct push.

## Alternatives considered

- **Single Node version.** Rejected: users run LTS and current releases.
- **Pre-commit hooks only.** Rejected: unenforceable across contributors and
  easily bypassed.
- **Full GitHub Actions matrix with OS coverage.** Deferred to Phase 1, when
  filesystem and process behavior actually differ across platforms.
