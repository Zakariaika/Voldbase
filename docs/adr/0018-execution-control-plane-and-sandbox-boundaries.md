# 0018 — Execution control plane and sandbox boundaries

- Status: Proposed (specification accepted for review; implementation is Phase 3C, after the Phase 3B runtime decision)
- Date: 2026-11-17
- Refines: [0005](0005-execution-isolation.md)
- Detailed in: [Execution safety specification v1](../security/execution-safety-specification-v1.md)

## Context

[ADR-0005](0005-execution-isolation.md) established the no-execution rule: VOLDBASE
does not run project code, and any future executor needs nine mandatory
preconditions before it may. Phase 2 did not change that; Phase 3A is the point at
which those preconditions need to become a *testable contract* rather than a list.

The pressure to run something is real — a verification platform that never executes
cannot produce `PASS` — but so is the failure mode: an executor is the one component
where a mistake means arbitrary code running on a user's machine with their keys,
their files and their network. The decisions below are the ones that are expensive
to reverse once code exists, because they are structural:

1. **Who holds authority?** If the thing running untrusted code can also decide the
   verdict, the system's answer is written by the adversary.
2. **Where does isolation live?** A "run it locally, and isolate when available"
   design has two code paths; the second one is always the one that ships.
3. **What is a fresh environment?** Reuse is an optimisation that quietly turns one
   run's leftovers into the next run's inputs.
4. **What is evidence?** If the program's own output is treated as the result, the
   program can declare victory.
5. **Which runtime?** Containers and microVMs are different threat models, and
   choosing by familiarity would be an unexamined decision.

## Decision

**1. Six components, with authority flowing one way.**

Control Plane (policy) → Provisioner/Supervisor (create/observe/destroy) → Isolated
Execution Environment (untrusted) → Evidence Collector (hash and store, outside) →
Independent Verdict Engine → Append-only Run Ledger. The environment holds authority
over **nothing**: it cannot create or destroy environments, write evidence, append to
the ledger, or influence the verdict other than by producing bytes. Every boundary
from the environment inward is a byte parser, not a trust edge.

**2. There is no bypass path.**

No development, debug, `--unsafe` or "isolation unavailable, continuing" mode exists
in the design, and configuration is schema-validated with defaults that enable
nothing. A control that cannot be enforced is `BLOCKED`, not degraded: "we could not
measure it, so we ran anyway" is not a permitted state. Sandbox management goes
through a narrow, authenticated, run-scoped control interface, and the environment
never receives the host container-runtime socket or an equivalent privileged handle.

**3. Every run gets a new environment and an empty workspace.**

Reuse is forbidden, including after a *successful* run: leftovers are inputs, and an
input that was not in the manifest is not evidence. Cleanup is attempted on success,
failure, timeout, cancellation and supervisor failure; a cleanup failure marks the
run unsafe and quarantines the environment rather than returning it to a pool.

**4. Isolation requirements are technology-neutral; the runtime choice is deferred.**

The specification states requirements and acceptance tests, not a runtime. Containers
and microVMs are compared conceptually in §6 of the specification (boundary, escape
surface, startup cost, density, observability, network control, residual risk), and
the production runtime is a **separate ADR** that must carry measured evidence.
Nothing in Phase 3A presumes either family.

**5. Evidence is collected outside, and the verdict is computed outside.**

Evidence is hashed on receipt by a collector the environment cannot reach, bound to a
run id and the experiment definition digest, and stored outside the sandbox. The
verdict vocabulary is fixed (`PASS`/`FAIL`/`INCONCLUSIVE`/`BLOCKED`); `PASS` requires
every *predefined* mandatory condition to be satisfied by validated evidence; missing
or invalid evidence is never success; timeout and limit termination cap the verdict at
`FAIL`. A program printing `PASS` is producing evidence, not a verdict.

That `FAIL` is not overridden by short output, because integrity and completeness are
different judgements: bytes that do not exist because the supervisor killed the run
are authenticated incomplete output, while an unexplained missing artefact, a digest
or binding mismatch, or a ledger that does not verify is an integrity failure. Only
the latter blocks; a timeout with authentic truncation stays `FAIL`. Tampering, a
digest mismatch, an unexplained absent artefact and ledger-integrity failure are all
`BLOCKED`; `INCONCLUSIVE` is reserved for authentic, integrity-valid evidence that is
merely insufficient, with a clean lifecycle and a `completed`/`failed` termination.

**6. The ledger is append-only and its trust assumptions are stated.**

Events are chained and verified independently. A hash chain detects edits and
reordering by anyone who does not control the whole ledger, and detects truncation
only if the head is recorded elsewhere. It does **not** stop an administrator with
write access from recomputing every digest; that residual risk is documented rather
than papered over, and external head-witnessing is listed as planned, not present.

**7. Phase 3A adds documentation only.**

No executor, container, microVM, process launcher or sandbox code is introduced, no
runtime dependency is added, and no existing no-execution guarantee is weakened. The
specification says explicitly that VOLDBASE does not provide execution isolation
today, so no reader can mistake a requirement for a capability.

**8. Verdicts come from one ordered table, cleanup included, and lifecycle state is
recorded beside it.**

The verdict is selected by the fixed precedence in specification §9.1, and cleanup is
a row of that table rather than an exception applied to a verdict already chosen:
evidence **integrity** failure → `BLOCKED`; isolation or policy failure → `BLOCKED`;
execution never started (`cancelled` or `supervisor_error` before start) → `BLOCKED`;
demonstrable mandatory failure → `FAIL` (any termination reason, any lifecycle state);
`timeout` or `limit` termination with authentic truncation → `FAIL` (any lifecycle
state); `cancelled` after execution started → `BLOCKED`; `supervisor_error` after
execution started → `BLOCKED`; lifecycle `unsafe` with no established failure →
`BLOCKED`; authentic but insufficient evidence with a clean lifecycle →
`INCONCLUSIVE`; and only then `PASS`, which requires at least one predefined mandatory
condition, every declared condition satisfied, coverage `complete`, termination
`completed` or `failed`, and a `clean` lifecycle. `PASS` has no other door, and no
implementation may add a verdict, skip a row or resolve overlapping conditions ad hoc:
the first matching row decides.

`PASS` must also be non-vacuous: a definition whose mandatory-condition list is empty
or absent is invalid, is rejected before any environment exists, and blocks a verdict
if it reaches one, so "all zero conditions are satisfied" can never be a free `PASS`.

Two asymmetries are deliberate. A `supervisor_error` never yields `PASS` or
`INCONCLUSIVE`: the component that would have attested completeness is the one that
failed, so evidence that merely appears complete is not complete. And a `timeout` is
never softened: it is `FAIL` with authentic truncation, and only an integrity failure
moves it to `BLOCKED`.

Cleanup state itself is still recorded as `lifecycleState: clean|unsafe` beside the
verdict, with its reason (`cleanup_failed`, `cleanup_unverified`, `supervisor_lost`),
because the reader must see *why* a `BLOCKED` happened. Being a table row does not let
it erase a demonstrable `FAIL`: rows 4 and 5 outrank the unsafe row, so an unsafe
environment is no reason to hide a known failing condition, and it never upgrades one.
An unsafe run with complete evidence and no failure lands on the unsafe row and becomes
`BLOCKED` before `INCONCLUSIVE` or `PASS` can be reached.

**9. Toolchain identity is attested metadata, never a version printed in the sandbox.**

Anything a command inside the environment reports is an observation. Identity — image
digest, SBOM digest, component versions, provenance status, scanner and scanner-database
freshness — is resolved by the Control Plane from build metadata and signed provenance
bound to the pinned digest. Unavailable provenance, a mismatched SBOM or a stale scanner
database blocks the run before any environment is created. There is no "assume trusted"
path, and a program cannot improve its own provenance by claiming it.

**10. Cleanup is owned by an independent reconciler, and uncertainty means quarantine.**

Supervisors die, and a supervisor trusted to clean up after itself leaks exactly when it
fails. Cleanup decisions therefore belong to a reconciler in the Control Plane: run-owned
resources are labelled, rediscovered from labels and the ledger on termination, on
supervisor loss and on control-plane restart, and destroyed before any new run starts.
Destruction that cannot be verified quarantines the environment permanently for an
operator, and no environment is reused after uncertain cleanup. Cleanup state `unknown`
is normalised to `unsafe` before any verdict is computed, so uncertainty can never be
read as a clean environment.

**11. Phase order is binding.**

2C may model experiments and runs but must not execute project code. An executor may not
be implemented before 3A is accepted and 3B records a runtime decision; 3C implements the
controls in the specification. This restates ADR-0005 rather than relaxing it.

## Consequences

- The specification now holds more controls than a first executor will implement
  comfortably. 3C conformance must declare a scoped subset explicitly rather than
  quietly dropping rows.
- The reconciler is a control-plane component that must exist before the first executor
  run, not after the first leak.
- The executor is designed top-down from a control matrix: every mandatory
  requirement has an enforcement boundary and an acceptance test, including the
  negative test that tries to defeat it. A control without a test is treated as
  unimplemented.
- Because there is no fallback path, isolation is a hard prerequisite: environments
  that cannot apply the requested policy produce `BLOCKED` runs. This will be less
  convenient than "just run it" and is the point.
- No workspace reuse costs startup time per run; the specification accepts that cost
  and requires the runtime ADR to measure it before any pooling is considered.
- Evidence review becomes a first-class workflow: what a run proves is what was
  authorized (manifest) compared with what was observed (ledger), with the verdict as
  a separate decision.
- The runtime choice remains open, with an explicit burden of proof: measured
  evidence for at least the two most plausible options.
- Some real risks stay outside the model — kernel/hypervisor escapes, image supply
  chain, host-level denial of service, privileged ledger rewrites — and are recorded
  as residual rather than claimed as solved.
- The repository's current 250 tests prove the product, not these controls: none of
  them starts an execution environment or exercises a control in the specification, so
  a green CI run must never be reported as evidence that isolation is implemented or
  tested.

## Alternatives considered

- **Implement the executor first and retrofit isolation.** Rejected: the unsafe path
  would exist, be convenient, and be exercised; and the acceptance tests would be
  written to match whatever was built.
- **Container-only by default, microVMs "later".** Rejected as a *decision* (not as
  an option): the two have different residual risks, and choosing without measured
  evidence is exactly the unexamined choice ADR-0005 warned about.
- **A local execution mode for convenience, gated behind a flag.** Rejected: two code
  paths where one is unsafe is one code path, because the unsafe one gets used.
- **Let the run report its own verdict (exit code as the result).** Rejected: exit
  codes are attacker-controlled data, and a green exit with a skipped test is the
  most common false `PASS` in practice.
- **Advisory resource limits enforced by the process itself.** Rejected: the watched
  process sets the watch; limits must be enforced outside the environment and
  measured by the supervisor.
- **Reuse warm workspaces between runs for speed.** Rejected for v1: leftover state
  is an unrecorded input, and it makes cleanup failure hard to detect.
- **Claim "tamper-proof" for the chained ledger.** Rejected: dishonest. The chain is
  tamper-evident under stated assumptions; privileged rewrite remains residual.
