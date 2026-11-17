# Runtime control mapping (Phase 3B appendix)

- Status: **Appendix to [ADR-0019](../adr/0019-isolation-runtime-selection.md).**
- Date: 2026-11-17
- Scope: documentation only. No runtime, launcher, dependency or executor is added.

This appendix answers one question for each candidate in ADR-0019: **which Phase 3A
controls can it enforce, by what mechanism, and how would a reviewer verify that?**
It is referenced from ADR-0019 §7 and must be read with the
[execution safety specification](execution-safety-specification-v1.md), which defines
the control ids, the threat model and the negative tests.

Classes: **E** = enforced by the runtime mechanism; **E+V** = enforceable, but only with
an independent control-plane verification step; **G** = gap requiring an additional
component or a specification amendment before Phase 3C.

Each control appears exactly once per candidate. Where a range is shown, every control
in it has the same classification and the same mechanism; a control that differs is
listed separately. Nothing here claims that any control is implemented today. VOLDBASE
has no executor.

## 1. Podman rootless (benchmark baseline; not eligible as sole boundary)

| Controls | Mechanism | Verification | Class |
| --- | --- | --- | --- |
| HX-01, HX-03 | Control Plane refuses runs without a provisioned environment; no bypass flag exists | NT-01, option enumeration | E+V |
| HX-02 | No `child_process` path; Podman invoked only through the supervisor | static import test + audit trace | E |
| HX-04, HX-05 | No runtime socket mounted; run-scoped supervisor credential | NT-03 environment inventory | E |
| NET-01, NET-16..19 | `--network=none` gives a netns with no interfaces | case A: W8–W11, `path_absent`, zero packets on every capture point; case B: W17 `denied_at_policy` with a boundary packet and drop counter | E |
| NET-02..06 | Allowlist netns plus host nftables; DNS resolved and pinned at the Control Plane | observed policy equals requested before start (CP-04); W14; W15 with the hostname attempt as case B (`denied_at_policy`) | E+V |
| FS-01..07 | Mount allowlist, fresh workspace, read-only rootfs, evidence outside | NT-03, NT-09, store inventory | E |
| RES-01..08 | cgroup v2 with delegated controllers; the container's `pids.max` is the guest's PID limit | preflight reads `cgroup.controllers` and the applied values; absent ⇒ `BLOCKED` (RES-08) | E+V |
| IMG-01..08 | OCI digest identity, signature and SBOM tooling | NT-05, NT-14, NT-15 | E |
| EV-01..08, VD-01..12 | Collector outside; no verdict path inside the environment | NT-06, NT-07, NT-13, NT-24 | E |
| LC-01..10 | Labels plus `rm -f`; storage and volume leftovers reconciled | NT-09, NT-20, NT-21 | E+V |
| CP-01..05, CFG-01..03 | Narrow CLI, policy compared before start | CP-04 pre-flight | E+V |

Residual: kernel and container-runtime escape (the CVE-2024-21626 class), host-level
denial of service through shared kernel resources, and rootless limits that are advisory
unless the control plane verifies them.

## 2. Firecracker (provisional preference)

| Controls | Mechanism | Verification | Class |
| --- | --- | --- | --- |
| HX-01..05 | No host process for project code; the API socket lives in the jail on the host, not in the guest | NT-01, NT-03; guest inventory shows only configured virtio devices | E |
| NET-01, NET-16..19 | **No NIC configured at all** by default; loopback only | case A: W8–W11, `path_absent`, no packet on any host capture point; case B: W17 `denied_at_policy` with a drop counter and nothing beyond the TAP | E |
| NET-02..06 | One TAP per run, host nftables default-deny, DNS pinned by the Control Plane | observed policy report matches the manifest; W14; W15 with the hostname attempt as case B | E+V |
| FS-01..07 | Read-only rootfs, workspace disk, one-way export disk; no bind mounts or shared filesystem | NT-03, device inventory, export mounted read-only on the host | E |
| RES-01 | Every limit is present before creation and recorded in the manifest | schema validation; unset value ⇒ `BLOCKED` | E |
| RES-02 | CPU: cgroup `cpu.max` on the VMM plus a fixed vCPU count; memory: guest RAM fixed at boot plus `memory.max` on the VMM | supervisor reads `cpu.stat` and `memory.peak`; W4/W5 within ±5% | E+V |
| RES-03 | **Two layers, neither sufficient alone.** Host: cgroup `pids.max` bounds VMM threads only. Guest: `pids.max` in the guest cgroup bounds workload processes, enforced by the guest kernel | host thread count (outside) **and** a fork-bomb run (W7) that must terminate at the cap; a guest limit that cannot be established from the verified image ⇒ `BLOCKED` | **G** |
| RES-04 | Disk: block-device size fixed at creation, plus a pre-allocated export quota | host checks device and export-file size; overflow not exported | E+V |
| RES-05 | Wall-clock timeout measured by the supervisor's monotonic clock, outside the environment | W13 terminates at `timeoutMs` plus the documented grace | E |
| RES-06 | stdout/stderr bounded by the collector while streaming | truncation recorded; infinite printer cut at the cap | E |
| RES-07 | Artifact count and bytes bounded by the collector | excess rejected and recorded | E |
| RES-08 | A limit that cannot be enforced or measured prevents start | preflight capability check; failure ⇒ `BLOCKED` | E+V |
| IMG-01 | Digest pinning: manifest carries the OCI digest **and** the derived rootfs digest; a tag is never identity | rebuild the rootfs from the recorded OCI digest and compare both digests; tag-only manifest rejected (NT-05) | E |
| IMG-02 | Platform/architecture recorded for host and guest; a mismatched host refuses to run | manifest `os`/`arch`/variant compared with `uname -m` and the kernel image | E |
| IMG-03 | Toolchain identity read from OCI build metadata and carried through conversion; anything the guest prints is an observation | identity populated from the attested SBOM; a program reporting another version changes only `observations` (NT-14) | E |
| IMG-04 | Vulnerabilities scanned on the OCI digest and again on the derived rootfs, each recorded separately | two scan records with scanner identity, version and their own digests; absence ⇒ `BLOCKED` | E |
| IMG-05 | **Gap:** a locally built rootfs has no upstream signature, so a signing and verification component with key custody must exist, and the specification must define what "signature verified" means for a derived artifact | signature status recorded as a field distinct from digest and scan; until the component exists a derived artifact may not be reported as signature-verified | **G** |
| IMG-06 | SBOM regenerated from the derived rootfs and bound to the rootfs digest | regenerate from the pinned rootfs and compare digests; mismatch or absence ⇒ `BLOCKED` | E |
| IMG-07 | Scanner database identity, version and freshness recorded; a stale database blocks | manifest carries name, database version and timestamp; older than the declared maximum age ⇒ `BLOCKED`, never "scan skipped" | E |
| IMG-08 | **Gap:** provenance for the conversion step has no upstream attestation to verify; an attestation produced and verified by the same pipeline needs a defined format and trust anchor | provenance required before start; absent or mismatched ⇒ no environment is created (NT-15) | **G** |
| EV-01..08 | One-way export disk (preferred) or a bounded vsock stream; the collector hashes outside | NT-06, NT-23; the guest cannot write ledger or collector | E+V |
| VD-01..12 | Verdict engine never reads guest process state | NT-07, NT-13, NT-24 | E |
| LC-01..10 | VM id equals the jail directory name; reconciler destroys process, jail, TAP, cgroup and disks | NT-20, NT-21; zero residuals over 30 trials | E+V |
| CP-01..05 | Per-VM REST API limited to create/observe/destroy | CP-04 comparison | E |

### 2.1 Resource limits: who enforces, who verifies

The ambiguity worth removing is that a microVM has **two** PID domains and **two**
memory views. The table states, per manifest limit, which component enforces it and how
a reviewer proves it from outside the environment.

| Limit | Enforced by | Independently verified by | If verification fails |
| --- | --- | --- | --- |
| `cpuMillis` | host cgroup `cpu.max` on the VMM process, plus the fixed vCPU count | supervisor reads `cpu.stat` throttling; W4 wall time within ±5% | `BLOCKED` (RES-08); a run that exceeds it is `FAIL` (RES-02) |
| `memoryBytes` | guest RAM size fixed at boot **and** cgroup `memory.max` on the VMM | `memory.peak` sampled outside; W5 within ±5%; config recorded in the manifest | `BLOCKED` |
| `pids` | **host** `pids.max` (VMM threads only) **and** guest cgroup `pids.max` (workload) | host thread count from outside; guest side from the verified image config plus a fork-bomb run (W7) that must terminate at the cap | `BLOCKED` — the guest-side limit is not attestable from the host, so it is a gap (RES-03) |
| `workspaceBytes` | block-device size and pre-allocated export quota | device size and export-file size read on the host; W6 overflow not exported | `BLOCKED` |
| `timeoutMs` | supervisor monotonic clock, outside the environment | W13 termination instant recorded by the supervisor | `BLOCKED` |
| `streamBytes` | collector while streaming | truncation event with byte counts; NT-08 | `BLOCKED` |
| `artifactCount` / `artifactBytes` | collector | rejected-count and byte totals in evidence metadata | `BLOCKED` |

Two consequences are deliberate:

- A guest-enforced limit is never accepted on the guest's word. If the guest-side PID
  limit cannot be fixed at boot from a digest-verified image, the run does not start.
- **Enforcement that cannot be established is `BLOCKED`, never "probably fine".** That
  is RES-08, and it applies to every row above.

Residual for Firecracker: VMM and KVM vulnerabilities; the host syscall surface the VMM
uses; guest kernel and rootfs supply chain; host denial of service through memory or CPU
pressure; TAP, cgroup and jail leaks when the supervisor dies before reconciliation.

## 3. Kata Containers (eligible, ranked second)

| Controls | Mechanism | Verification | Class |
| --- | --- | --- | --- |
| HX-01..05 | VM boundary; no host socket inside the guest | NT-01, NT-03 | E |
| NET-01, NET-16..19 | VM netns with no interface; host networking unsupported | case A: W8–W11, `path_absent`; case B: W17 `denied_at_policy` with a boundary packet and drop counter | E |
| NET-02..06 | TAP plus host policy; DNS configured in the guest, not inherited | NET-04 observed policy; W14; W15 with the hostname attempt as case B | E+V |
| FS-01..07 | virtio-fs or block devices; sharing configuration audited per run | NT-03, FS-02 inventory | E+V |
| RES-01..08 | Constraints applied at guest-kernel, in-guest container and hypervisor level | all three levels inspected; any missing ⇒ `BLOCKED` | E+V |
| IMG-01..08 | OCI images through containerd/CRI-O, digest-pinned; the OCI digest is the executed identity | NT-05, NT-14, NT-15 | E |
| EV/VD | Guest statistics are observations; evidence through the collector | NT-06, NT-23 | E+V |
| LC-01..10 | Shim, VMM, virtiofsd and netns teardown | NT-20, NT-21 | E+V |
| CP-01..05 | CRI-oriented interface; the Control Plane needs an adapter | CP-01, CP-04 | G |

Residual: guest-kernel and VMM vulnerabilities; a root shim and `virtiofsd` outside the
VM even in rootless-VMM mode; coupling to a container manager a local CLI does not
otherwise need.

## 4. Controls no candidate enforces by itself

These remain Control Plane responsibilities under every option, and Phase 3C must
implement them regardless of runtime:

- **CP-04** — compare the observed policy with the requested policy before any project
  process starts.
- **EV-02..EV-08** — hash evidence outside the environment, bind it to the run and the
  experiment digest, and verify the chain independently.
- **VD-01..VD-12** — compute the verdict outside the environment, by the single ordered
  precedence, with a non-vacuous `PASS`.
- **LC-07..LC-10** — reconcile and quarantine from labels and the ledger, not from a
  supervisor's self-report.
- **IMG-04..IMG-08** — treat scan, signature and provenance as separate recorded checks.

A runtime cannot be evidence for its own configuration. That separation is the reason
ADR-0018 defines six components rather than one.
