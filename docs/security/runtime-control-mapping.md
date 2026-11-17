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

Nothing here claims that any control is implemented today. VOLDBASE has no executor.

## 1. Podman rootless (benchmark baseline; not eligible as sole boundary)

| Controls | Mechanism | Verification | Class |
| --- | --- | --- | --- |
| HX-01, HX-03 | Control Plane refuses runs without a provisioned environment; no bypass flag exists | NT-01, option enumeration | E+V |
| HX-02 | No `child_process` path; Podman invoked only through the supervisor | static import test + audit trace | E |
| HX-04, HX-05 | No runtime socket mounted; run-scoped supervisor credential | NT-03 environment inventory | E |
| NET-01, NET-16..19 | `--network=none` gives a netns with no interfaces | egress, DNS, IPv6 and metadata probes fail | E |
| NET-02..06 | Allowlist netns plus host nftables; DNS resolved and pinned at the Control Plane | observed policy equals requested before start (CP-04) | E+V |
| FS-01..07 | Mount allowlist, fresh workspace, read-only rootfs, evidence outside | NT-03, NT-09, store inventory | E |
| RES-01..08 | cgroup v2 with delegated controllers; **ignored otherwise** (Docker documents this explicitly) | preflight reads `cgroup.controllers`; absent ⇒ `BLOCKED` (RES-08) | E+V |
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
| NET-01, NET-16..19 | **No NIC configured at all** by default; loopback only | egress, DNS, IPv6 and metadata probes fail | E |
| NET-02..06 | One TAP per run, host nftables default-deny, DNS pinned by the Control Plane | observed policy report matches the manifest; NT-02 | E+V |
| FS-01..07 | Read-only rootfs, workspace disk, one-way export disk; no bind mounts or shared filesystem | NT-03, device inventory, export mounted read-only on the host | E |
| RES-01..05 | cgroup `cpu.max` plus vCPU count; guest RAM plus VMM `memory.max`; block-device size | supervisor reads cgroup and block usage; ±5% budget | E+V |
| RES-03 | **Gap:** guest PIDs are not host PIDs; needs `pids.max` inside the guest plus a VMM thread bound | fork-bomb test (NT-11) plus host thread count | G |
| RES-05..06 | Supervisor clock outside the environment; streams bounded by the collector | NT-08, NT-11 | E |
| IMG-01..08 | **Gap:** no OCI image support; needs a pinned OCI→ext4 builder and re-attestation | rootfs digest and conversion provenance recorded; NT-05, NT-15 | G |
| EV-01..08 | One-way export disk (preferred) or a bounded vsock stream; the collector hashes outside | NT-06, NT-23; guest cannot write ledger or collector | E+V |
| VD-01..12 | Verdict engine never reads guest process state | NT-07, NT-13, NT-24 | E |
| LC-01..10 | VM id equals the jail directory name; reconciler destroys process, jail, TAP, cgroup and disks | NT-20, NT-21; zero residuals over 30 trials | E+V |
| CP-01..05 | Per-VM REST API limited to create/observe/destroy | CP-04 comparison | E |

Residual: VMM and KVM vulnerabilities; the host syscall surface the VMM uses; guest
kernel and rootfs supply chain; host denial of service through memory or CPU pressure;
TAP, cgroup and jail leaks when the supervisor dies before reconciliation.

## 3. Kata Containers (eligible, ranked second)

| Controls | Mechanism | Verification | Class |
| --- | --- | --- | --- |
| HX-01..05 | VM boundary; no host socket inside the guest | NT-01, NT-03 | E |
| NET-01, NET-16..19 | VM netns with no interface; host networking unsupported | probes fail | E |
| NET-02..06 | TAP plus host policy; DNS configured in the guest, not inherited | NET-04 observed policy | E+V |
| FS-01..07 | virtio-fs or block devices; sharing configuration audited per run | NT-03, FS-02 inventory | E+V |
| RES-01..08 | Constraints at guest-kernel, in-guest container and hypervisor level | all three levels inspected; any missing ⇒ `BLOCKED` | E+V |
| IMG-01..08 | OCI images through containerd/CRI-O, digest-pinned | NT-05, NT-14, NT-15 | E |
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
