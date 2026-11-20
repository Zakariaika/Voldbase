# Phase 3C benchmark host readiness checklist

- Status: **Template — no host has been inspected and nothing here has been run.**
- Date: 2026-11-17
- Scope: documentation only. No runtime, harness, dependency, executor or launcher is
  added, and no workload, probe or benchmark is executed by this document.
- Depends on: [ADR-0019](../adr/0019-isolation-runtime-selection.md) §2.4,
  [benchmark protocol](runtime-benchmark-protocol.md) §2 and §5–§6,
  [control mapping](runtime-control-mapping.md) §2.1,
  [execution safety specification](execution-safety-specification-v1.md) §5.4 and §11.1.

This checklist defines how a candidate **reference host** is inspected *before* any
runtime is installed and *before* any workload runs. It exists so that a host is
either shown to expose the facilities the protocol requires, or is reported as
`BLOCKED`/`INCONCLUSIVE` — never assumed adequate because a command did not error.

It is deliberately narrower than the protocol. It does not restate the benchmark, does
not add a gate, and does not change any threshold in protocol §2 or §7.1.

## 0. What this document is not

- It is **not** a demonstration that any isolation control is implemented or enforced.
- It is **not** a security assessment of the host, the hypervisor or the hardware.
- It is **not** a benchmark result, a trial, a measurement or a network probe.
- Running every check here to `READY` does **not** satisfy RES-08, does not satisfy any
  §5 control, and does not move ADR-0019 out of `Proposed`.

No command below starts a container, microVM, sandbox agent or workload, and none
sends a packet to a test destination. Preflight reads host state and writes only into
the designated evidence directory of §4; it changes no host configuration and no
runtime state.

## 1. Readiness stages

The stages are separate on purpose: each one answers a different question, and a
result in one is never evidence for the next.

| # | Stage | Question it answers | Produces | May not be used to claim |
| --- | --- | --- | --- | --- |
| H | **Host readiness** (this document) | Does this machine expose the facilities protocol §2 requires, as observed by read-only checks? | Preflight evidence bundle and one host classification | That any runtime is installable, that any limit is enforced, that KVM acceleration works, that cgroup delegation is granted, that any control holds, or that a benchmark ran |
| R | **Runtime installation readiness** | Can the selected runtimes be installed at pinned versions on this host, with their artifacts identified, and does an actual microVM start on them? | Install transcript, version and SHA-256 record (protocol §3), and the result of the first actual microVM start | That installation succeeded as a security boundary, or that a run is isolated |
| B | **Benchmark execution** | Do the measured gates in protocol §7.1 pass, with the evidence bundles of §6? | Raw per-trial data, DNS evidence bundles, report | That controls were verified beyond the tested paths, or that the ADR is accepted |
| I | **Independent review** | Do two independent reviewers accept the report and the reasoning? | Recorded reviews | That the runtime is safe in general |
| A | **ADR acceptance** | Are all prerequisites satisfied, so ADR-0019 may be `Accepted`? | An `Accepted` revision | That Phase 3C is complete, or that Phase 3C may skip conformance testing |

Only stage H is specified here. Stages R, B, I and A are defined by the protocol, the
specification and ADR-0018 decision 11; this document adds no criterion to them.

**Current state:** stage H has not been performed on any host. Stages R, B, I and A are
`NOT_STARTED`. ADR-0019 remains `Proposed`, no benchmark has been executed, and Phase 3C
implementation stays blocked.

## 2. Reference-host eligibility

These are the attributes a candidate host must have *before* it is worth inspecting in
detail. Every row is mandatory unless marked otherwise, and every requirement is taken
from protocol §2 — this checklist introduces no new numeric threshold.

| # | Attribute | Requirement | Source |
| --- | --- | --- | --- |
| E1 | Host class | Bare metal. A nested-virtualization VM is a compatibility datapoint and never a passing reference host. | protocol §2; §8.5 |
| E2 | Architecture | `x86_64`. `aarch64` is an optional second host, not a substitute for the reference host. | protocol §2; ADR-0019 §2.4 |
| E3 | CPU | ≥ 8 physical cores, with hardware virtualization extensions enabled. | protocol §2 |
| E4 | Memory | ≥ 32 GiB, with no swap pressure. | protocol §2 |
| E5 | Storage | NVMe, ≥ 100 GiB free, `ext4` or `xfs`, not a network filesystem. | protocol §2 |
| E6 | OS | Ubuntu 24.04 LTS or a documented equivalent, kernel ≥ 6.8, systemd present. | protocol §2 |
| E7 | cgroup v2 | Unified hierarchy, cgroup v2 only, with `memory`, `pids` and `cpu` available at the delegated root. | protocol §2; spec §5.4 |
| E8 | KVM | `/dev/kvm` present and accessible to the benchmark user **without root**. | protocol §2; ADR-0019 §2.4 |
| E9 | Network | The host's own uplinks are not used by any trial; trials use only the host-local probe environment. | protocol §2, §4.1 |
| E10 | Hygiene | No other workloads; CPU governor `performance`; SMT state, microcode, kernel and mount options recorded. | protocol §2 |
| E12 | Tooling | Node ≥ 22.18, npm, git, jq, `ip`, `nft`, `tcpdump`, `sha256sum` available. | protocol §4.1, §6.2; repository `engines` |

Three clarifications, because they are commonly lost:

- **E2 does not allow an ARM substitute.** The reference host is `x86_64`; an `aarch64`
  machine may be recorded as a second host later, but it cannot stand in for the
  reference measurement.
- **E1 is not a preference.** A nested VM can be useful to show that installation
  steps are not obviously broken. It cannot pass any gate, and its memory, timing and
  KVM behaviour are not attributable to hardware.
- **E11 is deliberately not a host-eligibility row.** `CLOCK_MONOTONIC` is read by the
  supervisor *outside* the environment (protocol §2, §6.1); it is a property of the
  future supervisor, not of the host, and no supervisor exists in stage H. The
  identifier E11 is left unused rather than reassigned, and the requirement is carried
  into stage B in §8.1.

## 3. Read-only preflight checks

Each check names one evidence source, one acceptance condition, one artifact name and one
failure class. The evidence source is not a single command: the 44 checks run more than 44
commands (PF-01, PF-03, PF-13, PF-22, PF-32, PF-34, PF-36 and PF-40 each run several), and
a check is never passed because one of its commands succeeded. The commands shown are
illustrative of the *evidence source*; the recorded artifact is the raw output, not a
retyped summary.

**Recording a multi-command check.** A check that runs more than one command produces one
artifact file holding one block per command, in the order listed. Each block records the
exact command line, the invoking user, the start and end timestamp, that command's own
exit status, then its raw stdout and raw stderr. Commands are run independently, so one
failing does not truncate the record of the others. The acceptance condition is applied
to the artifact as a whole; when a check fails, the command that produced the failing
evidence is named in the report. A check whose commands were partly skipped is
`INCONCLUSIVE`, never passed. Artifact names in the tables count checks, not commands.

A check whose acceptance condition is met is `PASS`. The last column names the failing
outcome, using the classes defined in §5: `BLOCKED` means the host cannot serve as the
reference host as it stands; `INCONCLUSIVE` means the check could not be decided from the
evidence; `DEFERRED` means the evidence is recorded but the requirement is decided by a
later stage (§8.1), which is never a pass.

### 3.1 Host identity and kernel

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-01 | Host identity | `hostname`, `hostnamectl`, and `sha256sum` over the concatenation of the hostname and `/etc/machine-id` (the raw identifier is read locally and never written to an artifact) | Identity recorded as the hostname plus the derived host id (first 12 hex characters of the digest); `/etc/machine-id` present and stable across the check | `PF-01-identity.txt` — derived id only | `INCONCLUSIVE` |
| PF-02 | OS release | `cat /etc/os-release` | `ID`/`VERSION_ID` identify Ubuntu 24.04 LTS, or an equivalence is stated in the report | `PF-02-os-release.txt` | `BLOCKED` if unsupported and no equivalence is recorded |
| PF-03 | Kernel version | `uname -r`, `uname -a` | Kernel ≥ 6.8 | `PF-03-kernel.txt` | `BLOCKED` |
| PF-04 | Boot parameters | `cat /proc/cmdline` | Recorded verbatim; no undocumented isolation-relevant option | `PF-04-cmdline.txt` | `INCONCLUSIVE` if unreadable |
| PF-05 | Virtualization status | `systemd-detect-virt`, and the `hypervisor` flag in `/proc/cpuinfo` | Detects no VM (`none`); bare metal | `PF-05-virt.txt` | `INCONCLUSIVE` for reference-host use; a nested host is recorded as a compatibility datapoint only |

### 3.2 CPU and virtualization capability

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-06 | Architecture | `uname -m` | `x86_64` | `PF-06-arch.txt` | `BLOCKED` for any other value |
| PF-07 | Physical cores | `lscpu` (sockets × cores per socket) | ≥ 8 physical cores, counted physically rather than as threads | `PF-07-lscpu.txt` | `BLOCKED` |
| PF-08 | Virtualization extensions | `grep` of `/proc/cpuinfo` for `vmx` or `svm` (x86_64) | `vmx` (Intel) or `svm` (AMD) present | `PF-08-flags.txt` | `BLOCKED` |
| PF-09 | SMT state | `cat /sys/devices/system/cpu/smt/active` | Recorded as `0` or `1`; not a pass/fail on its own | `PF-09-smt.txt` | `INCONCLUSIVE` if unreadable |
| PF-10 | CPU governor | `cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor` | Every CPU reports `performance` | `PF-10-governor.txt` | `BLOCKED` until the observed value is `performance` |
| PF-11 | Microcode revision | `grep -m1 '^microcode' /proc/cpuinfo` | Recorded | `PF-11-microcode.txt` | `INCONCLUSIVE` if absent from `/proc/cpuinfo` |
| PF-12 | Vulnerability mitigations (observation) | `cat /sys/devices/system/cpu/vulnerabilities/*` | Recorded verbatim; no acceptance threshold is applied here | `PF-12-vulnerabilities.txt` | none — observation only |

### 3.3 Memory and storage

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-13 | Installed memory | `free -b`, `grep MemTotal /proc/meminfo` | ≥ 32 GiB total | `PF-13-memory.txt` | `BLOCKED` |
| PF-14 | Swap pressure | `swapon --show`, `grep SwapTotal /proc/meminfo`, and `grep 'pswp' /proc/vmstat` read twice around a documented idle interval | No swap pressure is observed: the `pswpin`/`pswpout` delta over the documented idle interval is zero. Non-zero occupancy, or a single cumulative counter reading, is not pressure, and a non-zero delta is never `PASS` | `PF-14-swap.txt` | `INCONCLUSIVE` when evidence is missing, the interval is undocumented or incomplete, or a non-zero delta's cause is unresolved; `BLOCKED` only when paging persists over a fresh, complete interval after the cause has been addressed |
| PF-15 | Memory pressure at idle | `cat /proc/pressure/memory` | Recorded; non-zero pressure before any trial is a hygiene defect that must be explained | `PF-15-psi.txt` | `INCONCLUSIVE` if pressure is present and unexplained |
| PF-16 | Device backing the benchmark path is NVMe | Resolve the path to its block device and then to its transport: `findmnt -no SOURCE <benchmark-path>`, `lsblk -o NAME,TYPE,TRAN,ROTA,SIZE,MODEL <device>`, `lsblk -s -o NAME,TYPE,TRAN <device>`, `readlink -f /sys/block/<device>` | The block device that backs `<benchmark-path>` is identified and is NVMe, recognised from the resolved device itself (`nvme` device naming, `TRAN=nvme`, and the `/sys/block/<device>/device` NVMe subtree). `ROTA=0` and a non-network transport are recorded observations, never the NVMe evidence | `PF-16-blockdev.txt` | `BLOCKED` if the resolved backing device is not NVMe; `INCONCLUSIVE` if the path resolves through a layer stack (LVM, `md`, `dm-crypt`, virtio) whose physical device cannot be identified read-only |
| PF-17 | Free space | `df -B1 <benchmark-path>` | ≥ 100 GiB available | `PF-17-df.txt` | `BLOCKED` |
| PF-18 | Filesystem type | `findmnt -no FSTYPE,SOURCE <benchmark-path>` | `ext4` or `xfs` | `PF-18-fstype.txt` | `BLOCKED` |
| PF-19 | No network filesystem | `findmnt -t nfs,nfs4,cifs,smb3,9p,fuse.sshfs` | No network filesystem backs the benchmark path | `PF-19-netfs.txt` | `BLOCKED` |
| PF-20 | Mount table | `findmnt --real`, `findmnt -no OPTIONS <benchmark-path>` | Every mount recorded verbatim, with the benchmark path's options identified | `PF-20-mounts.txt` | `INCONCLUSIVE` if the table cannot be read in full |

**PF-14 applies the protocol's wording.** Protocol §2 requires *no swap pressure*. It does
not require swap to be disabled, and it does not forbid a swap area that is configured or
partly occupied, so this check imposes neither:

- **Configuration** is recorded, not judged: `swapon --show`, `SwapTotal` and `SwapFree`.
- **Occupancy** is recorded, not judged: bytes resident in swap say nothing by themselves
  about whether the host is paging.
- **Activity** is what pressure means here, and it is measured by sampling. The `pswpin`
  and `pswpout` counters in `/proc/vmstat` are cumulative and only ever increase, so one
  reading is a boot-time total, not a rate. **Method:** read both counters, wait the
  documented idle interval (for example 60 s with no benchmark workload, build or package
  installation running), read them again, and record both absolute readings, the interval
  and the delta. Any workload, build, boot or other agent inside the same interval
  invalidates it. Only the delta is interpreted.

**Outcomes, in order.**

1. Documented interval, complete pair of readings, delta exactly zero ⇒ `PASS`.
2. Any non-zero delta ⇒ never `PASS`, and not `BLOCKED` on the spot. The cause is
   investigated and recorded (what is paging, and why), addressed as a host change where
   one is needed (recorded per §4), and the observation is then repeated over a fresh,
   complete interval.
3. Paging persists over that fresh interval after the cause has been addressed ⇒
   `BLOCKED`.
4. Missing evidence, an undocumented or incomplete interval, or a cause that cannot be
   resolved ⇒ `INCONCLUSIVE`, whichever of the above it prevents.

No numeric threshold is invented: the only question the counters answer is whether paging
happened during a documented idle interval. Disabling swap is never required.

**PF-16 identifies the device rather than inferring it.** `ROTA=0` says the device is not
rotational and a non-network transport says the path is not remote; neither says the device
is NVMe, which virtual and SCSI-backed devices can also report. The check therefore
resolves `<benchmark-path>` through its mount source to the block device, records that
device's identity, and reports an unresolvable stack as `INCONCLUSIVE` rather than a guess.

### 3.4 KVM

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-21 | `/dev/kvm` exists | `test -c /dev/kvm` | Character device present | `PF-21-kvm-device.txt` | `BLOCKED` — there is no container fallback (ADR-0018 decision 2; protocol §8.5) |
| PF-22 | KVM permissions | `ls -l /dev/kvm`, `id`, `test -r /dev/kvm -a -w /dev/kvm` **as the benchmark user** | Benchmark user can read and write the device without root | `PF-22-kvm-access.txt` | `BLOCKED` |
| PF-23 | KVM modules | `lsmod`, inspected for `kvm`, `kvm_intel` and `kvm_amd` | `kvm` and the matching `kvm_intel`/`kvm_amd` are loaded, or their absence is recorded as a pending load | `PF-23-kvm-modules.txt` | `INCONCLUSIVE` when the module is not loaded and cannot be loaded without a host change |
| PF-24 | KVM acceleration usable | `kvm-ok` output when the host provides it, recorded verbatim as diagnostic; the recorded PF-05, PF-08, PF-21 and PF-22 evidence otherwise | The stage-H result is `DEFERRED` in every run, with or without `kvm-ok`: acceleration is demonstrated only by an actual microVM start in stage R, and no stage-H output can prove it. A `kvm-ok` diagnostic that reports a problem is recorded, and the prerequisite it concerns (PF-05, PF-08, PF-21, PF-22 or PF-23, where applicable) is classified from its own evidence under §5; a diagnostic alone never makes PF-24 `BLOCKED`, and one that cannot be reliably attributed is recorded and carried to stage R without inventing a failure classification | `PF-24-kvm-ok.txt` | `DEFERRED` in every stage-H run; `BLOCKED` only when a prerequisite row is `BLOCKED` by its own evidence under §5, never because of the diagnostic alone and never through PF-24 itself |

**PF-24 never decides stage H, with or without `kvm-ok`.** `kvm-ok` is an optional
diagnostic utility, and its output — present, absent, or reporting a problem — is not proof
that a microVM can start: it inspects host facilities, not an actual boot. Stage H therefore
requires the KVM device (PF-21) and access to it (PF-22), both `BLOCKED` on failure, and
PF-24 stays `DEFERRED` in every stage-H run. The acceleration result is the first actual
microVM start in stage R, a mandatory precondition of R → B (§8.1). Until that start has
succeeded, no report may describe KVM acceleration as demonstrated, and none may cite
`kvm-ok` as the demonstration. A negative diagnostic is neither ignored nor rounded up. It
is recorded verbatim and, where it can be reliably attributed, attributed to the
prerequisite it concerns — PF-05, PF-08, PF-21, PF-22 or PF-23, where applicable — which is
then classified from its own evidence under §5; the diagnostic alone never makes PF-24
`BLOCKED`, and it never substitutes for a prerequisite's own check. A diagnostic that
cannot be reliably attributed to a prerequisite is recorded and carried forward to stage R
without inventing a failure classification.

### 3.5 cgroup v2 and systemd

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-25 | Unified cgroup hierarchy | `stat -fc %T /sys/fs/cgroup` | `cgroup2fs` | `PF-25-cgroupfs.txt` | `BLOCKED` |
| PF-26 | Available controllers | `cat /sys/fs/cgroup/cgroup.controllers` | Includes `cpu`, `memory` and `pids` | `PF-26-controllers.txt` | `BLOCKED` |
| PF-27 | Subtree control | `cat /sys/fs/cgroup/cgroup.subtree_control` | Read and recorded; at least the subset the protocol needs is enabled, or its absence is stated | `PF-27-subtree.txt` | `INCONCLUSIVE` if the file cannot be read |
| PF-28 | Delegation to the benchmark user | `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers` | Path exists and lists `cpu`, `memory`, `pids` for the benchmark user | `PF-28-delegation.txt` | `BLOCKED` — a limit that cannot be established is `BLOCKED` (RES-08), never assumed |
| PF-29 | Delegated subtree ownership record | `stat -c '%U %G %a %n'` and `getfacl -p` on `/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/` | Owner, group, permission bits and ACL entries recorded verbatim, and nothing recorded contradicts the benchmark user owning that subtree. The record is evidence about ownership only, and is never a delegation verdict | `PF-29-delegation-owner.txt` | `BLOCKED` when the record shows the benchmark user cannot own the subtree without a host change; `INCONCLUSIVE` when it cannot be read or is inconsistent; otherwise `DEFERRED` — delegation is settled by the RES-08 write test in stage B |
| PF-30 | systemd | `systemd --version`, `systemctl is-system-running` | systemd present and the system reported `running` | `PF-30-systemd.txt` | `INCONCLUSIVE` for `degraded`, `BLOCKED` if systemd is absent |

**What PF-29 can and cannot establish.** Read-only inspection establishes facts about the
subtree: which user and group own it, the permission bits and ACL entries, that the path
exists, and that it is cgroupfs. Those facts are necessary for delegation and are recorded
as such. They do not establish that the benchmark user can create a child cgroup or write
`cgroup.procs` in it: effective write access also depends on systemd's `Delegate=` state,
the cgroup namespace, controller availability in the parent, and the ownership of newly
created children, none of which `stat` or `getfacl` report. `stat` therefore never proves
write access, and a complete ownership record is not a delegation verdict: the row result is
`DEFERRED` and the delegation question stays open (`INCONCLUSIVE`) at stage H for every
host, including a host whose ownership evidence is complete.

Creating a transient scope, a child cgroup or any other write to the hierarchy to prove
delegation would be a **write** to host state and is therefore not part of preflight; it
belongs to the per-run capability check (RES-08) at the start of stage B, which is
mandatory before any measured trial (§8.1). Until that check has passed, no report may
describe cgroup delegation as verified, and no benchmark may start.

### 3.6 Network isolation prerequisites

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-31 | Interface inventory | `ip -br addr` | Recorded baseline of every interface | `PF-31-links.txt` | `INCONCLUSIVE` |
| PF-32 | Route inventory | `ip route show table all`, `ip -6 route show table all` | Recorded baseline, including any default route | `PF-32-routes.txt` | `INCONCLUSIVE` |
| PF-33 | Forwarding disabled | `sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding` | Both report `0` | `PF-33-forwarding.txt` | `BLOCKED` until forwarding is off, and the change is recorded |
| PF-34 | nftables available | `nft --version`, `nft list ruleset` | `nft` present; existing ruleset recorded verbatim | `PF-34-nft.txt` | `BLOCKED` — the probe environment requires default-drop rules |
| PF-35 | Capture tooling | `command -v tcpdump`, `tcpdump --version` | `tcpdump` present with version recorded | `PF-35-tcpdump.txt` | `BLOCKED` — a missing capture makes zero-count DNS and egress claims meaningless (protocol §6.2) |
| PF-36 | Probe addresses unused | `ip route get 10.213.0.10`, `ip -6 route get fd00:213::10`, `ip route get 10.213.0.11`, `ip route get 10.213.0.53` | No route resolves to a real destination outside the future `vb-probe` namespace | `PF-36-probe-collision.txt` | `BLOCKED` on any address collision |
| PF-37 | Namespace tooling | `ip -br netns list`, `ls /var/run/netns` | Readable; `ip netns` available | `PF-37-netns.txt` | `INCONCLUSIVE` if the command is unavailable, `BLOCKED` if namespaces cannot exist on this kernel |

No probe, sink, namespace or resolver is created during preflight. PF-31..PF-37 only
record the state into which such a namespace would later be introduced.

### 3.7 Tooling

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-38 | Node | `node --version` | ≥ 22.18.0, matching the repository `engines` field | `PF-38-node.txt` | `BLOCKED` |
| PF-39 | npm | `npm --version` | Present; version recorded | `PF-39-npm.txt` | `BLOCKED` |
| PF-40 | Evidence and capture utilities | `command -v git jq sha256sum ip nft tcpdump` | All present | `PF-40-utils.txt` | `BLOCKED` |
| PF-41 | Runtime installation state | `command -v podman docker firecracker kata-runtime` | Recorded; absence is **expected** at this stage and is not a failure | `PF-41-runtimes.txt` | none — a runtime present changes nothing here and is recorded as host state |

PF-41 exists to prevent a false `READY`: a host that already has a runtime installed has
not thereby passed stage R, because version pinning, artifact hashes and configuration
are separate checks in the protocol's §3.

### 3.8 Hygiene and clock

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-42 | Competing workloads | `ps -eo comm --no-headers`, sorted and counted per command | No unexpected CPU- or memory-heavy service; anything unusual is named | `PF-42-processes.txt` | `INCONCLUSIVE` if unexpected load cannot be accounted for |
| PF-43 | Time synchronisation | `timedatectl` | Clock synchronised, so recorded evidence timestamps are meaningful | `PF-43-clock.txt` | `INCONCLUSIVE` |
| PF-44 | Kernel taint state | `cat /proc/sys/kernel/tainted` | Recorded; a non-zero value is explained in the report | `PF-44-tainted.txt` | `INCONCLUSIVE` if non-zero and unexplained |

`CLOCK_MONOTONIC` itself is not a host property to be checked: the protocol requires the
supervisor to read it, and no supervisor exists in this phase.

## 4. Evidence collection

- The evidence directory is designated before the run and is the **only** path preflight
  writes to: `evidence/preflight/<host-id>/<YYYY-MM-DD>/`, kept outside the benchmark path
  and outside any cgroup, namespace or mount that stage B will measure. Creating it and
  writing artifacts into it is not a host mutation, and nothing outside it is written.
- Reading host state is read-only. Preflight changes no host configuration and no runtime
  state: no `sysctl`, no swap configuration, no CPU governor, no unit, no cgroup, no
  namespace, no nftables rule, no package installation, and no file outside the evidence
  directory. A check that would need such a change is reported as not performed.
- The host id is derived from the hostname and `/etc/machine-id`, never from an operator's
  label, and is published only as the digest of PF-01. The raw `/etc/machine-id` never
  appears in an artifact, a report or a published bundle; the machine-id ↔ host-id mapping
  is kept in one protected local file outside the evidence directory, readable only by the
  operator, so a host can be correlated across dates. If the mapping is lost, the host id
  is recomputed from the host, never guessed.
- Each artifact holds the **raw** stdout and stderr of every command the check runs, with
  each command's line, invoking user, start and end timestamp and exit status recorded
  beside its own output, in the multi-command layout of §3. A retyped, merged or edited
  transcript is not evidence, and an exit status is never inferred from how the output
  looked.
- A `manifest.sha256` covers every artifact in the directory. Files are not modified
  after the manifest is written; a re-run creates a new timestamped directory.
- Missing output is recorded as missing. An empty file is not "nothing found".
- No command in §3 writes to the host outside the evidence directory. If a check cannot be
  performed read-only, it is reported as not performed and classified in §5; it is not
  replaced by an inferred result.
- If any command needs a host change to produce a passing result (swap off, governor set,
  forwarding off), the change is made by the operator, recorded as a host mutation, and
  the checks are then re-run from a clean directory. Preflight itself never performs it.

## 5. Readiness classifications

Exactly one classification is issued per host, for stage H only.

| Class | Applies to | Meaning | What may happen next |
| --- | --- | --- | --- |
| `READY` | host | Every stage-H mandatory check is `PASS` and every artifact exists, and the host is bare metal with `/dev/kvm` accessible to the benchmark user, cgroup v2 with `cpu`, `memory` and `pids` at the delegated root, ≥ 32 GiB, an identified NVMe device with ≥ 100 GiB free behind the benchmark path, and the required tooling. `READY` carries its open `DEFERRED` rows but no verdict on them | Stage R may be attempted on this host. Nothing about isolation is proven, KVM acceleration is not yet demonstrated, and cgroup delegation is not yet granted. |
| `BLOCKED` | host | At least one stage-H mandatory check failed in a way that cannot be corrected without different hardware or a host reconfiguration | The host is not used as the reference host. The failing check is named; no gate is evaluated, and no result from a different host is substituted. |
| `INCONCLUSIVE` | host | A stage-H mandatory check could not be decided from the evidence: missing artifact, unreadable counter, nested virtualization, unexplained load, or an unavailable tool that the check itself requires | No gate may be evaluated on this host. The gap is named, and either the check is repeated with a complete artifact set or another host is chosen. `INCONCLUSIVE` is never rounded to `READY`. |
| `DEFERRED` | row only | A requirement recorded at stage H whose verdict belongs to a later stage: KVM acceleration (PF-24, settled in stage R) and cgroup write delegation (PF-29, settled in stage B by RES-08) | It is never a pass and never decides the stage-H class; it blocks the transition named in §8.1 and must be settled before any measured trial. |

**Which rows decide stage H.** All 44 rows are stage-H mandatory *as evidence*: every
artifact must exist, and no row may be skipped because a later stage will look at it again.
Two rows carry a deferred verdict, and only these two:

- **PF-24.** PF-05, PF-08, PF-21 and PF-22 are stage-H mandatory and stay `BLOCKED` on
  failure. PF-24 is `DEFERRED` in every stage-H run, whether `kvm-ok` is installed or not:
  its output is diagnostic only and never proves a microVM can start, so the acceleration
  verdict belongs to the first actual microVM start in stage R.
- **PF-29.** The ownership record is stage-H mandatory and is `BLOCKED` when it shows the
  benchmark user cannot own the subtree, `INCONCLUSIVE` when it cannot be read. When the
  record is consistent the row is `DEFERRED`: ownership evidence is not a delegation
  verdict, and the capability is decided by the RES-08 write test in stage B.

Decision procedure:

1. Any stage-H mandatory check `BLOCKED` ⇒ host `BLOCKED`, regardless of the other rows.
2. Otherwise, any stage-H mandatory check `INCONCLUSIVE`, missing artifact, or partly
   recorded multi-command check ⇒ host `INCONCLUSIVE`.
3. Otherwise every row is `PASS` or `DEFERRED` ⇒ host `READY`.
4. A `READY` classification carries its `DEFERRED` rows forward as open requirements,
   listed with the classification. They are never written as passed, and each blocks the
   transition named in §8.1.

A `READY` host classification is valid only for the date and artifact set it was issued
for. Any host mutation — kernel update, swap change, governor change, package
installation, added co-tenant — invalidates it.

## 6. Stop conditions

These are hard stops, not preferences:

1. **Never begin a benchmark if a mandatory prerequisite is missing.** A missing
   `/dev/kvm`, missing cgroup v2 delegation, insufficient memory, insufficient free
   NVMe space or absent capture tooling ends the attempt at preflight. There is no
   "try it and see" path and no container fallback.
2. **Never treat a nested VM as a passing reference host.** It may be recorded as a
   compatibility datapoint, clearly labelled, and it may not produce a gate result.
3. **Never use a public network destination.** No preflight command contacts a public
   address, and no later trial uses one. The probe environment is host-local
   (protocol §4.1).
4. **Never execute untrusted project code during preflight.** No repository fixture, no
   project command, no toolchain invocation from a project directory, no container or
   microVM start. The commands in §3 inspect the host only.
5. **Never claim a benchmark was performed when only host checks were completed.**
   Stage H produces a readiness classification and nothing else. `READY` is not a
   measurement, not a trial count, and not a gate result.
6. **Never record a `READY` host without artifacts.** A classification without the §4
   bundle is `INCONCLUSIVE` by definition.
7. **Never repair a failed check by editing its evidence.** A corrected host state
   produces a new, separately timestamped run of the checks.
8. **Never evaluate a gate, or describe a result as passing, while attribution is
   `partial` or `unknown`.** Host readiness does not change the memory-attribution rules
   in protocol §6.1.
9. **Never start a measured trial while a deferred requirement is unsettled.** KVM
   acceleration must have been shown by an actual microVM start and the RES-08 delegation
   write test must have passed. A `DEFERRED` row is an open question, never a waiver and
   never a substitute for a passing mandatory check.

## 7. What readiness does not prove

| Observation | What it does not establish |
| --- | --- |
| `READY` on every check in §3 | That any isolation control is implemented, enforced or verified. No control in specification §5 is exercised. |
| `/dev/kvm` accessible | That a microVM starts, that boot or teardown is bounded, or that a run is isolated. |
| The four underlying KVM checks (PF-05, PF-08, PF-21, PF-22) all passing, and any `kvm-ok` output | That KVM acceleration is usable. PF-24 is `DEFERRED` in every stage-H run; a `kvm-ok` result, present or absent, is diagnostic only, and only an actual microVM start in stage R settles acceleration. |
| A `READY` classification | That its `DEFERRED` rows are satisfied. Acceleration and delegation stay open until stage R and stage B settle them, and each blocks the transition named in §8.1. |
| `ROTA=0` with a non-network transport | That the device is NVMe. Virtual and SCSI-backed devices can report the same pair; PF-16 resolves and identifies the device that backs the path. |
| cgroup controllers present, and a complete PF-29 ownership record | That the declared limits are enforced at their values, or that the benchmark user can write the delegated subtree. Enforcement is RES-02..RES-04 and writability is the RES-08 write test, both in stage B; the delegation row is `DEFERRED` at stage H and only that write test settles it. |
| `nft` present and forwarding off | That default-deny egress holds. That is NET-01 and is tested with the probe environment and the capture control of protocol §5 step 0. |
| A baseline interface and route inventory | That no unintended path exists. That is NET-01/W16 and requires per-trial captures. |
| A green `npm ci` / `typecheck` / `build` / `test` run | That the isolation boundary works. The specification §11 says this explicitly. |
| A nested host that installs cleanly | Anything about reference-host timing, memory or density. |

The inverse also holds: a preflight failure is a failure of *host readiness*, not proof
that the runtime would have failed. The distinction is recorded so neither direction is
misread.

## 8. Stage separation and handoff

| Transition | Entry condition | Artifact that must exist | Blocking consequence |
| --- | --- | --- | --- |
| H → R | Host classified `READY` for a dated artifact set, with its `DEFERRED` rows listed | Preflight bundle, classification and deferred list | No runtime is installed on an unclassified or non-`READY` host; `READY` settles neither acceleration nor delegation |
| R → B | Runtime artifacts installed, versions and SHA-256 recorded per protocol §3; no gate claimed; every deferred requirement settled before the first measured trial — acceleration demonstrated by the first actual microVM start, and the RES-08 cgroup write test passed | Install record, acceleration result, RES-08 record | No measured trial starts without a pinned runtime identity, and none starts while acceleration or delegation is unsettled; a `DEFERRED` row is never treated as passed |
| B → I | Report produced from raw per-trial data, with DNS evidence bundles, capture control, cleanup counts and attribution classes | Raw data + report | A summary without raw data is not reviewable; a review cannot start |
| I → A | Two independent reviews recorded, benchmark report attached, gates evaluated | Reviews + report | ADR-0019 stays `Proposed`; Phase 3C stays blocked |
| A → implementation | ADR-0019 formally `Accepted` | `Accepted` ADR revision | Any executor work before this is out of order (ADR-0018 decision 11; spec §11.1) |

No stage may be skipped, and no stage may borrow another's evidence: host readiness is
not installation evidence, installation is not enforcement evidence, a benchmark is not
a review, and a review is not an accepted ADR.

### 8.1 Requirements deferred to a later stage

Three requirements cannot be settled by read-only inspection. They are not dropped and not
downgraded; each is carried to the stage that can produce the evidence, and its stage-H
result is `DEFERRED` — recorded, open, and never a pass — until that stage settles it.

| Requirement | Source | Settled in | Blocks | Why stage H cannot settle it |
| --- | --- | --- | --- | --- |
| `CLOCK_MONOTONIC` is read by the supervisor, outside the environment | protocol §2, §6.1 | B, first supervised trial | any timed result or gate | It is a property of the supervisor that does not yet exist, not of the host; PF-43 records only that the host clock is synchronised |
| KVM acceleration is actually usable (PF-24; a `kvm-ok` result, if any, is diagnostic only) | protocol §2 | R, first actual microVM start | R → B and every measured trial | Deciding it requires starting a guest, which preflight must not do; PF-21 and PF-22 stay mandatory and `BLOCKED` on failure, so the deferral removes no prerequisite |
| The benchmark user can write the delegated cgroup subtree | protocol §2; spec §5.4 | B, RES-08 write test | every measured trial | Proving writability is a write to host state; PF-29 records ownership evidence only and is `DEFERRED`, never a pass |

A `DEFERRED` result is an open requirement, not a waiver. None of the three may be
inferred from stage-H evidence, none may be skipped before the transition it blocks, and
none is required for the stage-H classification itself. Deferral also changes no mandatory
prerequisite: a missing `/dev/kvm`, an absent delegated controller, a `/dev/kvm` the
benchmark user cannot access, or an unclassified host still stops the work before stage R.

## 9. Report template

A stage-H report contains exactly the following, and nothing that reads as a benchmark
result:

```
Phase 3C host readiness — stage H
Host id:            <derived host id (sha256, 12 hex)> / <hostname>
Date and user:      <YYYY-MM-DD> / <user>
Host class:         bare metal | nested VM (compatibility datapoint only)
Kernel / OS:        <uname -r> / <ID VERSION_ID>
CPU / memory:       <sockets × cores> physical cores / <MemTotal>
Storage:            <device, transport, filesystem, free bytes>
KVM:                present | absent; readable/writable by benchmark user: yes | no
cgroup v2:          unified | not unified; delegated controllers: <list>
Acceleration:       DEFERRED to stage R in every run; kvm-ok output is diagnostic only
Delegation:         DEFERRED at stage H; ownership evidence recorded, RES-08 write test in stage B
Deferred items:     <PF ids and the transition each blocks>
Capture tooling:    tcpdump <version> | absent
Host mutations:     <none | list of changes with operator and time>
Classification:     READY | BLOCKED | INCONCLUSIVE
Blocking checks:    <PF ids and the observed value>
Evidence:           <directory> / manifest.sha256 <digest>
Statement:          No runtime was installed or started, no workload was executed,
                    no network probe was performed, and no isolation control was
                    verified in this report.
```

## 10. Current status

- No host has been inspected. Every row in §3 is `NOT_CHECKED`, which is not `READY`.
- No host is `READY`, and no deferred requirement (acceleration, delegation, supervisor
  clock) has been settled.
- No runtime is installed or measured; no executor, launcher, sandbox or benchmark
  runner exists.
- No benchmark trial has been run, and no gate in protocol §7.1 has been evaluated.
- No independent review is recorded.
- ADR-0019 remains `Proposed`; Phase 3C implementation remains blocked until it is
  `Accepted`.
