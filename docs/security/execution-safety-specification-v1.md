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
| Provisioner / Supervisor | Trusted component that creates, configures and observes an isolated environment on instruction from the Control Plane. It may request destruction, but it does not own the cleanup decision (LC-07). |
| Reconciler | Trusted Control Plane component that owns cleanup: it discovers run-owned resources from their labels and the ledger, and destroys or quarantines them, independently of any supervisor's lifetime. |
| Execution environment | The untrusted, disposable environment where project code runs. |
| Evidence Collector | Trusted component outside the environment that receives, hashes and stores outputs. |
| Verdict Engine | Trusted component that decides `PASS` / `FAIL` / `INCONCLUSIVE` / `BLOCKED` from validated evidence. |
| Run Ledger | Append-only record of run events, bound to a run id and the experiment definition digest. |
| Run manifest | The immutable record of *what was authorized* for a run: image identity, network policy, mounts, limits, tool versions. |
| Mandatory condition | A pre-declared condition that must hold for `PASS`; declared before the run, not derived from its output. An executable definition MUST declare at least one (VD-12). |

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
  is computed only from validated evidence (VD-01..VD-12), so a comment, a test
  name or a stdout claim cannot change it. Additive review surfaces (diffs, logs)
  never gate the verdict.
- **Residual:** a human reviewer can still be persuaded by persuasive output; that
  is a process risk, not a control this engine enforces.

### T-03 Malicious build/test scripts

- **Assumed:** `package.json` scripts, Makefiles, setup hooks and test runners run
  arbitrary commands, possibly before the "real" test.
- **Guarantee:** a script has exactly the authority of the environment: no host
  paths, no network unless authorized (NET-01..NET-06), no evidence write, no
  ledger append.

### T-04 Dependency and toolchain compromise

- **Assumed:** a dependency, package manager, compiler or base image may be
  tampered with, or its registry may serve different bytes than reviewed.
- **Guarantee:** images are pinned by digest and recorded (IMG-01..IMG-05);
  signatures and vulnerability scans are separate, explicitly recorded checks,
  with SBOM and provenance bound to the digest (IMG-06..IMG-08); a toolchain
  identity that cannot be attested blocks the run rather than being taken from the
  environment's own claims.

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
  secrets or environment metadata, possibly over DNS, a proxy or IPv6.
- **Guarantee:** no network by default (NET-01), including DNS, IPv6, proxy paths
  and cloud metadata endpoints; authorization is per experiment and recorded
  (NET-02, NET-03, NET-05); failure to apply the policy blocks (NET-04). "Partial"
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
  authority. The verdict engine and ledger are separate processes (CP-03), and
  cleanup decisions belong to the independent reconciler (LC-07, LC-08).
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
a digest alone MUST NOT be treated as evidence that an image is safe. Toolchain
identity MUST come from build metadata bound to that digest, never from a version
reported by a command running inside the untrusted environment.

**R6 — Evidence and audit ledger.** The ledger MUST be append-only; evidence MUST be
hashed outside the environment and bound to a run id and experiment definition
digest; timestamps, tool identity, environment policy, resource limits, termination
reason and cleanup outcome MUST be recorded; tamper detection and verification MUST
be defined. The trust assumptions of chaining MUST be documented, not overstated.

**R7 — Independent verdict.** Execution outcome and verification outcome MUST be
separate. Verdicts are exactly `PASS`, `FAIL`, `INCONCLUSIVE`, `BLOCKED`, chosen by
the single ordered precedence in §9.1, whose rows include the termination reason and
the cleanup outcome so that every combination has exactly one result. `PASS` requires
every predefined mandatory condition to be satisfied on authentic, `complete` evidence,
termination `completed` or `failed`, and a `clean` lifecycle. Evidence **integrity**
MUST be judged separately from evidence **completeness**: truncation or absence
explained by an authenticated termination event is incomplete output, while an
unexplained absence, digest/binding/manifest mismatch or ledger verification failure
is an integrity failure that blocks. A `timeout` or `limit` termination MUST be `FAIL`
whatever the output and whatever the cleanup state, the only exception being that
integrity failure, which blocks. A supervisor or infrastructure error MUST never yield
`PASS` or `INCONCLUSIVE`. The executed program MUST NOT be able to declare its own
`PASS`, and missing or invalid evidence MUST NOT be interpreted as success.

`PASS` MUST be non-vacuous. Every executable experiment definition MUST declare at
least one predefined mandatory condition; a definition whose mandatory-condition list
is empty or absent MUST be rejected before execution, and a run evaluated against such
a set MUST be `BLOCKED`, never `PASS`. Evidence tampering, digest mismatch, an
unexplained absent artefact or a ledger verification failure MUST be `BLOCKED`;
`INCONCLUSIVE` is reserved for authentic, integrity-valid evidence that is merely
insufficient to decide a condition.

**R8 — Fresh environment and cleanup.** Every run MUST get a new environment, with no
workspace reuse between runs. Cleanup MUST be attempted on success, failure,
timeout, cancellation and supervisor failure, under the control of an independent
reconciler rather than the supervisor. A failed or unverifiable cleanup MUST mark
the run unsafe, MUST quarantine the environment and MUST prevent its reuse.

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
| NET-01 | T-07 | Network disabled by default | Environment created with no route/interface beyond loopback, or with an explicit deny policy | Run without authorization: outbound connections fail over **IPv4 and IPv6**, DNS resolution fails, no proxy variables are present and link-local metadata endpoints are unreachable (NT-16..NT-19); ledger records the policy as `none` | `BLOCKED` if the deny policy cannot be established |
| NET-02 | T-07 | Network requires explicit experiment-level authorization | Control Plane validates an authorization record naming the experiment definition digest | Run requesting network without a matching authorization is rejected | `BLOCKED` |
| NET-03 | T-07 | Permitted policy recorded in the immutable run manifest | Run manifest is written and hashed before execution; later changes fail verification | Manifest contains egress allowlist; mutating it after the run invalidates the evidence (EV-04) | `BLOCKED` |
| NET-04 | T-07, T-09 | Failure to establish the requested policy blocks execution | Supervisor verifies the *observed* policy equals the requested one before starting code | Simulate policy-apply failure: no project process starts, run `BLOCKED`, no partial state (NT-02) | `BLOCKED` |
| NET-05 | T-07 | Every authorized egress rule is fully specified: protocol, destination, port(s) and DNS handling | Control Plane validates the rule schema; the supervisor applies exactly that rule | A rule missing any of the four fields is rejected; DNS is denied by default, and when permitted the name is resolved at the control plane and pinned to addresses recorded in the manifest (NT-16) | `BLOCKED` |
| NET-06 | T-07 | Cloud metadata endpoints are blocked explicitly, even when an egress allowlist exists | Environment network policy, independent of the allowlist | With an allowlist active, requests to `169.254.169.254`, `fd00:ec2::254` and equivalent documented endpoints fail (NT-19) | `BLOCKED` if the block cannot be expressed |

### 5.3 Filesystem (R3)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| FS-01 | T-06 | Sensitive host paths are never mounted | Mount allowlist contains no host path outside the workspace; deny patterns for `/home`, `/root`, `.ssh`, `.aws`, `.config`, `.gnupg`, `.docker`, `/etc` | Attempt a manifest requesting `/home`, `/root`, `~/.ssh`: rejected at validation, before creation (NT-03) | `BLOCKED` |
| FS-02 | T-06 | Only the approved snapshot is copied into the workspace | Provisioner materialises the snapshot from content-addressed storage and verifies its digest | Workspace inventory equals snapshot inventory; digest match recorded | `BLOCKED` |
| FS-03 | T-06 | Fresh temporary workspace per run, minimal explicit mounts | Workspace path derived per run, created empty, never reused | Two runs never share a workspace path; no mount outside the allowlist (NT-09) | `BLOCKED` |
| FS-04 | T-06 | No host path is writable from inside | Only the workspace is writable; all else read-only or absent | Write attempt outside the workspace fails; filesystem inventory unchanged after the run | `BLOCKED` if the isolation cannot be expressed |
| FS-05 | T-08 | Evidence store is outside and unmodifiable from the environment | Collector writes outside; environment has no mount and no credentials for it | From inside: evidence path does not exist and no credential is present; store digest unchanged (NT-06) | `BLOCKED` if the store would be reachable |
| FS-06 | T-06 | No secrets or credentials in the environment | Environment carries no project or host env vars; secrets are not injected for v1 | Environment variable inventory contains only an explicit allowlist (locale, PATH, workspace root) (NT-18) | `BLOCKED` |
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
| IMG-03 | T-04 | Toolchain identity comes from trusted image-build metadata (SBOM/provenance bound to the pinned digest), never from commands executed inside the untrusted environment | Control Plane resolves identity from build metadata; anything the environment reports is stored as an observation only | Identity fields are populated from the attested SBOM; a program printing a different version changes only `observations` (NT-14) | `BLOCKED` if no trusted identity exists |
| IMG-04 | T-04 | Vulnerability scan is a separate recorded check | Control Plane, using a pinned scanner | Scan result present with scanner identity/version and its own digest; absence is a configuration error | `BLOCKED` (do not assume clean) |
| IMG-05 | T-04 | Signature verification is a separate recorded check; a digest alone is not "safe" | Control Plane | Evidence shows digest, scan result and signature status as three distinct fields; a verified digest with unknown signature is not claimed safe | `BLOCKED` if the policy requires a signature and none is verified |
| IMG-06 | T-04 | SBOM digest recorded and bound to the image digest | Control Plane + run manifest | Manifest carries the SBOM digest; regenerating it from the pinned image matches | `BLOCKED` if the SBOM is absent or does not match |
| IMG-07 | T-04 | Scanner database identity and freshness recorded; a stale database blocks | Control Plane | Manifest carries scanner name, database version and update timestamp; a database older than the declared maximum age blocks the run | `BLOCKED` (never "scan skipped") |
| IMG-08 | T-04 | Unavailable provenance, or failed provenance verification, blocks execution | Control Plane | Remove the provenance attestation, or present a mismatched signature: no environment is created and the run is `BLOCKED` (NT-15) | `BLOCKED` |

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
| VD-03 | T-02 | `PASS` requires every predefined mandatory condition satisfied by validated evidence | Verdict engine evaluates declared conditions only | A run with a passing exit code but a missing condition is not `PASS` (NT-07) | `INCONCLUSIVE`, or `BLOCKED` when the gap is an integrity failure (row 1) |
| VD-04 | T-02 | The executed program cannot declare its own `PASS` | No code path accepts a verdict from evidence content | A test printing `PASS`/`OK`/JSON verdict does not change the verdict (NT-07) | — |
| VD-05 | T-02, T-08 | Missing, tampered or invalid evidence is never success and never `INCONCLUSIVE`: the record is classified `valid`/`missing`/`corrupted` and never treated as satisfied | Verdict engine + collector | Delete a required evidence file with no authenticated event explaining it, alter a digest, rewrite a ledger event or truncate the ledger: `BLOCKED`; a `stream_truncated` output under a recorded timeout: `FAIL`, not `BLOCKED` (NT-06/07, NT-23) | `BLOCKED` |
| VD-06 | T-05 | A run terminated by `timeout` or `limit` is `FAIL`, whatever its output and whatever the cleanup state — unless evidence integrity fails, which blocks | Verdict engine consumes termination reason, integrity class and lifecycle | Timeout with passing stdout and authenticated truncation is `FAIL`, also with `lifecycleState: unsafe` (NT-08, NT-12); the same run with a corrupted digest is `BLOCKED` (NT-23) | `FAIL`; `BLOCKED` on integrity failure |
| VD-07 | T-02 | Verdict selection is one ordered decision table with no ties (§9.1) | Verdict engine | Exhaustive table test: for every combination of evidence state, condition outcomes, termination reason, isolation outcome and cleanup outcome, exactly one verdict is produced and re-evaluating is idempotent (NT-13) | Any unclassified case ⇒ `BLOCKED` |
| VD-08 | T-02, T-08 | Cleanup outcome is a row of the same ordered decision table (§9.1 row 8, after normalising `unknown`), not an exception applied afterwards; `lifecycleState` is still recorded beside the verdict | Verdict engine + ledger | A cleanup-failure run with a failing condition or a timeout yields `FAIL` + `unsafe`; a cleanup-failure run with complete or insufficient evidence and no failure yields `BLOCKED` + `unsafe`; neither yields `PASS` or `INCONCLUSIVE` (NT-12) | `BLOCKED` if the state cannot be recorded |
| VD-09 | T-02 | Evidence integrity is classified `valid`/`missing`/`corrupted` and coverage `complete`/`insufficient`; both are recorded, coverage is `complete` only when every condition is decided, and `insufficient` implies integrity `valid` | Verdict engine | Every verdict names both classes; `missing`/`corrupted` never yields `PASS` **or** `INCONCLUSIVE`, and `INCONCLUSIVE` is only reachable with integrity `valid` (NT-06, NT-13) | `BLOCKED` |
| VD-10 | T-02, T-10 | Every LC-06 termination reason has exactly one verdict path (§9.2), and `supervisor_error` never yields `PASS` or `INCONCLUSIVE` | Verdict engine | Run the termination matrix: `completed`/`failed` decided by coverage and lifecycle, `timeout`/`limit` `FAIL`, `cancelled` before `BLOCKED` and after `BLOCKED`, `supervisor_error` `BLOCKED` unless a failure is proven (NT-13, NT-22) | Any unmapped reason ⇒ `BLOCKED` |
| VD-11 | T-02, T-08 | Evidence integrity failure is distinguished from incomplete output caused by an early termination, and only the former blocks | Verdict engine + collector | Authenticated truncation under a timeout yields `FAIL`; the same short output with a digest mismatch, an unexplained absent artefact or a ledger verification failure yields `BLOCKED` (NT-23) | Any unclassified evidence state ⇒ `BLOCKED` |
| VD-12 | T-02, T-09 | Every executable experiment definition declares at least one predefined mandatory condition; an empty or missing list is rejected before execution, and `PASS` requires at least one satisfied condition | Control Plane definition validation + verdict engine | A definition with `conditions: []`, or with the field absent, is rejected before any environment is created; if such a definition nevertheless reaches the verdict engine the run is `BLOCKED`, never `PASS`, and `PASS` records the conditions it proved (NT-24) | `BLOCKED` (no vacuous `PASS` possible) |

### 5.8 Lifecycle: fresh environment, cleanup, quarantine (R8)

| ID | Threat | Requirement | Boundary | Acceptance test | On failure |
| --- | --- | --- | --- | --- | --- |
| LC-01 | T-06 | New environment per run; no reuse | Provisioner allocates a new identity per run | Environment ids differ across runs; a prior id cannot be requested | `BLOCKED` |
| LC-02 | T-06 | No workspace reuse | Provisioner creates an empty workspace and verifies it is empty | Pre-existing file in a "fresh" workspace aborts the run (NT-09) | `BLOCKED` |
| LC-03 | T-05 | Cleanup attempted on success, failure, timeout, cancellation and supervisor failure | Control Plane reconciler, driven by the run record rather than by the supervisor (LC-07) | Kill the supervisor mid-run; the reconciler attempts cleanup and records the outcome (NT-08, NT-20) | Run marked unsafe (LC-04) |
| LC-04 | T-05 | Cleanup failure marks the run unsafe and forbids reuse | Control Plane state machine | Simulate cleanup failure: environment quarantined, never selected again | `BLOCKED` for that environment; run outcome recorded as unsafe |
| LC-05 | T-05 | Quarantine and operator recovery defined | Control Plane + documented procedure | Quarantined environment appears in an operator list with a recovery/destroy action | — |
| LC-06 | T-05 | Termination reason recorded for every run, with the phase of a cancellation or supervisor error | Ledger | Every terminal run has exactly one reason (`completed`, `failed`, `timeout`, `cancelled`, `limit`, `supervisor_error`); `cancelled` and `supervisor_error` also record `before_execution`/`after_execution`, so §9.1 can separate row 3 from rows 6–7 (NT-13, NT-22) | Run invalid |
| LC-07 | T-05, T-10 | Cleanup decisions belong to an independent reconciler inside the Control Plane, not to the supervisor process | Control Plane reconciler | SIGKILL the supervisor mid-run: the reconciler discovers the leftover environment from run labels and destroys it; the run is marked unsafe (NT-20) | `BLOCKED`; environment quarantined |
| LC-08 | T-05, T-10 | After a control-plane restart, resources owned by in-flight runs are discovered and reconciled before any new run starts | Control Plane startup reconciliation | Restart during a run: state is rebuilt from the ledger, leftovers are destroyed or quarantined, and no new run starts until reconciliation finishes (NT-20) | New runs `BLOCKED` until reconciliation succeeds |
| LC-09 | T-05 | An environment whose destruction cannot be verified is quarantined permanently and never reused | Reconciler + Control Plane state machine | Make destruction unverifiable: the environment enters quarantine, stays listed for the operator and is never selected again (NT-21) | `BLOCKED` for every run that would have used it |
| LC-10 | T-05 | No environment is reused after uncertain cleanup, including after a crash and restart | Control Plane allocator | Reconciliation never returns a crashed run's environment to the pool, even when destruction reports success | Environment destroyed or quarantined, never released |

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

- Requirements HX-05, FS-01..FS-05 and NET-01..NET-06 are *technology-neutral*; both
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
    "vulnerabilityScan": { "status": "clean|findings|unavailable", "scanner": "…", "version": "…",
                           "database": { "version": "…", "updatedAt": "…" } }
  },
  "toolchain": {                   // identity from build metadata, not self-report (IMG-03, IMG-06)
    "sbomDigest": "sha256:…",
    "provenance": { "status": "verified|unverified|unavailable", "by": "…" },
    "components": [{ "name": "node", "version": "22.18.0", "digest": "sha256:…" }]
  },
  "observations": {               // what the environment claimed; never authoritative
    "reportedTools": [{ "name": "node", "version": "22.18.0" }]
  },
  "network": {
    "policy": "none|allowlist",
    "allow": [{
      "protocol": "tcp|udp",
      "destination": "registry.npmjs.org|203.0.113.0/24",
      "ports": [443],
      "dns": "deny|pin"          // pin ⇒ resolved at the control plane, addresses recorded here
    }],
    "authorization": "…"
  },
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

The definition named by `experimentDefinitionDigest` MUST declare at least one
mandatory condition (VD-12). A digest that resolves to an empty or absent condition
set is not executable and blocks before an environment exists.

## 8. Evidence and ledger model

### 8.1 Events

Append-only, one line per event, each carrying `seq`, `runId`, `at`, `type`, `data`
and `prevDigest`, with `digest` covering the canonicalised event. Event types:
`run_requested`, `policy_validated`, `environment_created`, `policy_verified`,
`execution_started`, `stream_truncated`, `limit_exceeded`, `execution_finished`,
`evidence_collected`, `cleanup_attempted`, `cleanup_finished`, `verdict_recorded`,
`run_aborted`, `reconciliation_completed`.

### 8.2 Evidence

- Hashed on receipt by the collector, outside the environment (EV-02).
- Bound to `runId` + `experimentDefinitionDigest` + manifest digest (EV-03).
- Stored outside any path the environment can reach or write (FS-05).
- Composition: stdout, stderr, normalized exit status, artifact list with digests,
  limit/termination events, environment inventory (mounts, network policy, tool
  identity) captured by the supervisor.

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
| `PASS` | **At least one** predefined mandatory condition exists and every declared condition is satisfied on authentic, `complete` evidence; termination `completed` or `failed` (a non-zero exit status is an observation, VD-04); no timeout, limit, cancellation or supervisor error; lifecycle state `clean`. An empty condition set can never produce `PASS` (VD-12). |
| `FAIL` | The run executed on authentic evidence and either at least one mandatory condition is demonstrably unsatisfied, or it was terminated by `timeout` or `limit`. Holds with lifecycle `clean` or `unsafe`. |
| `INCONCLUSIVE` | Evidence is authentic and integrity-`valid` but `insufficient` — at least one mandatory condition is `undecided` or `not_evaluated` — with termination `completed`/`failed` and lifecycle `clean`. Never used for tampering or missing evidence (VD-05, VD-09). |
| `BLOCKED` | Evidence integrity failed (missing or corrupted, §9.1 row 1); or isolation/policy failed; or execution never started; or the run was cancelled after it started; or the supervisor errored during or after execution; or lifecycle `unsafe` with no established failure. |

Rules that follow from R7 and are testable:

1. The process's own output — exit code, a `PASS` string, a JSON verdict, a JUnit
   file the program wrote — is **evidence**, never a verdict (VD-04).
2. Evidence **integrity** and evidence **completeness** are different judgements
   (VD-11). Integrity asks whether the record can be authenticated: artefacts present
   or their absence explained by an authenticated event, digests matching the ledger,
   binding to this run/experiment/manifest, chain verified. Completeness asks whether
   that authentic record decides every mandatory condition. Failure of integrity is
   `BLOCKED`; shortfall of completeness is `FAIL`, `INCONCLUSIVE` or `PASS` depending
   on the termination reason and lifecycle.
3. Absent evidence is never success (VD-05).
4. `timeout` and `limit` termination are `FAIL` whatever the output and whatever the
   cleanup state, because the truncation is authenticated (§9.1 row 5). The single
   exception is an integrity failure, which is decided earlier by row 1 (VD-06,
   §9.1 rule 2).
5. Evidence tampering is never `INCONCLUSIVE`. `INCONCLUSIVE` is reachable only with
   integrity `valid`, lifecycle `clean` and termination `completed`/`failed`; a digest
   mismatch, an unexplained absent artefact or a ledger verification failure is
   `BLOCKED` (VD-05, VD-09, VD-11).
6. Cleanup failure never upgrades a verdict and never erases a proven one: it makes
   the run unsafe (LC-04) and is decided by row 8 of §9.1, not by an exception applied
   afterwards.
7. Every verdict names the conditions it evaluated (at least one for `PASS`), the
   evidence digests used and the lifecycle state it was decided under.

### 9.1 Verdict precedence (deterministic)

Evaluation follows a single fixed order, cleanup and termination included, and the
first matching row decides. Rows may describe overlapping states — a `timeout` run can
also have unsafe cleanup, so rows 5 and 8 can both be true — and the ordering, not
disjoint row predicates, is what makes the outcome unique: the first match is the
verdict and no later row can change it. Every consistent combination of evidence
integrity, evidence coverage, condition outcomes, isolation outcome, termination
reason (+ phase) and cleanup state matches at least one row, and NT-13 is the test
that no cell falls through. There is no after-the-fact exception: cleanup is row 8,
not a correction applied to a verdict already chosen.

| Order | Condition | Verdict | Recorded alongside |
| --- | --- | --- | --- |
| 1 | **Evidence integrity failure** (VD-11): required artefact absent with no authenticated event explaining it, stored digest or binding mismatch, manifest verification failure, or ledger verification failure — with any termination reason and any lifecycle state | `BLOCKED` | integrity class `missing`/`corrupted`, offending artefact or event, lifecycle state |
| 2 | Isolation or policy failure: no environment, requested network/mount policy not established, unenforceable limit, image or provenance identity invalid/unavailable (HX-01, HX-05, NET-04, RES-08, IMG-01..IMG-08), or an invalid experiment definition — empty or absent mandatory-condition list (VD-12) | `BLOCKED` | the failed control id, lifecycle state |
| 3 | Execution never started: `cancelled` before execution started, or `supervisor_error` before execution started | `BLOCKED` | termination reason + phase, lifecycle state |
| 4 | At least one predefined mandatory condition demonstrably failed on authentic evidence — with **any** termination reason (`completed`, `failed`, `timeout`, `limit`, `cancelled`, `supervisor_error`) and any lifecycle state | `FAIL` | condition ids + evidence digests + termination reason + lifecycle state |
| 5 | Terminated by `timeout` or `limit`, evidence authentic — truncation or absence explained by the authenticated termination/`stream_truncated` events — with any lifecycle state | `FAIL` | limit/timeout id + measured usage + lifecycle state |
| 6 | Terminated by `cancelled` **after** execution started, and no failure established by row 4 | `BLOCKED` | termination `cancelled` + phase `after_execution`, lifecycle state |
| 7 | Terminated by `supervisor_error` **after** execution started, and no failure established by row 4 | `BLOCKED` | termination `supervisor_error` + phase, lifecycle state |
| 8 | Lifecycle state `unsafe` (after normalising `unknown`, rule 6) and no FAIL established by rows 4–5 | `BLOCKED` | lifecycle reason (`cleanup_failed`, `cleanup_unverified`, `supervisor_lost`) |
| 9 | Terminated by `completed` or `failed`, lifecycle `clean`, coverage `insufficient` — at least one mandatory condition `undecided` or `not_evaluated` | `INCONCLUSIVE` | undecided/not-evaluated condition ids + why |
| 10 | Terminated by `completed` or `failed`, lifecycle `clean`, coverage `complete`, **at least one** predefined mandatory condition and every one of them satisfied | `PASS` | condition ids + evidence digests + `cleanup_verified` |

Rules that make the table total, ordered and unambiguous:

1. **One order, first match wins.** Rows 1–10 are evaluated in the order shown; the
   first whose condition holds decides and later rows are not consulted. Rows 1–8 are
   safety rows that terminate evaluation; rows 9–10 are the only rows that decide an
   otherwise clean run.
2. **Integrity first, including over timeout.** A run killed by `timeout` or `limit`
   is `FAIL` (row 5) even though its output is short, because the shortfall is
   **authenticated**: the supervisor's termination event and the collector's
   `stream_truncated` event explain which bytes never existed. The one exception is an
   integrity failure — an artefact absent with no authenticated event explaining it, a
   digest/binding/manifest mismatch, or a ledger that does not verify — which row 1
   decides first, making the run `BLOCKED`. In short: *"the process was killed and its
   output is short" is incomplete output and stays `FAIL`; "the record of what
   happened cannot be authenticated" is an integrity failure and becomes `BLOCKED`.*
   No other exception exists.
3. **A proven failure outranks every late-stage state.** Row 4 is reached before rows
   5–8, so a demonstrable mandatory failure is `FAIL` even when the run was also
   cancelled, killed by a limit, ended in `supervisor_error`, or left an unsafe
   environment.
4. **`supervisor_error` never yields `PASS` or `INCONCLUSIVE`.** Before execution it
   is row 3 (`BLOCKED`); after execution started it is row 7 (`BLOCKED`) unless a
   failure is already proven (row 4). When the supervising process failed, the
   completeness of the collected evidence cannot be certified, so evidence that merely
   *appears* complete is not treated as complete.
5. **Cancellation has two phases, decided by different rows.** `cancelled` before
   execution started never produced a run: row 3, `BLOCKED`. `cancelled` after
   execution started is a withdrawn run and is never certified: row 6, `BLOCKED`. In
   both cases a failure already proven by row 4 still reads `FAIL`, so cancellation
   cannot hide a known failing condition. A cancelled run can never be `PASS`.
6. **`unknown` cleanup is normalised before evaluation.** Cleanup `unknown`
   (reconciliation incomplete, supervisor lost) is rewritten to `unsafe` with reason
   `cleanup_unverified` or `supervisor_lost` *before* the table is applied, so the
   verdict engine only ever sees `clean` or `unsafe`. The normalisation is recorded in
   the ledger and is itself tested (NT-13); `unknown` is never a third verdict input and
   never counts as success.
7. **Unsafe alone blocks.** With no failure or termination row above, `unsafe` matches
   row 8, so a run whose environment could not be cleaned can be neither `PASS` nor
   `INCONCLUSIVE`.
8. **`PASS` has exactly one door, and it is never vacuous.** Only row 10 produces
   `PASS`, and row 10 requires coverage `complete`, **at least one** predefined
   mandatory condition with every declared condition satisfied, termination
   `completed` or `failed`, and lifecycle `clean`. A definition with an empty or absent
   condition list is invalid (row 2, VD-12) and is rejected before execution; if it
   reaches the verdict engine anyway, the run is `BLOCKED`, because "all zero
   conditions are satisfied" would otherwise be a free `PASS`.
9. **Domains and totality.** The inputs are enumerated finite domains — evidence
   integrity `valid`/`missing`/`corrupted`; evidence coverage `complete`/`insufficient`;
   per-condition outcome `satisfied`/`failed`/`undecided`/`not_evaluated`, aggregated to
   `all_satisfied`/`failed`/`undecided`; isolation `ok`/`failed`; termination
   `completed`/`failed`/`timeout`/`limit`/`cancelled`/`supervisor_error` with a phase
   `before_execution`/`after_execution` for `cancelled` and `supervisor_error`; cleanup
   `clean`/`unsafe`/`unknown`, normalised by rule 6. `not_evaluated` is kept
   deliberately rather than folded into `undecided`: it distinguishes a condition the
   termination prevented from ever running (`timeout`, `limit`, cancellation) from one
   that ran but whose authentic evidence was not decisive. Both make coverage
   `insufficient` and both reach row 9, but the recorded reason differs and a reviewer
   needs it to tell an aborted run from an ambiguous one. The domains carry consistency
   constraints that are part of the definition: coverage is `complete` exactly when
   every condition is decided (`satisfied` or `failed`); `failed` requires authentic
   evidence; `cancelled` and `supervisor_error` always carry a phase; and the
   condition set has at least one member (`conditionCount ≥ 1`, VD-12), so the
   `all_satisfied` aggregate is never reached vacuously. Every consistent
   combination maps to exactly one row and NT-13 must enumerate all of them; a
   combination that matches none is a defect recorded as `BLOCKED`, never coerced to
   the nearest verdict.
10. Exactly one verdict is recorded per run, together with its inputs (integrity,
    coverage, conditions, isolation, termination + phase, lifecycle), and re-evaluating
    the same run yields the same row.

### 9.2 Termination reasons and their verdicts

LC-06 fixes six termination reasons. §9.1 maps each to exactly one verdict path; there
is no reason without a path, and no reason that can bypass a row.

| Termination (LC-06) | Recorded meaning | Verdict path |
| --- | --- | --- |
| `completed` | The program ended on its own and collection finished | Rows 9–10 by coverage and lifecycle; `FAIL` can only come from row 4 |
| `failed` | The program ended on its own with a non-zero/failed status | Identical to `completed`: exit status is an observation (VD-04), so the verdict follows conditions, coverage and lifecycle, never the status itself |
| `timeout` | The supervisor killed the run at `timeoutMs` | Row 5 `FAIL`; rows 4 (`FAIL`) or 1/2 (`BLOCKED`) if they match first |
| `limit` | The environment killed the run at the CPU, memory, PID, disk, stream or artifact cap | Row 5 `FAIL`, same exceptions |
| `cancelled`, phase `before_execution` | Withdrawn before any project process started | Row 3 `BLOCKED` |
| `cancelled`, phase `after_execution` | Withdrawn while running | Row 6 `BLOCKED`, unless row 4 proves a failure |
| `supervisor_error`, phase `before_execution` | Supervisor/provisioner failed before start | Row 3 `BLOCKED` |
| `supervisor_error`, phase `after_execution` | Supervisor, provisioner or control plane failed during the run or during teardown | Row 7 `BLOCKED`, unless row 4 proves a failure; never `PASS`/`INCONCLUSIVE`, and normally also `lifecycleState: unsafe` |

Two consequences worth stating because they are the easiest to get wrong: a `timeout`
with authentic truncation is a failure and must not be softened into `INCONCLUSIVE` or
hidden as `BLOCKED`; and a `supervisor_error` whose evidence happens to look complete
must not be promoted into `PASS`, because the component that would have attested
completeness is the one that failed.

The lifecycle state is a run property, not a verdict: `clean` or `unsafe`, with a
reason (`cleanup_failed`, `cleanup_unverified`, `supervisor_lost`). It is normalised
from `unknown` before evaluation (rule 6), recorded beside the verdict, and never
merged into it. Reports show it so that a `FAIL` in an unsafe environment is not read
as a clean one, and so that an unsafe `BLOCKED` is not read as a flaky test.

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
| NT-06 | Modify a stored evidence file; delete a required one; rewrite a ledger event; truncate the ledger; try to write evidence from inside the environment | All detected and classified as integrity failures: verdict is `BLOCKED`, never `PASS` or `INCONCLUSIVE` (EV-01, EV-02, EV-06, FS-05, VD-05, VD-09) |
| NT-07 | A test that prints `PASS`, writes a fake verdict file and exits 0, while a mandatory condition is unsatisfied | Verdict is not `PASS` (VD-03, VD-04, VD-05) |
| NT-08 | SIGKILL the supervisor mid-run; force a timeout with truncated output; force a cleanup failure on an otherwise clean run | Supervisor loss → `BLOCKED` + `unsafe` (row 7), never `PASS`; timeout with authenticated truncation → `FAIL` (row 5) even though the output is short; cleanup failure alone → `BLOCKED` (row 8); cleanup attempted and recorded in all three (LC-03, LC-04, RES-05, VD-06, VD-10) |
| NT-09 | Make a run start against a workspace that already contains a file, or re-request a previous environment id | Refused: fresh environment and empty workspace are required (LC-01, LC-02) |
| NT-10 | Provide a manifest with an unknown or misspelled key | Schema validation rejects it (CFG-01) |
| NT-11 | Run with a resource-limit bomb (fork bomb, allocation loop, infinite printer, artifact bomb) | Terminated at the cap; host unaffected; truncation recorded (RES-02..RES-07) |
| NT-12 | Force cleanup failure (and separately, unverifiable destruction and supervisor loss) on five runs: mandatory condition failed; timeout with authenticated truncation; complete evidence with all conditions satisfied; sufficient-but-undecided evidence; timeout whose evidence digest was altered after collection | `FAIL` + `unsafe` (row 4), `FAIL` + `unsafe` (row 5), `BLOCKED` + `unsafe` (row 8), `BLOCKED` + `unsafe` (row 8, not `INCONCLUSIVE`), and `BLOCKED` (row 1) for the altered digest — the one exception to "timeout is `FAIL`"; never `PASS`, lifecycle reason recorded in every case (VD-06, VD-07, VD-08, VD-11, LC-04) |
| NT-13 | Enumerate the full declared domain: integrity (`valid`/`missing`/`corrupted`) × coverage (`complete`/`insufficient`, consistent with condition decisions) × condition outcomes (`all_satisfied`/`failed`/`undecided`, including `not_evaluated`, over a **non-empty** condition set per VD-12) × isolation (`ok`/`failed`) × termination (all six reasons, with `cancelled` and `supervisor_error` in both phases) × cleanup (`clean`/`unsafe`/`unknown`), and compare every consistent cell against §9.1 | Exactly one verdict per cell, matching the first row whose condition holds; no cell unmatched; `unknown` cleanup normalised to `unsafe` before evaluation, so no cell depends on a third cleanup value; `timeout`/`limit` ⇒ `FAIL` except integrity failure ⇒ `BLOCKED`; `supervisor_error` never `PASS`/`INCONCLUSIVE`; `cancelled` never `PASS`; `PASS` only from row 10 with at least one condition; repeated evaluation idempotent (VD-07, VD-10, VD-11) |
| NT-14 | A tool inside the environment reports a version different from the SBOM | Identity stays the SBOM's; the difference is recorded as an observation; run does not gain trust from the claim (IMG-03) |
| NT-15 | Remove the provenance attestation; then present a mismatched signature | `BLOCKED` before environment creation (IMG-08) |
| NT-16 | Attempt DNS resolution and DNS-based exfiltration while network is denied | Resolution fails; no query leaves the environment; deny recorded (NET-01, NET-05) |
| NT-17 | Attempt IPv6 egress while network is denied | IPv6 connection fails exactly as IPv4 does (NET-01) |
| NT-18 | Inspect the environment for `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | Variables are absent unless explicitly authorized (FS-06, NET-01) |
| NT-19 | Request `169.254.169.254`, `fd00:ec2::254` and the equivalent metadata names, with and without an egress allowlist | Unreachable in both cases; the attempt is recorded (NET-06) |
| NT-20 | SIGKILL the supervisor mid-run, then restart the control plane | Reconciler discovers the leftover environment, destroys it, marks the run unsafe, and blocks new runs until reconciliation completes (LC-07, LC-08) |
| NT-21 | Make environment destruction unverifiable, then attempt to allocate a new run | Environment quarantined, listed for the operator, never reused (LC-09, LC-10) |
| NT-22 | Fail the supervisor/provisioner after execution started while the collected evidence looks complete and every condition appears satisfied | `BLOCKED` (row 7) + `unsafe`, never `PASS` or `INCONCLUSIVE`; the same scenario with a demonstrably failed condition is `FAIL` (row 4) (VD-10, LC-06) |
| NT-23 | Take one timeout run with `stream_truncated` output and tamper with it in three ways: alter a stored artefact digest; delete a required artefact while removing the termination event; present evidence bound to another run | All three are integrity failures — `BLOCKED` (row 1), never `INCONCLUSIVE` — and are distinguished from the untouched truncated run, which stays `FAIL` (row 5) (VD-11, VD-05, EV-02, EV-03, EV-06) |
| NT-24 | Submit an experiment definition with `conditions: []`; submit a second with the `conditions` field omitted; then hand the verdict engine a definition digest that resolves to an empty condition set | Both definitions are rejected before execution (`BLOCKED`, no environment created, ledger records the rejection); the empty set at evaluation yields `BLOCKED`, never `PASS` or `INCONCLUSIVE`, and no `PASS` is ever recorded without at least one condition id (VD-12, VD-03) |

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

**Current CI is not control evidence.** The repository's existing 250 tests exercise
import, durable storage, static analysis and architecture intelligence. None of them
starts an execution environment, and none exercises a control in §5. A green
`npm ci` / `typecheck` / `build` / `test` run shows that the product still behaves; it
is not evidence that any isolation requirement is implemented, and must never be
reported as such. The acceptance suite for an execution engine is §10 and nothing
else.

### 11.1 Sequencing

The phase order is binding, not advisory:

1. **2C — experiments and runs, domain only.** Experiment and run records, their
   states and artifacts may be modelled and persisted. **No project code executes**,
   and every run records `NOT_TESTED` or `BLOCKED`.
2. **3A — this specification.** Must be accepted before any executor work begins.
3. **3B — isolation runtime decision.** A separate ADR selects container or microVM
   isolation from measured evidence. Still no executor.
4. **3C — isolated execution engine.** Implements the controls here and is conformance
   tested against them. A PR that adds execution before 3A and 3B are accepted is out
   of order and must be rejected, exactly as ADR-0005 requires.

No phase may claim `PASS` from a run until 3C satisfies §11.

## 12. Open questions for Phases 3B and 3C

- Which isolation family (container vs microVM) satisfies §5 with the least operator
  burden, supported by measured evidence?
- Where does the ledger head get witnessed so truncation is detectable across hosts?
- Do artifacts need their own provenance attestation, or is collector hashing plus
  run binding sufficient for v1?
- How are toolchain images built and rebuilt reproducibly, and who reviews their
  scans?
- What is the operator recovery procedure for a quarantined environment in practice
  (inspect → destroy → document), and who may authorize it?
