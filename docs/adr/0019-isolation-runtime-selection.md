# 0019 — Isolation runtime selection for the execution engine

- Status: **Proposed — runtime product selection pending the benchmark in
  [the protocol](../security/runtime-benchmark-protocol.md).** Phase 3C may not start
  until this ADR is `Accepted` (ADR-0018 decision 11).
- Date: 2026-11-17
- Depends on: [0005](0005-execution-isolation.md), [0006](0006-evidence-integrity.md),
  [0018](0018-execution-control-plane-and-sandbox-boundaries.md)
- Answers: [specification](../security/execution-safety-specification-v1.md) §6, §11.1, §12
- Detail: [control mapping](../security/runtime-control-mapping.md) ·
  [benchmark protocol](../security/runtime-benchmark-protocol.md)
- Adds: **no code.** No runtime, launcher, dependency or executor is introduced here.

## 1. Context

ADR-0005 forbids executing project code on the host; ADR-0018 fixes the control plane,
the verdict precedence and the evidence model; the Phase 3A specification turns those
into 72 controls and 24 negative tests. All three leave **which isolation technology**
open, and ADR-0018 requires that choice to carry measured evidence rather than
familiarity. The candidates are not variations of one design:

- A **rootless container** is a process tree inside the host kernel, bounded by
  namespaces, cgroups, seccomp/LSM and a user namespace.
- A **microVM** is a process tree inside a different kernel, bounded by the VMM and KVM;
  the guest kernel is not the host kernel.

This ADR may not claim that any candidate is "secure", and does not. MicroVMs move the
attack surface rather than remove it: the VMM is still a host process making host
syscalls, and an independent study found Firecracker executes substantially more kernel
code than a native process [S20]. Vendor statements are cited for mechanisms, never as
proof of security. No number below was measured by VOLDBASE.

### 1.1 Why this decision is `Proposed`

| Question | Decidable from documents? | Status |
| --- | --- | --- |
| Does the boundary keep hostile code out of the host kernel? | Yes, architecturally | **Decided** (§2.1) |
| Which microVM implementation is operationally viable for a local CLI? | No — needs start, overhead, density, cleanup and operator measurements | **Pending** |
| Are limits enforced at the declared values? | Mechanism documented; fidelity is not | **Pending** |

The specification requires startup cost, resource-accounting fidelity and operator
burden to be measured (§6), and conformance against the real isolation path (§11).
Measuring needs a host with `/dev/kvm`, installed runtimes and a harness — none of which
this documentation phase may add. The honest state is a decided *family*, a provisional
*implementation* preference, and a binding protocol for the rest.

## 2. Decision

### 2.1 Gate G1 — the untrusted environment requires a dedicated guest kernel

A rootless container shares the host kernel; its boundary is namespaces, cgroups,
seccomp/LSM and a user namespace [S17]. Rootless bounds what a successful escape is
worth — the attacker lands as the invoking user, not host root — but not whether a
kernel or runtime bug is exploitable from inside. VOLDBASE's threat model (T-01, T-10)
assumes project code is adversarial and treats kernel escape as the primary residual.
Under that assumption a shared kernel puts the host kernel, and therefore the user's
files, keys and network, inside the attack surface of every run.

This is a **risk-acceptance judgement from documented architecture**, not a measurement
and not proof that microVMs are safe. It is recorded as a gate, not as one weighted
criterion, so strengths elsewhere cannot average it away.

Consequence: rootless **Podman** and **Docker** are not eligible as the sole isolation
boundary. They remain useful as the benchmark baseline (to price what isolation costs)
and as tooling for producing digest-pinned filesystem images, which Firecracker needs
anyway. Neither use puts project code on the host.

### 2.2 Provisional implementation preference: Firecracker

Among the two eligible candidates, Firecracker has the smaller host-resident surface and
the better documented envelope:

- one process per microVM, with the `jailer` performing `pivot_root`/`chroot`, cgroup
  placement, `setrlimit`, UID/GID drop and optional new PID and network namespaces
  before the VMM runs [S8][S9];
- a minimal device model — `virtio-net`, `virtio-block`, `virtio-vsock`, serial, a
  minimal keyboard controller and `virtio-balloon` in current releases — with no GPU and
  no general-purpose device model [S12];
- published figures: `<= 125 ms` from `InstanceStart` to guest `/sbin/init`, measured
  with a minimal kernel and rootfs and the serial console disabled [S10]; `< 5 MiB`
  overhead and up to 150 microVMs/s/host in the NSDI'20 paper [S11]. Both are
  vendor-published measurements on AWS's workload, graded `V`.

**Kata is not rejected.** It is eligible and is the fallback if Firecracker fails a hard
budget. Its documented costs: every supported VMM needs KVM [S13]; `/dev/kvm` must be
accessible to `root` or the `kvm` group, on bare metal or a nested-virtualization host
[S14]; even in rootless-VMM mode only the VMM drops privileges while the shim and
`virtiofsd` stay root [S16]; host networking and network-namespace sharing are
unsupported [S15]; and cgroup-style limits must be applied at guest-kernel, in-guest and
hypervisor levels, which the project itself calls "not always straightforward" [S15].

### 2.3 The runtime stays unselected until the protocol is executed

`Proposed` is not a formality. This ADR becomes `Accepted` only when a benchmark report
produced by [the protocol](../security/runtime-benchmark-protocol.md) is attached to a
follow-up change, its gates are evaluated, and the result is reviewed. Until then:

- Phase 3C may not implement an executor (ADR-0018 decision 11, specification §11.1).
- No code may depend on Firecracker, Kata, Podman or Docker, and none may be added to
  `package.json`.
- A gate failure promotes Kata or supersedes this ADR. It is never resolved at runtime
  by falling back to a weaker path (ADR-0018 decision 2).

### 2.4 Execution is Linux-with-KVM only until a second backend is accepted

Firecracker requires Linux and KVM [S8][S9]; Kata requires KVM [S13][S14]. On macOS and
Windows, Podman runs containers inside a managed Linux VM [S5] — a VM boundary, but a
*different* backend with different evidence. Phase 3C therefore supports one host class:
Linux x86_64/aarch64 with `/dev/kvm` and cgroup v2. Elsewhere execution is refused
before an environment exists (`BLOCKED`, `isolation_unavailable`, HX-01). Import,
analysis and architecture intelligence are unaffected; they never execute project code.
macOS execution, if ever required, needs its own ADR and its own measurements.

### 2.5 Controls keep their enforcement boundaries

The runtime is a mechanism; it does not move authority. The environment still holds
authority over nothing (ADR-0018 decision 1). The
[control mapping](../security/runtime-control-mapping.md) records, for every control
group, the mechanism each candidate provides, how it is verified, and where an
additional control-plane component is required. Every control has exactly one
classification per candidate.

## 3. Consequences

- **Portability narrows.** Linux+KVM is a hard requirement for execution. A macOS user
  can analyse but not execute locally; that must be documented, not discovered.
- **Firecracker is OCI-incompatible.** Its block devices are host files pre-formatted
  with a guest-supported filesystem [S8]; there is no native OCI image support. VOLDBASE
  must build a digest-pinned rootfs from an OCI image and satisfy IMG-01..IMG-08 against
  *that* digest. Most are Control Plane obligations that carry over unchanged; IMG-05
  (signature of a locally built artifact) and IMG-08 (provenance for the conversion step)
  need components that do not exist yet (§7).
- **Privileged residual surface shrinks, not vanishes.** One jailed VMM process per run
  replaces a runtime, a shim and a filesystem daemon; KVM and the host kernel remain in
  the trusted computing base [S20].
- **Limits need translation.** Guest PIDs are not host PIDs; `memoryBytes` is guest RAM
  plus VMM overhead; disk is a block-device size. Every mapping must be recorded and
  verified from outside.
- **Cleanup becomes multi-resource.** A run owns a VMM process, jail directory, TAP,
  cgroup and block files. Firecracker states cleanup is the caller's job [S9], so the
  reconciler (LC-07..LC-10) is the only thing that makes LC-09 verifiable.
- **The decision reverses only by a new ADR**, with the conformance suite re-run.

## 4. Evidence ledger

Grades: `D` primary documentation (mechanism, requirement, limitation); `P` peer-reviewed
measurement; `V` vendor-published measurement on the vendor's workload; `A` assumption to
be tested. No claim here is a VOLDBASE measurement.

| Claim | Grade | Source |
| --- | --- | --- |
| Default `runc` containers share the host kernel and rely on namespaces, cgroups and seccomp | `D` | [S17] |
| Docker rootless runs daemon and containers in a user namespace, needing `newuidmap`/`newgidmap` and subordinate IDs | `D` | [S1] |
| Docker rootless supports cgroup limits only with cgroup v2 + systemd; otherwise it **ignores** cgroup flags | `D` | [S3] |
| Docker rootless does not support AppArmor or overlay networks | `D` | [S2] |
| Rootless Podman always uses a user namespace; `pasta` is the default rootless network mode | `D` | [S4] |
| Podman network mode `none` creates a netns with no interfaces and no connectivity | `D` | [S6] |
| Podman on macOS/Windows requires a Linux VM (`podman machine`) | `D` | [S5] |
| Rootless limits depend on cgroup v2 delegation to the user, which is not automatic | `D` | [S21] |
| Firecracker runs on Linux hosts with Linux guests, one process per microVM, using KVM | `D` | [S8] |
| Firecracker's device model is minimal; network is TAP-backed, storage is host files | `D` | [S8][S12] |
| The jailer provides chroot/pivot_root, cgroups, rlimits, UID/GID drop, namespaces, and leaves cleanup to its caller | `D` | [S9] |
| `<= 125 ms` boot is measured with a minimal kernel/rootfs and the serial console disabled | `D` | [S10] |
| `< 5 MiB` overhead and 150 microVMs/s/host | `V` | [S11] |
| Kata runs each pod in a VM with its own guest kernel; all supported VMMs use KVM | `D` | [S13] |
| Kata needs `/dev/kvm` for root or the `kvm` group, on bare metal or nested virtualization | `D` | [S14] |
| In Kata rootless-VMM mode only the VMM is unprivileged; shim and `virtiofsd` stay root | `D` | [S16] |
| Kata does not support host networking or netns sharing; limits are multi-level | `D` | [S15] |
| A runc file-descriptor leak (CVE-2024-21626) allowed host filesystem access and host binary overwrite | `D` | [S18] |
| Small VMs can approach container instantiation times with a trimmed guest and toolstack | `P` | [S19] |
| Firecracker and gVisor execute substantially more kernel code than a native process | `P` | [S20] |
| The Firecracker API socket and vsock are unreachable from the guest unless a device is configured | `A` | [S8][S12] |

## 5. Gates

**G1 — isolation boundary (disqualifying).**

| Candidate | Boundary | Shares host kernel? | G1 |
| --- | --- | --- | --- |
| Podman rootless | user/mount/PID/net/IPC namespaces, cgroups, seccomp, LSM [S4][S17] | **Yes** | **Fail** |
| Docker rootless | same class plus RootlessKit and a per-user daemon [S1][S3] | **Yes** | **Fail** |
| Firecracker | separate guest kernel, one jailed VMM process per microVM [S8][S9] | No | Pass |
| Kata Containers | separate guest kernel per pod, shim + VMM [S13] | No | Pass |

A container escape is not hypothetical: CVE-2024-21626 was a *runtime* file-descriptor
leak that gave a container process host filesystem access and host binary overwrite
[S18]. That is the point of the gate — the boundary has more host-resident moving parts
and each is a path to the host. Rootless is a genuine mitigation (never run rootful), but
it bounds impact and leaves exploitability unchanged. MicroVMs do not eliminate the class
either: VMM and KVM vulnerabilities remain [S20], recorded as residual in §8.

**G2 — enforceable, measurable controls.** A candidate that cannot express a control is
ineligible regardless of score. All three express the control groups in principle, with
different verification burdens:

| Control group | Podman rootless | Firecracker | Kata |
| --- | --- | --- | --- |
| HX-01..05 | expressible (no socket mounted) | expressible (no socket in guest) | expressible |
| NET-01..06 | `--network=none` [S6]; allowlist needs host rules | no NIC unless configured [S8] | expressible, more moving parts [S15] |
| FS-01..07 | expressible; fuse/overlay quirks | block devices only, no bind mounts | virtio-fs sharing must be audited |
| RES-01..08 | conditional on cgroup v2 delegation [S3][S21] | needs translation (guest PIDs) | multi-level [S15] |
| IMG-01..08 | native OCI digests | gaps at IMG-05, IMG-08; the rest carry over to a derived rootfs (§7) | native via manager |
| EV/VD | host-observable, no agent | export disk or vsock | agent-mediated |
| LC-01..10 | labels + `rm -f`; storage leftovers | five resource kinds [S9] | shim + VMM + virtiofsd + netns |

## 6. Decision matrix

### 6.1 Method

- **Scale 1–5** on documented capability for this use case (single run, untrusted, local
  CLI, no reuse): 1 = cannot meet without a new component; 3 = meets with documented
  caveats needing verification; 5 = meets directly with a clean verification path.
- **Weights fixed before scoring**, summing to 100, following the binding Phase 3A
  priorities: boundary quality, then limit and lifecycle enforceability, then
  operational cost.
- **Judgements, not measurements.** §6.2 states the basis for each score; §9 item 11
  requires two independent reviewers before acceptance.
- **Gates precede totals.** An ineligible candidate's total is shown only to make the
  cost of the gate visible.

### 6.2 Scores

| # | Criterion | W | Podman | Docker | Firecracker | Kata | Basis |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Isolation boundary, escape surface (G1) | 16 | 2 | 2 | 5 | 5 | shared vs separate kernel [S17][S8][S13] |
| 2 | Kernel sharing and patch surface | 8 | 2 | 2 | 4 | 4 | runtime bugs reach the host [S18]; microVM still patches host KVM/VMM [S20] |
| 3 | Network isolation incl. DNS/IPv6 | 9 | 4 | 3 | 4 | 3 | [S6][S2][S8][S15] |
| 4 | Filesystem and mount isolation | 9 | 4 | 4 | 4 | 3 | bind mounts vs block devices vs virtio-fs |
| 5 | CPU/memory/PID/disk limit fidelity | 10 | 3 | 2 | 3 | 2 | [S3][S21][S15] |
| 6 | Startup latency and memory overhead | 8 | 5 | 4 | 4 | 2 | container baseline; vendor figures [S10][S11]; Kata boots a VM + agent |
| 7 | Density and concurrent runs | 5 | 5 | 5 | 4 | 3 | [S11][S13] |
| 8 | Cleanup and reconciliation | 9 | 4 | 3 | 4 | 3 | [S9]; Docker adds daemon state; Kata adds shim/virtiofsd |
| 9 | Evidence collection outside the env | 6 | 5 | 4 | 3 | 3 | host cgroup/proc vs export disk vs agent |
| 10 | Image identity, provenance, SBOM | 6 | 5 | 5 | 2 | 4 | OCI native [S4] vs pre-formatted blocks [S8]; derived-rootfs gaps at IMG-05 and IMG-08 |
| 11 | Operational complexity, maintainability | 10 | 5 | 2 | 2 | 1 | daemonless binary vs kernel/rootfs/jailer vs Kubernetes shims |
| 12 | Control-plane compatibility | 4 | 4 | 3 | 4 | 2 | per-VM REST API [S8] vs CRI orientation [S13] |
| | **Weighted total /100** | **100** | **75.4** | **60.2** | **73.6** | **60.8** | `Σ(W × score) / 5` |

Podman 75.4 and Docker 60.2 are **ineligible** despite their totals, because criterion 1
fails G1. Among eligible candidates the order is **Firecracker 73.6, Kata 60.8**.

### 6.3 What the matrix does and does not say

- The 12.8-point gap between eligible candidates comes from mechanisms, not taste:
  Firecracker needs no shim, agent or filesystem daemon on the host and its API maps
  one-to-one onto a per-run supervisor. Its one serious weakness is OCI image handling,
  which is why the derived-rootfs attestation in §9 item 4 is a prerequisite.
- The matrix **cannot** choose between isolation families: the criterion that separates
  them is a gate, not a weight. A total that appeared to decide it would be the disguised
  judgement this ADR must avoid.
- A totals-only reading favours Podman (75.4). That is the honest price of G1: containers
  win on latency, density, image handling and operational simplicity, and lose the one
  property a tool running hostile code cannot trade. Disagreement should be with G1,
  explicitly, not with the arithmetic.

### 6.4 Sensitivity

| Scenario | Result |
| --- | --- |
| Weights ±25% within groups | Firecracker stays ahead of Kata; Kata leads only on image handling |
| Isolation weight doubled, ops halved | Firecracker's lead widens; Podman's total falls furthest |
| Latency/density/ops weights doubled | Podman overtakes both microVMs — the gate alone holds the decision |
| G1 removed | 75.4 vs 73.6: a 1.8-point gap that coarse judgement cannot resolve. This is why the protocol measures the container baseline too, even though it cannot overturn G1 |
| Two-point measured shift | Moves a total by 3–4 points, so a measured reversal of the eligible ranking is possible and is re-examined openly |

## 7. Control mapping

Full tables, per candidate and per control group, are in the
[control mapping appendix](../security/runtime-control-mapping.md). Summary of gaps that
would need work before 3C:

| Candidate | Gaps requiring an extra component | Class |
| --- | --- | --- |
| Podman rootless | limit enforcement only with cgroup v2 delegation; runtime-socket and mount policy verification; reconciliation of storage leftovers | E+V |
| Firecracker | **RES-03** guest PID enforcement (the host cgroup bounds only VMM threads); **IMG-05** signing of a locally built rootfs; **IMG-08** provenance for the conversion step | G (3 controls) |
| Firecracker | evidence export path and observed-policy comparison | E+V |
| Kata | **CP-01..05** CRI-oriented interface needs a control-plane adapter; three-level limit verification; sharing audit | G / E+V |

Per-limit enforcement — which component enforces each limit and how a reviewer proves it
from outside — is tabulated in the
[control mapping](../security/runtime-control-mapping.md) §2.1. A limit whose enforcement
cannot be established is `BLOCKED` (RES-08), never assumed. Image controls are classified
one by one in the same appendix: only IMG-05 and IMG-08 need new components, and the rest
are Control Plane obligations that carry over to a derived rootfs.

Controls **no** candidate enforces by itself — CP-04 observed-policy comparison,
EV-02..08 evidence hashing and chain verification, VD-01..12 the verdict engine,
LC-07..10 reconciliation and quarantine, IMG-04..08 scan/signature/provenance — remain
Control Plane responsibilities under every option. A runtime cannot be evidence for its
own configuration; that is why ADR-0018 separates the six components.

## 8. Rejected alternatives and residual risks

| Alternative | Why rejected |
| --- | --- |
| Docker rootless | Same shared-kernel boundary (G1 fail) with more host machinery: per-user daemon, RootlessKit, no AppArmor, no overlay networks, cgroup flags silently ignored without cgroup v2+systemd [S1][S2][S3]. Dominated by Podman for a local CLI, and adds a socket API to guard. |
| Rootful Podman/Docker | Host root inside the runtime; forfeits every rootless mitigation and violates HX-05/FS-01. |
| Rootless containers as sole boundary | G1: rootless bounds impact, not exploitability [S17][S18]. |
| gVisor | Not evaluated here. It has a real isolation story, but syscall compatibility with arbitrary Node/npm toolchains needs its own evidence and ADR; naming it would imply a comparison this document did not perform. |
| Cloud sandbox APIs | Violate ADR-0004 (local-first) and NET-01 by making the network a dependency of every run, and put a third party in the evidence path. Revisit under Phase 4. |
| WASM/WASI | Cannot run an arbitrary Node/npm toolchain. |
| chroot/namespaces/seccomp alone | No kernel boundary at all; fails G1 by a wider margin than rootless containers. |
| One full VM per run on QEMU/Cloud Hypervisor | Legitimate microVM option, but a broader device model and larger host surface for the same isolation class; not shortlisted for v1. |
| Warm microVM pool / workspace reuse | Forbidden by LC-01, LC-02 and ADR-0018 decision 3; leftovers are unrecorded inputs. |
| Fall back to containers when KVM is absent | A second, weaker path that would be exercised constantly. ADR-0018 decision 2 forbids it; the correct outcome is `BLOCKED`. |

Residual risks of the selected family, recorded rather than minimised:

1. **VMM/KVM vulnerabilities** — a VMM escape is a host compromise. Pin the VMM version,
   track its advisories, keep the jailer mandatory, treat a VMM CVE as stop-ship.
2. **Host kernel surface via the VMM** — the VMM is a host process making host syscalls
   [S20]. Seccomp, a minimal host kernel and no co-tenant services are the mitigations.
3. **Guest kernel and rootfs supply chain** — the conversion step is a new place to
   introduce unreviewed bytes. IMG-01..08 must cover derived images.
4. **Accounting fidelity** — guest memory and PIDs are not host cgroup values; an
   unmeasurable limit is `BLOCKED` (RES-08), not assumed.
5. **Host denial of service** — verified by concurrent-load trials, not by flags.
6. **Operator burden** — `/dev/kvm`, a jailer, a kernel image and a rootfs builder is a
   heavier install than a container runtime. A real cost, scored in criterion 11.
7. **Platform exclusion** — macOS and Windows cannot execute until a second backend is
   accepted (§2.4). Users will notice.
8. **Cleanup ownership** — Firecracker leaves cleanup to its caller [S9]; a supervisor
   crash leaves a VMM, jail, TAPs and cgroups behind. LC-07/LC-09 exist for this.

## 9. Prerequisites for Phase 3C

Phase 3C may not create an executor until all of these exist as reviewable artifacts:

1. **This ADR is `Accepted`**, with the benchmark report attached, reviewed, and the
   chosen runtime named explicitly in the Accepted revision.
2. **Supported-host specification**: Linux x86_64/aarch64, kernel range, `/dev/kvm` and
   permissions, cgroup v2 with delegation, minimum RAM/disk, and the preflight checks
   that produce `BLOCKED` otherwise.
3. **Pinned runtime artifacts**: VMM binary digest, guest kernel digest, rootfs digest,
   conversion-tool version, each with recorded provenance and scan result (IMG-04..08).
4. **Derived-image pipeline specified**: OCI image by digest → rootfs → recomputed SBOM →
   provenance attestation → recorded digest. The OCI digest is not the execution identity
   after conversion (IMG-01, IMG-06).
5. **Resource-translation table** mapping every manifest limit to a concrete mechanism and
   an external measurement, including guest PID semantics and memory headroom.
6. **Frozen control-plane contract**: create/observe/destroy only, run-scoped
   authentication, no verdict or evidence authority, observed-vs-requested comparison
   before start (CP-01..CP-05).
7. **Reconciler design**: label scheme, the five resource kinds, restart procedure and
   quarantine procedure (LC-07..LC-10, NT-20, NT-21).
8. **Evidence path specified**: export mechanism, size bounds, hashing outside the
   environment, and why the export path cannot become a control channel (EV-02, FS-05).
9. **Network policy specified** for default-deny and allowlist, including DNS pinning at
   the Control Plane, IPv6 deny and metadata blocking (NET-01..NET-06).
10. **NT-01..NT-24 mapped to runtime-specific harness steps**, each with an owner and an
    expected evidence artifact. A control without a test is unimplemented.
11. **Two independent reviewers** have scored §6 and reconciled differences.
12. **No executor code exists** in the 3C branch when review starts (ADR-0018 decision 11).

None of these is satisfied today. This ADR is documentation: the benchmark has not been
executed, no report exists, and no independent review is recorded in the repository. Item
11 is a prerequisite for acceptance, not a completed step, and nothing in this branch may
be read as evidence that it happened.

## 10. Benchmark

The binding protocol — hosts, runtime identity, the controlled probe environment,
immutable images, benign workloads, cold and warm start, memory and density trials,
cleanup, network default-deny and allowlist verification, filesystem boundaries, trial
counts, reporting rules, gates and preliminary targets, and the decision rule — is in
[the benchmark protocol](../security/runtime-benchmark-protocol.md). It has not been
executed; no runtime is selected until it is.

## 11. What would change this decision, and what remains open

What would legitimately reopen it:

- Peer-reviewed evidence that rootless containers with seccomp/LSM resist the kernel and
  runtime escape classes motivating G1. That reopens G1, not the arithmetic.
- A product requirement for execution on macOS or Windows. That needs a second backend and
  its own ADR; it does not justify a shared-kernel fallback on Linux.
- Firecracker failing the protocol's gates, which promotes Kata, not Podman.
- A documented, reviewed risk acceptance of shared-kernel execution in exchange for
  portability and latency. Legitimate, but it must be signed as a risk acceptance, not
  presented as an equivalent security posture.

Open questions:

1. Which Firecracker and guest-kernel versions are pinned for 3C, and who reviews advisories?
2. How is the OCI→rootfs conversion reproducible, and which tool produces the digest that
   IMG-01 will treat as identity?
3. Is a one-way export block device sufficient at 1 MiB stream bounds, or is a bounded
   vsock stream needed for live termination events?
4. How is `memoryBytes` translated when the VMM itself needs memory — fixed allowance,
   balloon minimum, or cgroup headroom?
5. Is the PID limit enforced in the guest, by the VMM thread bound, or both, and what does
   the verdict record?
6. Does the reconciler own TAP cleanup, or the host network manager? Both would be a gap
   under LC-09.
7. Is macOS execution required for V0.1? If yes, §2.4 is a product blocker.
8. What is the reference-host procurement plan, given a nested VM is not a pass criterion?

## 12. Sources

All accessed **2026-11-17**; grades as in §4. Vendor documentation is cited for mechanisms
and limitations, never as proof of security; the peer-reviewed sources are cited for
measurements on *their* workloads, not VOLDBASE's.

| Ref | Source | Grade |
| --- | --- | --- |
| S1 | Docker Docs — Rootless mode. https://docs.docker.com/engine/security/rootless/ | `D` |
| S2 | Docker Docs — Rootless mode: known limitations. https://docs.docker.com/engine/security/rootless/troubleshoot | `D` |
| S3 | Docker Docs — Rootless tips: limiting resources, cgroup v2 + systemd, flags ignored otherwise. https://docs.docker.com/engine/security/rootless/tips | `D` |
| S4 | Podman — `podman run(1)`: user namespaces, rootless mapping, `pasta` default. https://docs.podman.io/en/latest/markdown/podman-run.1.html | `D` |
| S5 | Podman — `podman machine(1)`: macOS/Windows require a VM. https://docs.podman.io/en/latest/markdown/podman-machine.1.html | `D` |
| S6 | Red Hat Enterprise Linux 10 — Communicating among containers: network mode `none`. https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/building_running_and_managing_containers/communicating-among-containers | `D` |
| S7 | Podman blog — rootless containers and cgroup v2 (subordinate ID ranges). https://podman.io/blogs/2019/10/29/podman-crun-f31 | `D` |
| S8 | Firecracker — design: Linux host/guest, one process per microVM, TAP networking, block devices as host files. https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md | `D` |
| S9 | Firecracker — jailer: chroot/pivot_root, cgroups, rlimits, UID/GID drop, namespaces, caller-owned cleanup. https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md | `D` |
| S10 | Firecracker — specification: `<= 125 ms` boot and its measurement conditions. https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md | `D` |
| S11 | Agache et al., "Firecracker: Lightweight Virtualization for Serverless Applications", NSDI 2020. https://www.usenix.org/system/files/nsdi20-paper-agache.pdf | `V` |
| S12 | Firecracker — FAQ: device model and footprint. https://github.com/firecracker-microvm/firecracker/blob/main/FAQ.md | `D` |
| S13 | Kata Containers — virtualization design: per-pod VM, guest kernel, KVM for all VMMs. https://kata-containers.github.io/kata-containers/design/virtualization/ | `D` |
| S14 | Kata Containers — installation prerequisites: virtualization extensions, `/dev/kvm`, root or `kvm` group. https://kata-containers.github.io/kata-containers/installation/ | `D` |
| S15 | Kata Containers — limitations: host networking, namespace sharing, multi-level resource constraints. https://kata-containers.github.io/kata-containers/Limitations | `D` |
| S16 | Kata Containers — rootless VMM: only the VMM is unprivileged; shim and `virtiofsd` remain root. https://kata-containers.github.io/kata-containers/how-to/how-to-run-rootless-vmm/ | `D` |
| S17 | Kata Containers — quick start: `runc` containers share the host kernel. https://kata-containers.github.io/kata-containers/quick-start-guide | `D` |
| S18 | NIST NVD — CVE-2024-21626 (runc file-descriptor leak, container escape). https://nvd.nist.gov/vuln/detail/CVE-2024-21626 | `D` |
| S19 | Manco et al., "My VM is Lighter (and Safer) than your Container", SOSP 2017. https://dl.acm.org/doi/10.1145/3132747.3132763 | `P` |
| S20 | Vanga et al., "Blending containers and virtual machines: a study of Firecracker and gVisor", VEE 2020. https://dl.acm.org/doi/10.1145/3381052.3381315 | `P` |
| S21 | Linux kernel documentation — Control Group v2, delegation. https://docs.kernel.org/admin-guide/cgroup-v2.html | `D` |
