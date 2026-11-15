# 0005 — Execution isolation and the no-execution rule

- Status: Accepted
- Date: 2026-11-15

## Context

VOLDBASE's value depends on executing code that it did not write, taken from
repositories it does not control. That is the highest-risk capability in the
product: an experiment is, by definition, running arbitrary code from an
untrusted source. A naive implementation — `child_process.exec()` against a
project's own scripts — grants full access to the user's home directory,
credentials, SSH keys and network.

Phase 0 has no execution backend. This ADR exists so that one cannot be added
casually, and so the constraint is visible to every future contributor.

## Decision

**Phase 0 ships no executor.** `Executor` exists only as a port
(`src/application/ports.ts`) with no implementation in `src/infrastructure`.

Any future execution backend must satisfy all of the following before it can be
merged:

1. **Isolation boundary.** Execution occurs inside a container or VM, never as a
   child process of the host agent. The host filesystem is not mounted; the
   project is copied into a workspace with an explicit, minimal mount set.
2. **Deny-by-default network.** Networking is off unless the experiment declares
   it, and the declaration is recorded in the run's environment manifest.
3. **Resource limits.** CPU, memory, wall-clock time, disk and process count are
   bounded and recorded with the run. A run that exceeds a limit ends `BLOCKED`
   or `FAIL` with a reason, never silently.
4. **No secret inheritance.** The environment is constructed from an allowlist.
   Host environment variables, tokens and credential files are never forwarded.
5. **Immutable, content-addressed images.** The runner image is pinned by digest;
   the digest is part of the run record. `latest` is not acceptable.
6. **Deterministic inputs.** The project revision, dependency lockfile digest and
   experiment definition hash are captured *before* execution starts.
7. **Full capture.** stdout, stderr, exit status and produced artifacts are
   recorded with hashes, so a verdict can be audited later.
8. **Explicit user consent.** The first execution against a project requires an
   affirmative confirmation that names what will run.
9. **Kill switch and cleanup.** Every run is terminable and leaves no container,
   process, or temporary volume behind.

Until 1–7 are implemented and tested, the answer to "can VOLDBASE run my tests?"
is: not yet.

## Consequences

- Phase 0 and Phase 1 deliver analysis and metadata only. Value is delayed, but
  the alternative is shipping a remote-code-execution hazard with a friendly UI.
- Runner choice (container runtime, rootless mode, microVM) is deliberately not
  decided here; it becomes its own ADR with benchmark evidence.
- The `Executor` port's shape may change once real isolation exists. That is
  acceptable: a wrong abstraction implemented is worse than a port that moves.

## Alternatives considered

- **Direct `child_process` execution.** Rejected: unacceptable risk, unrecordable
  environment, no reproduction guarantees.
- **Trusting the project's own test command.** Rejected: the project's scripts are
  themselves untrusted input.
- **Deferring isolation to "later".** Rejected: it would leak into every call path
  and be retrofitted at the worst possible time.
