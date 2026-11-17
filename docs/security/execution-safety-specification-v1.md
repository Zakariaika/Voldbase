# Execution safety specification v1

- Status: **Specification** (Phase 3A). No implementation in this repository.
- Applies to: the future VOLDBASE Execution Engine (Phase 3), which does not exist yet.
- Normative language: **MUST**, **MUST NOT**, **SHOULD** are used as in RFC 2119.

## 0. What this document is, and what it is not

This is a specification: requirements, trust boundaries, a threat model, a control
matrix and the tests that decide whether a future implementation conforms.

**VOLDBASE does not provide execution isolation today.** There is no executor, no
sandbox, no container or microVM code in this repository, and nothing here changes
that. Everything below describes what a conforming engine must do *before* it may
run any project code, and how that claim would be verified. Until an implementation
exists and passes the acceptance criteria in §11, the honest status of every
experiment is `NOT_TESTED` — never `PASS`.

Two consequences of that framing matter for the whole design:

1. This document cannot be satisfied by configuration alone. Each control names an
   *enforcement boundary* (where the decision is made, in a trusted component) and a
   *verification test* (how a reviewer proves the boundary holds, including the
   negative test that tries to defeat it).
2. A control that cannot be enforced or measured **fails closed**: the run becomes
   `BLOCKED`. "We could not check it, so we continued" is not a permitted outcome
   anywhere in this specification.

## 1. Terms

| Term | Meaning |
| --- | --- |
| Project snapshot | The immutable, content-addressed import produced by Phase 1. Only this may enter an execution environment. |
| Untrusted code | Project source, build scripts, test commands, dependency install steps, generated wrappers — anything not written by VOLDBASE. |
| Control Plane | Trusted VOLDBASE process that owns policy: what may run, with which limits, under which identity. |
| Provisioner / Supervisor | Trusted component that creates, configures, observes and destroys an isolated environment on instruction from the Control Plane. |
| Execution environment | The untrusted, disposable environment where project code runs. |
| Evidence Collector | Trusted component outside the environment that receives, hashes and stores outputs. |
| Verdict Engine | Trusted component that decides `PASS` / `FAIL` / `INCONCLUSIVE` / `BLOCKED` from validated evidence. |
| Run Ledger | Append-only record of run events, bound to a run id and the experiment definition digest. |
| Run manifest | The immutable record of *what was authorized* for a run: image identity, network policy, mounts, limits, tool versions. |
| Mandatory condition | A pre-declared condition that must hold for `PASS`; declared before the run, not derived from its output. |

## 2. Trust boundaries

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TRUSTED                                                                  │
│                                                                          │
│  ① Control Plane ── policy, authorization, run manifest creation         │
│        │  (narrow, authenticated control interface — CP-01)              │
│        ▼                                                                 │
│  ② Provisioner / Supervisor ── create/observe/destroy                    │
│        │  (no project code passes through here)                          │
│        │                                                                 │
│        │           ④ Evidence Collector ─── hashes + stores outputs      │
│        │                    ▲                                            │
│        │                    │ validated, size-bounded streams            │
│        ▼                    │                                            │
│  ┌──────────────────────────┴─────────────────────────────────────────┐  │
│  │ UNTRUSTED  ③ Isolated Execution Environment                        │  │
│  │   project snapshot copy + pinned toolchain + project processes     │  │
│  │   no host paths · no network by default · hard limits · no secrets │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│        │                                                                 │
│        ▼                                                                 │
│  ⑤ Independent Verdict Engine ── reads evidence, never the sandbox       │
│        │                                                                 │
│        ▼                                                                 │
│  ⑥ Append-only Run Ledger ── events + evidence digests + outcome         │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Authority matrix

`may` = permitted, `—` = must not be possible.

| Actor | Read policy | Create env | Destroy env | Write evidence | Decide verdict | Append ledger |
| --- | --- | --- | --- | --- | --- | --- |
| Control Plane ① | may | via ② only | via ② only | — | — | may |
| Provisioner/Supervisor ② | may (own run) | may | may | — | — | may (lifecycle events) |
| Execution environment ③ | — | — | — | — | — | — |
| Evidence Collector ④ | — | — | — | may | — | may (evidence events) |
| Verdict Engine ⑤ | may | — | — | — | may | may (verdict events) |
| Run Ledger ⑥ | may | — | — | — | — | append only |

The environment **③ has authority over nothing**. It cannot create or destroy
environments, cannot write evidence, cannot append to the ledger, cannot read the
run manifest's authorization policy, and cannot influence the verdict except by
producing bytes that ④ hashes and ⑤ evaluates.

Every arrow crossing from ③ into ④ is a parser boundary: it carries bytes, not
authority. Nothing in ③ is trusted to describe itself truthfully — including exit
codes, timing, file lists and "all tests passed" output.

## 3. Threat model

Each threat states what is assumed, what a conforming engine guarantees, and what
remains. Threats are the `T-nn` ids referenced by the control matrix in §5.

### T-01 Malicious project code

- **Assumed:** project code is written by an adversary and runs with the intent to
  escape, exfiltrate, persist or exhaust.
- **Guarantee:** code never executes on the host (HX-01..HX-05), inside an
  environment with only its own copied snapshot and a minimal mount set
  (FS-01..FS-07), under explicit resource caps (RES-01..RES-08).
- **Residual:** a kernel or hypervisor vulnerability inside the isolation boundary
  defeats these guarantees; see T-10.

### T-02 Prompt-injected or AI-generated code with unsafe behaviour

- **Assumed:** generated code may contain instructions aimed at the agent or the
  reviewer ("ignore the tests", "mark this passed"), and may be malformed.
- **Guarantee:** instructions inside project content are data (EV-03); the verdict
  is computed only from validated evidence (VD-01..VD-06), so a comment, a test
  name or a stdout claim cannot change it. Additive review surfaces (diffs, logs)
  never gate the verdict.
- **Residual:** a human reviewer can still be persuaded by persuasive output; that
  is a process risk, not a control this engine enforces.

### T-03 Malicious build/test scripts

- **Assumed:** `package.json` scripts, Makefiles, setup hooks and test runners run
  arbitrary commands, possibly before the "real" test.
- **Guarantee:** a script has exactly the authority of the environment: no host
  paths, no network unless authorized (NET-01..NET-04), no evidence write, no
  ledger append.

### T-04 Dependency and toolchain compromise

- **Assumed:** a dependency, package manager, compiler or base image may be
  tampered with, or its registry may serve different bytes than reviewed.
- **Guarantee:** images are pinned by digest and recorded (IMG-01..IMG-05);
  signatures and vulnerability scans are separate, explicitly recorded checks; a
  tool version that differs from the manifest blocks the run rather than being
  reported as a different environment.

### T-05 Resource exhaustion

- **Assumed:** code deliberately spins, forks, allocates, writes or prints without
  bound, including to exhaust the host or to make evidence collection impossible.
- **Guarantee:** every limit in §6 is set before execution, enforced by the
  environment boundary and measured by the supervisor; stdout/stderr are bounded
  at the collector, not by trusting the process to stop. Any unenforceable limit is
  `BLOCKED` (RES-08).

### T-06 Filesystem escape attempts

- **Assumed:** symlinks, `..` traversal, bind-mount confusion, `/proc` tricks and
  setuid binaries are all attempted.
- **Guarantee:** a fresh workspace, an explicit mount allowlist (FS-02, FS-03), no
  host Docker/container socket (HX-05), and no evidence store visible from inside
  (FS-05). Snapshot contents are copied with the Phase 1 rules that already never
  follow symlinks.

### T-07 Network exfiltration attempts

- **Assumed:** any reachable network will be used to exfiltrate the snapshot,
  secrets or environment metadata, possibly over DNS or a proxy.
- **Guarantee:** no network by default (NET-01); authorization is per experiment and
  recorded (NET-02, NET-03); failure to apply the policy blocks (NET-04). "Partial"
  network is not a permitted state.

### T-08 Evidence tampering

- **Assumed:** the untrusted environment tries to alter, truncate, replay or forge
  what it produced, and a host-level adversary with write access to the store tries
  to rewrite history.
- **Guarantee:** evidence is hashed outside the environment and bound to the run id
  and experiment digest (EV-01..EV-04); the ledger is append-only with per-event
  chaining and independent verification (EV-05..EV-08). Missing or invalid evidence
  blocks a verdict instead of passing it (VD-05).
- **Residual:** a hash chain does not stop an administrator who can rewrite the
  entire ledger *and* recompute every hash. See §8.3.

### T-09 Sandbox/runtime misconfiguration

- **Assumed:** a default that enables networking, a stray `--privileged`, a mounted
  socket, an unset limit, or a fallback "just run it here" path.
- **Guarantee:** configuration is explicit and validated before creation
  (CFG-01..CFG-03); the requested policy is recorded in the immutable run manifest
  and compared against the *observed* environment (CP-04); any mismatch aborts the
  run before untrusted code starts. There is no development, debug or "unsafe" mode
  that bypasses isolation (HX-03).

### T-10 Supervisor compromise and residual risks

- **Assumed:** the trusted boundary can be attacked directly, or an administrator
  can act maliciously.
- **Guarantee:** the supervisor's authority is narrow (CP-01, CP-02): it can create
  and destroy environments and emit lifecycle events, and it holds no verdict
  authority. The verdict engine and ledger are separate processes (CP-03).
- **Residual:** if the supervisor is compromised, isolation can be silently
  weakened for future runs; if the host kernel is compromised, the environment is
  not a boundary at all. These are accepted for v1 and are reasons to keep evidence
  reviewable by a human (§8.3), not reasons to relax any control.

### 3.1 Guarantees, assumptions, residual risk

| Class | Statement |
| --- | --- |
| **Guarantee** (once implemented and conformance-tested) | Project code does not execute on the host; the environment cannot reach the evidence store, the ledger or the control interface; the verdict is computed outside the environment from validated evidence. |
| **Assumption** | The host kernel and the isolation technology are not already compromised; the Control Plane, Provisioner, Collector, Verdict Engine and Ledger run on infrastructure the operator controls; clocks are roughly monotonic. |
| **Residual** | Kernel/hypervisor escapes, supply-chain compromise of the pinned image, denial of service against the host, and privileged administrators rewriting the ledger. |
| **Not claimed** | That a `PASS` proves the software is correct, secure or performant; that a sandbox is a substitute for code review; that this repository currently provides any of the above. |

## 4. Mandatory security requirements

The normative requirements, restated before the matrix so they can be read alone.
Each maps to one or more controls in §5.

**R1 — No host execution.** Untrusted project code MUST NOT execute directly on the
host. There MUST be no `child_process` (or equivalent) path for project code, no
development/debug/fallback mode that bypasses isolation, and no degradation path
("isolation unavailable, running anyway"). Sandbox management MUST use a narrowly
scoped, authenticated control interface. The environment MUST NOT receive access to
the host container-runtime socket or any equivalent privileged control interface.

**R2 — Network isolation.** Network access MUST be disabled by default, MUST require
explicit per-experiment authorization, and the permitted policy MUST be recorded in
the immutable run manifest. Failure to establish the requested policy MUST block the
run.

**R3 — Filesystem isolation.** Sensitive host paths (`/home`, `/root`, SSH
directories, credential stores, arbitrary host paths) MUST NOT be mounted. Only the
approved project snapshot MUST be copied, into a fresh temporary workspace, using a
minimal explicit mount allowlist. Evidence and run records MUST live outside the
untrusted environment, which MUST NOT be able to modify them.

**R4 — Resource limits.** CPU, memory, PIDs, disk/workspace size, wall-clock
timeout, stdout/stderr size and artifact count/size MUST each have an explicit,
enforceable limit with fail-closed behaviour when a limit cannot be enforced or
measured.

**R5 — Tool and image identity.** Execution images MUST be pinned by immutable
digest, and digest + platform/architecture + tool versions + provenance MUST be
recorded in the run manifest. Mutable tags MUST be rejected as execution identity.
Vulnerability scanning and signature verification MUST be separate, recorded checks;
a digest alone MUST NOT be treated as evidence that an image is safe.

**R6 — Evidence and audit ledger.** The ledger MUST be append-only; evidence MUST be
hashed outside the environment and bound to a run id and experiment definition
digest; timestamps, tool identity, environment policy, resource limits, termination
reason and cleanup outcome MUST be recorded; tamper detection and verification MUST
be defined. The trust assumptions of chaining MUST be documented, not overstated.

**R7 — Independent verdict.** Execution outcome and verification outcome MUST be
separate. Verdicts are exactly `PASS`, `FAIL`, `INCONCLUSIVE`, `BLOCKED`. `PASS`
requires every predefined mandatory condition to be satisfied by validated evidence.
The executed program MUST NOT be able to declare its own `PASS`, and missing or
invalid evidence MUST NOT be interpreted as success.

**R8 — Fresh environment and cleanup.** Every run MUST get a new environment, with no
workspace reuse between runs. Cleanup MUST be attempted on success, failure,
timeout, cancellation and supervisor failure. A failed cleanup MUST mark the run
unsafe and MUST prevent reuse of that environment.

## 5. Control matrix

Format: **ID** — threat — mandatory requirement — enforcement boundary —
verification / acceptance test — failure behaviour.

### 5.1 Host execution (R1)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| HX-01 | T-01, T-09 | Project code runs only inside an isolated environment | Control Plane refuses any execution request without a provisioned environment | Attempt to start a run with no environment: request rejected before any process starts; ledger records `blocked/isolation_unavailable` | `BLOCKED` |
| HX-02 | T-01 | No host-side process execution of project code | Static: no `child_process`/`spawn`/`exec` import reachable from the executor module; runtime: syscall/audit trace of a run shows no host exec | Source-level import test + audit trace assertion (NT-01) | Build/test failure; run `BLOCKED` |
| HX-03 | T-09 | No development, debug or fallback mode that bypasses isolation | There is no such flag; unknown flags are rejected | Enumerate CLI/config options; assert no isolation-bypass option exists; attempt documented bypass strings and confirm rejection (NT-01) | `BLOCKED` |
| HX-04 | T-09 | Sandbox management uses a narrowly scoped authenticated control interface | Supervisor API requires per-run authentication and exposes only create/observe/destroy for that run | Unauthenticated and cross-run control calls rejected (4xx) and recorded (CP-05) | `BLOCKED` |
| HX-05 | T-06, T-09 | Environment has no host container-runtime socket or equivalent control interface | Mount allowlist excludes sockets; environment inventory check before start | Inspect environment mounts/handles: no socket, no `/var/run/*.sock`, no container-runtime endpoint reachable (NT-03) | `BLOCKED` before execution |

### 5.2 Network (R2)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| NET-01 | T-07 | Network disabled by default | Environment created with no route/interface beyond loopback, or with an explicit deny policy | Run without authorization: outbound connection attempt fails; ledger records the policy as `none` | `BLOCKED` if the deny policy cannot be established |
| NET-02 | T-07 | Network requires explicit experiment-level authorization | Control Plane validates an authorization record naming the experiment definition digest | Run requesting network without a matching authorization is rejected | `BLOCKED` |
| NET-03 | T-07 | Permitted policy recorded in the immutable run manifest | Run manifest is written and hashed before execution; later changes fail verification | Manifest contains egress allowlist; mutating it after the run invalidates the evidence (EV-04) | `BLOCKED` |
| NET-04 | T-07, T-09 | Failure to establish the requested policy blocks execution | Supervisor verifies the *observed* policy equals the requested one before starting code | Simulate policy-apply failure: no project process starts, run `BLOCKED`, no partial state (NT-02) | `BLOCKED` |

### 5.3 Filesystem (R3)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| FS-01 | T-06 | Sensitive host paths are never mounted | Mount allowlist contains no host path outside the workspace; deny patterns for `/home`, `/root`, `.ssh`, `.aws`, `.config`, `.gnupg`, `.docker`, `/etc` | Attempt a manifest requesting `/home`, `/root`, `~/.ssh`: rejected at validation, before creation (NT-03) | `BLOCKED` |
| FS-02 | T-06 | Only the approved snapshot is copied into the workspace | Provisioner materialises the snapshot from content-addressed storage and verifies its digest | Workspace inventory equals snapshot inventory; digest match recorded | `BLOCKED` |
| FS-03 | T-06 | Fresh temporary workspace per run, minimal explicit mounts | Workspace path derived per run, created empty, never reused | Two runs never share a workspace path; no mount outside the allowlist (NT-09) | `BLOCKED` |
| FS-04 | T-06 | No host path is writable from inside | Only the workspace is writable; all else read-only or absent | Write attempt outside the workspace fails; filesystem inventory unchanged after the run | `BLOCKED` if the isolation cannot be expressed |
| FS-05 | T-08 | Evidence store is outside and unmodifiable from the environment | Collector writes outside; environment has no mount and no credentials for it | From inside: evidence path does not exist and no credential is present; store digest unchanged (NT-06) | `BLOCKED` if the store would be reachable |
| FS-06 | T-06 | No secrets or credentials in the environment | Environment carries no project or host env vars; secrets are not injected for v1 | Environment variable inventory contains only an explicit allowlist (locale, PATH, workspace root) | `BLOCKED` |
| FS-07 | T-06 | Artifacts leave only through the collector, size-capped and path-sanitised | Collector copies from a read-only export volume, rejecting traversal and symlinks | Artifact with `../` or symlink escaping the workspace is rejected (RES-07) | Artifact rejected; run outcome unchanged |

### 5.4 Resources (R4)

Explicit defaults for v1; each is a *require-value* field — an unset value is a
configuration error, not "unlimited".

| Limit | Field | Default | Enforced by |
| --- | --- | --- | --- |
| CPU | `cpuMillis` | 2000 | environment cgroup/quota |
| Memory | `memoryBytes` | 2 GiB (hard, non-swappable) | environment |
| PIDs / processes | `pids` | 256 | environment |
| Workspace / disk | `workspaceBytes` | 2 GiB | environment + pre-allocated export quota |
| Wall clock | `timeoutMs` | 900 000 | supervisor (authoritative clock, outside the environment) |
| stdout / stderr | `streamBytes` each | 1 MiB | collector, enforced while streaming |
| Artifacts | `artifactCount` / `artifactBytes` | 200 / 256 MiB | collector |

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| RES-01 | T-05 | Every limit is set before execution and recorded in the run manifest | Control Plane requires a complete limits object; no field may be null | Run with one limit omitted is rejected (NT-04); manifest lists all seven | `BLOCKED` |
| RES-02 | T-05 | CPU and memory limits are enforced, not advisory | environment: hard cgroup/quota equivalent | Spin and alloc loops are terminated at the cap; supervisor records the limit event | `FAIL` if the process is killed by the limit; `BLOCKED` if enforcement is absent |
| RES-03 | T-05 | PID limit enforced | environment | Fork bomb terminates at the cap without host impact | as RES-02 |
| RES-04 | T-05 | Disk/workspace limit enforced | environment + collector quota | Writer exceeding the quota is killed and the overflow is not exported | as RES-02 |
| RES-05 | T-05 | Wall-clock timeout measured outside the environment | supervisor | Sleep-forever run is terminated at `timeoutMs` (+ documented grace) | `FAIL` (timeout is failure, never `INCONCLUSIVE`-by-default) |
| RES-06 | T-05 | stdout/stderr bounded while streaming | collector | Infinite printer is cut at the cap; truncation recorded in evidence metadata | Evidence flagged truncated; verdict cannot be `PASS` if a mandatory condition depended on truncated output |
| RES-07 | T-05 | Artifact count and total size bounded; names sanitised | collector | Artifact bomb exceeds count/bytes: excess rejected and recorded (NT-06 adjacent) | Excess rejected; mandatory-condition evidence missing ⇒ not `PASS` |
| RES-08 | T-05, T-09 | If a limit cannot be enforced or measured, the run MUST NOT start | Control Plane capability check | Configure an environment that cannot report memory usage: run is `BLOCKED` before execution | `BLOCKED` |

### 5.5 Image and toolchain identity (R5)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| IMG-01 | T-04 | Images pinned by immutable digest | Control Plane resolves and stores `sha256:` digest; tags are not identity | Manifest with `image: node:22` (tag only) is rejected (NT-05) | `BLOCKED` |
| IMG-02 | T-04 | Platform/architecture recorded | Run manifest | Manifest includes `os`/`arch`/variant; mismatched host refuses to run | `BLOCKED` |
| IMG-03 | T-04 | Tool versions and provenance recorded | Run manifest, captured from inside the environment and cross-checked | Manifest tool versions match observed versions; mismatch blocks | `BLOCKED` |
| IMG-04 | T-04 | Vulnerability scan is a separate recorded check | Control Plane, using a pinned scanner | Scan result present with scanner identity/version and its own digest; absence is a configuration error | `BLOCKED` (do not assume clean) |
| IMG-05 | T-04 | Signature verification is a separate recorded check; a digest alone is not "safe" | Control Plane | Evidence shows digest, scan result and signature status as three distinct fields; a verified digest with unknown signature is not claimed safe | `BLOCKED` if the policy requires a signature and none is verified |

### 5.6 Evidence and ledger (R6)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| EV-01 | T-08 | Append-only event model | Ledger rejects update/delete of existing entries | Attempt to rewrite or delete an event fails and is recorded (NT-06) | Run marked unsafe; ledger integrity alarm |
| EV-02 | T-08 | Evidence hashed outside the environment | Collector hashes on receipt; the environment's claimed hashes are ignored | Recompute digests from stored bytes; they match the recorded ones | Evidence invalid ⇒ `BLOCKED` |
| EV-03 | T-02, T-08 | Evidence bound to run id + experiment definition digest | Collector writes binding fields; verdict engine compares | Evidence from run A presented for run B is rejected | Evidence rejected; `BLOCKED` |
| EV-04 | T-08 | Run manifest immutable and hashed before execution | Control Plane | Post-run manifest modification fails verification and invalidates the run | Run invalidated |
| EV-05 | T-08 | Required event fields recorded | Ledger schema validation | Events carry timestamps, tool identity, environment policy, limits, termination reason, cleanup outcome | Missing field ⇒ run invalid |
| EV-06 | T-08 | Tamper detection defined and executable | Independent verification tool | Verification recomputes per-event digests and the chain; a flipped byte is detected (NT-06) | Verification fails loudly; no silent repair |
| EV-07 | T-08 | Chain/truncation detection | Ledger + verification | Removing the last N events is detected against the last known head recorded elsewhere | Run history flagged unverifiable |
| EV-08 | T-08 | Trust assumptions documented and surfaced | Specification + report header | Report states what the chain does and does not prove (§8.3) | — (documentation control) |

### 5.7 Verdict engine (R7)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| VD-01 | T-02 | Execution outcome and verdict are separate records | Verdict engine reads evidence, never process state | Report shows exit status as *observation* and verdict as *decision* | — |
| VD-02 | T-02 | Verdict vocabulary is exactly `PASS`/`FAIL`/`INCONCLUSIVE`/`BLOCKED` | Verdict engine | Unknown verdict strings are rejected by schema | Run invalid |
| VD-03 | T-02 | `PASS` requires every predefined mandatory condition satisfied by validated evidence | Verdict engine evaluates declared conditions only | A run with a passing exit code but a missing condition is not `PASS` (NT-07) | `INCONCLUSIVE` |
| VD-04 | T-02 | The executed program cannot declare its own `PASS` | No code path accepts a verdict from evidence content | A test printing `PASS`/`OK`/JSON verdict does not change the verdict (NT-07) | — |
| VD-05 | T-02, T-08 | Missing or invalid evidence is never success | Verdict engine treats absent/invalid evidence as unsatisfied | Delete a required evidence file: verdict is not `PASS` (NT-06/07) | `BLOCKED` or `INCONCLUSIVE` |
| VD-06 | T-05 | A run terminated by a resource limit or timeout is not `PASS` | Verdict engine consumes the termination reason | Timeout run with passing stdout cannot be `PASS` (NT-08) | `FAIL` |

### 5.8 Lifecycle: fresh environment, cleanup, quarantine (R8)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| LC-01 | T-06 | New environment per run; no reuse | Provisioner allocates a new identity per run | Environment ids differ across runs; a prior id cannot be requested | `BLOCKED` |
| LC-02 | T-06 | No workspace reuse | Provisioner creates an empty workspace and verifies it is empty | Pre-existing file in a "fresh" workspace aborts the run (NT-09) | `BLOCKED` |
| LC-03 | T-05 | Cleanup attempted on success, failure, timeout, cancellation and supervisor failure | Supervisor `finally`-equivalent, driven by the Control Plane's run record | Kill the supervisor mid-run; Control Plane attempts cleanup and records the outcome (NT-08) | Run marked unsafe (LC-04) |
| LC-04 | T-05 | Cleanup failure marks the run unsafe and forbids reuse | Control Plane state machine | Simulate cleanup failure: environment quarantined, never selected again | `BLOCKED` for that environment; run outcome recorded as unsafe |
| LC-05 | T-05 | Quarantine and operator recovery defined | Control Plane + documented procedure | Quarantined environment appears in an operator list with a recovery/destroy action | — |
| LC-06 | T-05 | Termination reason recorded for every run | Ledger | Every terminal run has exactly one reason (`completed`, `failed`, `timeout`, `cancelled`, `limit`, `supervisor_error`) | Run invalid |

### 5.9 Control plane and configuration (T-09)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| CP-01 | T-10 | Control interface is narrow and authenticated | Control Plane ⇄ Provisioner API | Only documented operations exist; each requires run-scoped authentication | `BLOCKED` |
| CP-02 | T-10 | Supervisor cannot decide verdicts or write evidence | Separate components, separate credentials | Supervisor credentials are rejected by the Evidence Collector and Verdict Engine | `BLOCKED` |
| CP-03 | T-10 | Verdict engine and ledger are separate from the executor | Process/privilege separation | Killing the environment has no effect on verdict/ledger services | Run invalid if verdict cannot be computed |
| CP-04 | T-09 | Requested policy is compared with observed policy before code starts | Supervisor pre-flight check | Mismatch (extra mount, network up, limit unset) aborts before execution | `BLOCKED` |
| CP-05 | T-09, T-10 | Every control decision is recorded | Ledger | Denied requests, pre-flight failures and policy mismatches all appear as events | Missing event ⇒ run invalid |
| CFG-01 | T-09 | Configuration is validated with a schema; unknown keys rejected | Control Plane | Unknown/typo'd key (`network: "off"` misspelled) is rejected, not ignored | `BLOCKED` |
| CFG-02 | T-09 | Defaults never enable capabilities | Schema defaults | Default manifest = no network, no extra mounts, full limits | `BLOCKED` if a default would enable anything |
| CFG-03 | T-09 | No unsafe/development bypass exists in any configuration | Absence + enumeration test | Search configuration surface for bypass keys; assert none exist (NT-01) | Build failure if such a path is added |

## 6. Isolation technology: containers vs microVMs (deferred decision)

No production runtime is selected in this phase. The specification is written so
that either family can satisfy it, and the choice gets its own ADR supported by
evidence.

| Dimension | Container isolation (e.g. namespaces + cgroups/seccomp) | MicroVM isolation (e.g. hardware-virtualised VM) |
| --- | --- | --- |
| Boundary | Shared host kernel; isolation is a kernel feature set | Separate guest kernel; hardware virtualisation boundary |
| Escape surface | Kernel syscall surface, device and mount handling, runtime bugs | Hypervisor + virtual device surface (smaller, different) |
| Startup cost | Low (sub-second to seconds) | Higher (seconds), amortisable with snapshot/pooling |
| Density | High | Moderate |
| I/O and toolchain realism | Excellent; same kernel as CI | Good; needs a guest with the toolchain |
| Observability | Easy (host can inspect directly) | Requires agent/channel; fewer shared primitives |
| Network control | Namespace policy + egress rules | Virtual NIC policy; stronger default-deny story |
| Resource accounting | cgroups (well understood) | Hypervisor + guest cooperation |
| Operational maturity | Very high | Growing; tooling varies |
| Typical residual risk | Kernel CVE, privileged flags, mounted socket | Hypervisor CVE, guest agent trust, slower iteration |

Guidance rather than a decision:

- Requirements HX-05, FS-01..FS-05 and NET-01..NET-04 are *technology-neutral*; both
  families can satisfy them, and the conformance tests in §10 are what decide.
- A container-based engine MUST additionally prove: no privileged flags, no host
  runtime socket, seccomp/AppArmor-class policy, user-namespace mapping, and a
  documented kernel-CVE response process.
- A microVM-based engine MUST additionally prove: guest agent is not a control path,
  evidence leaves through the collector only, and boot/teardown is bounded by the
  wall-clock budget.
- The decision ADR (Phase 3B) must record measured evidence — escape-resistance
  checks, startup cost, resource-accounting fidelity, operator burden — for at least
  the two most plausible options. Choosing a runtime by familiarity is not evidence.

## 7. Run manifest (immutable, hashed before execution)

```jsonc
{
  "runId": "run_…",
  "experimentDefinitionDigest": "sha256:…",
  "projectSnapshot": { "projectId": "proj_…", "revision": "sha256:…" },
  "image": {
    "digest": "sha256:…",          // identity; a tag here is invalid (IMG-01)
    "platform": { "os": "linux", "arch": "amd64" },
    "signature": { "status": "verified|unverified|unavailable", "by": "…" },
    "vulnerabilityScan": { "status": "clean|findings|unavailable", "scanner": "…", "version": "…" }
  },
  "tools": [{ "name": "node", "version": "22.18.0" }],
  "network": { "policy": "none|allowlist", "allow": [], "authorization": "…" },
  "mounts": [{ "source": "workspace", "target": "/work", "mode": "rw" }],
  "limits": {
    "cpuMillis": 2000, "memoryBytes": 2147483648, "pids": 256,
    "workspaceBytes": 2147483648, "timeoutMs": 900000,
    "streamBytes": 1048576, "artifactCount": 200, "artifactBytes": 268435456
  },
  "createdAt": "2026-11-17T00:00:00.000Z"
}
```

The manifest is the *authorization*: what the Control Plane permitted. The run's
*observations* (exit status, timings, limit events, cleanup) are separate ledger
events, so a claim can always be compared with what was authorized.

## 8. Evidence and ledger model

### 8.1 Events

Append-only, one line per event, each carrying `seq`, `runId`, `at`, `type`, `data`
and `prevDigest`, with `digest` covering the canonicalised event. Event types:
`run_requested`, `policy_validated`, `environment_created`, `policy_verified`,
`execution_started`, `stream_truncated`, `limit_exceeded`, `execution_finished`,
`evidence_collected`, `cleanup_attempted`, `cleanup_finished`, `verdict_recorded`,
`run_aborted`.

### 8.2 Evidence

- Hashed on receipt by the collector, outside the environment (EV-02).
- Bound to `runId` + `experimentDefinitionDigest` + manifest digest (EV-03).
- Stored outside any path the environment can reach or write (FS-05).
- Composition: stdout, stderr, normalized exit status, artifact list with digests,
  limit/termination events, environment inventory (mounts, network policy, tool
  versions) captured by the supervisor.

### 8.3 Trust assumptions of the chain (stated plainly)

A hash chain detects **edits and reordering by anyone who does not control the whole
ledger**, and truncation if the head is recorded somewhere else. It does **not**
protect against an administrator with write access to the ledger who recomputes every
digest, nor against a compromise of the machine that computes them. Mitigations that
are *planned*, not present: exporting the head digest to an external, operator-chosen
witness (e.g. a second host, a signed commit, a transparency log), and signing
verdicts with an operator-held key. Until one exists, VOLDBASE must say that ledger
integrity is *tamper-evident under stated assumptions*, never "tamper-proof".

## 9. Verdict semantics

| Verdict | When |
| --- | --- |
| `PASS` | Every predefined mandatory condition satisfied by validated evidence, no limit/timeout termination, cleanup completed or explicitly recorded as successful. |
| `FAIL` | The run executed and at least one mandatory condition is demonstrably unsatisfied, or it was terminated by a limit/timeout. |
| `INCONCLUSIVE` | The run executed but evidence is insufficient to decide (truncated output that a condition depended on, flaky sampling declared by the definition, evidence present but not decisive). |
| `BLOCKED` | No execution happened, or it could not be trusted: isolation unavailable, policy not established, limit unenforceable, image identity invalid, evidence invalid or missing, cleanup failed. |

Rules that follow from R7 and are testable:

1. The process's own output — exit code, a `PASS` string, a JSON verdict, a JUnit
   file the program wrote — is **evidence**, never a verdict (VD-04).
2. Absent evidence is unsatisfied, not satisfied (VD-05).
3. Timeout and limit termination cap the verdict at `FAIL` (VD-06).
4. Cleanup failure never upgrades a verdict; it makes the run unsafe (LC-04).
5. Every verdict names the conditions it evaluated and the evidence digests used.

## 10. Negative tests (acceptance)

Each is a required test for the future implementation; today they are the criteria a
reviewer checks the design against.

| ID | Test | Required result |
| --- | --- | --- |
| NT-01 | Attempt host-execution fallback: request a run with isolation unavailable; try documented bypass/debug flags; grep the executor for `child_process` paths | Request rejected, no host process spawned, no bypass flag exists, no such import path (HX-02, HX-03, CFG-03) |
| NT-02 | Request network without authorization; then request an allowlist that the supervisor cannot apply | Both `BLOCKED` before any project process starts; ledger records the attempt (NET-02, NET-04) |
| NT-03 | Request mounts for `/home`, `/root`, `~/.ssh`, an SSH agent socket, the container-runtime socket | Rejected at validation; environment inventory contains no such mount (FS-01, HX-05) |
| NT-04 | Omit or null one resource limit (memory, or PIDs); configure an environment that cannot report a limit | Rejected before execution — never "unlimited" (RES-01, RES-08) |
| NT-05 | Specify `node:22` (or any tag) as image identity | Rejected; only digest identity accepted (IMG-01) |
| NT-06 | Modify a stored evidence file; delete one; rewrite a ledger event; truncate the ledger; try to write evidence from inside the environment | All detected; verdict becomes `INCONCLUSIVE`/`BLOCKED`, never `PASS` (EV-01, EV-02, EV-06, FS-05) |
| NT-07 | A test that prints `PASS`, writes a fake verdict file and exits 0, while a mandatory condition is unsatisfied | Verdict is not `PASS` (VD-03, VD-04, VD-05) |
| NT-08 | Kill the supervisor mid-run; force a timeout; force a cleanup failure | Cleanup attempted and its outcome recorded; run unsafe/quarantined; timeout caps verdict at `FAIL` (LC-03, LC-04, RES-05, VD-06) |
| NT-09 | Make a run start against a workspace that already contains a file, or re-request a previous environment id | Refused: fresh environment and empty workspace are required (LC-01, LC-02) |
| NT-10 | Provide a manifest with an unknown or misspelled key | Schema validation rejects it (CFG-01) |
| NT-11 | Run with a resource-limit bomb (fork bomb, allocation loop, infinite printer, artifact bomb) | Terminated at the cap; host unaffected; truncation recorded (RES-02..RES-07) |

## 11. Conformance and status

A future implementation claims conformance only when:

1. Every control in §5 has an automated acceptance test, and the negative tests in
   §10 pass in CI on the supported Node matrix (plus the isolation host matrix
   documented by the runtime ADR).
2. The tests run against the *real* isolation path, not a mock that bypasses it; a
   green suite with a mocked boundary proves nothing about safety.
3. Results are published with the run ids and evidence digests so a reviewer can
   re-verify them.

Until then, the status of this specification is **documented, not enforced**, and
VOLDBASE must say so wherever it mentions execution: there is no executor, no
sandbox, and no `PASS` — only `NOT_TESTED` and analysis.

## 12. Open questions for Phase 3B

- Which isolation family (container vs microVM) satisfies §5 with the least operator
  burden, supported by measured evidence?
- Where does the ledger head get witnessed so truncation is detectable across hosts?
- Do artifacts need their own provenance attestation, or is collector hashing plus
  run binding sufficient for v1?
- How are toolchain images built and rebuilt reproducibly, and who reviews their
  scans?
- What is the operator recovery procedure for a quarantined environment in practice
  (inspect → destroy → document), and who may authorize it?
