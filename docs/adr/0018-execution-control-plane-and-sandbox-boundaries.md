# 0018 — Execution control plane and sandbox boundaries

- Status: Proposed (specification accepted for review; implementation is Phase 3B)
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

## Consequences

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
