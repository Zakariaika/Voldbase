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
sends a packet to a test destination. Preflight is read-only host inspection plus
recording what was observed.

## 1. Readiness stages

The stages are separate on purpose: each one answers a different question, and a
result in one is never evidence for the next.

| # | Stage | Question it answers | Produces | May not be used to claim |
| --- | --- | --- | --- | --- |
| H | **Host readiness** (this document) | Does this machine expose the facilities protocol §2 requires, as observed by read-only checks? | Preflight evidence bundle and one host classification | That any runtime is installable, that any limit is enforced, that any control holds, or that a benchmark ran |
| R | **Runtime installation readiness** | Can the selected runtimes be installed at pinned versions on this host, with their artifacts identified? | Install transcript, version and SHA-256 record (protocol §3) | That installation succeeded as a security boundary, or that start-up works |
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
| E11 | Clock | `CLOCK_MONOTONIC` is read by the supervisor, outside the environment. | protocol §2, §6.1 |
| E12 | Tooling | Node ≥ 22.18, npm, git, jq, `ip`, `nft`, `tcpdump`, `sha256sum` available. | protocol §4.1, §6.2; repository `engines` |

Two clarifications, because they are commonly lost:

- **E2 does not allow an ARM substitute.** The reference host is `x86_64`; an `aarch64`
  machine may be recorded as a second host later, but it cannot stand in for the
  reference measurement.
- **E1 is not a preference.** A nested VM can be useful to show that installation
  steps are not obviously broken. It cannot pass any gate, and its memory, timing and
  KVM behaviour are not attributable to hardware.

## 3. Read-only preflight checks

Each check has exactly one command or evidence source, one acceptance condition, one
artifact and one failure class. Commands are illustrative of the *evidence source*;
the recorded artifact is the raw output, not a retyped summary.

Classifications used in the last column are defined in §5. `BLOCKED` means the host
cannot serve as the reference host as it stands; `INCONCLUSIVE` means the check could
not be decided from the evidence.

### 3.1 Host identity and kernel

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-01 | Host identity | `hostname`, `cat /etc/machine-id`, `hostnamectl` | Identity recorded; `machine-id` present and stable across the check | `PF-01-identity.txt` | `INCONCLUSIVE` |
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
| PF-14 | Swap | `swapon --show`, `grep SwapTotal /proc/meminfo` | No active swap, so trial memory is not silently absorbed | `PF-14-swap.txt` | `BLOCKED` until swap is off, and the change is recorded |
| PF-15 | Memory pressure at idle | `cat /proc/pressure/memory` | Recorded; non-zero pressure before any trial is a hygiene defect that must be explained | `PF-15-psi.txt` | `INCONCLUSIVE` if pressure is present and unexplained |
| PF-16 | Device is NVMe | `lsblk -d -o NAME,ROTA,TYPE,TRAN,SIZE,MODEL` | Target device has `ROTA=0` and a non-network transport | `PF-16-blockdev.txt` | `BLOCKED` if rotational or network-backed |
| PF-17 | Free space | `df -B1 <benchmark-path>` | ≥ 100 GiB available | `PF-17-df.txt` | `BLOCKED` |
| PF-18 | Filesystem type | `findmnt -no FSTYPE,SOURCE <benchmark-path>` | `ext4` or `xfs` | `PF-18-fstype.txt` | `BLOCKED` |
| PF-19 | No network filesystem | `findmnt -t nfs,nfs4,cifs,smb3,9p,fuse.sshfs` | No network filesystem backs the benchmark path | `PF-19-netfs.txt` | `BLOCKED` |
| PF-20 | Mount table | `findmnt --real`, `findmnt -no OPTIONS <benchmark-path>` | Every mount recorded verbatim, with the benchmark path's options identified | `PF-20-mounts.txt` | `INCONCLUSIVE` if the table cannot be read in full |

### 3.4 KVM

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-21 | `/dev/kvm` exists | `test -c /dev/kvm` | Character device present | `PF-21-kvm-device.txt` | `BLOCKED` — there is no container fallback (ADR-0018 decision 2; protocol §8.5) |
| PF-22 | KVM permissions | `ls -l /dev/kvm`, `id`, `test -r /dev/kvm -a -w /dev/kvm` **as the benchmark user** | Benchmark user can read and write the device without root | `PF-22-kvm-access.txt` | `BLOCKED` |
| PF-23 | KVM modules | `lsmod`, inspected for `kvm`, `kvm_intel` and `kvm_amd` | `kvm` and the matching `kvm_intel`/`kvm_amd` are loaded, or their absence is recorded as a pending load | `PF-23-kvm-modules.txt` | `INCONCLUSIVE` when the module is not loaded and cannot be loaded without a host change |
| PF-24 | KVM acceleration usable | `kvm-ok` when available; otherwise the recorded PF-05/PF-08/PF-21/PF-22 evidence | Acceleration is reported as usable by a tool, or the four underlying checks all pass and the report says the tool was unavailable | `PF-24-kvm-ok.txt` | `INCONCLUSIVE` if no tool result exists and any underlying check is undecided |

### 3.5 cgroup v2 and systemd

| ID | Check | Command / evidence source | Acceptance condition | Artifact | On failure |
| --- | --- | --- | --- | --- | --- |
| PF-25 | Unified cgroup hierarchy | `stat -fc %T /sys/fs/cgroup` | `cgroup2fs` | `PF-25-cgroupfs.txt` | `BLOCKED` |
| PF-26 | Available controllers | `cat /sys/fs/cgroup/cgroup.controllers` | Includes `cpu`, `memory` and `pids` | `PF-26-controllers.txt` | `BLOCKED` |
| PF-27 | Subtree control | `cat /sys/fs/cgroup/cgroup.subtree_control` | Read and recorded; at least the subset the protocol needs is enabled, or its absence is stated | `PF-27-subtree.txt` | `INCONCLUSIVE` if the file cannot be read |
| PF-28 | Delegation to the benchmark user | `cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers` | Path exists and lists `cpu`, `memory`, `pids` for the benchmark user | `PF-28-delegation.txt` | `BLOCKED` — a limit that cannot be established is `BLOCKED` (RES-08), never assumed |
| PF-29 | Owner of the delegated subtree | `stat -c '%U %G %a' /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/` | Recorded owner/mode; writable by the benchmark user | `PF-29-delegation-owner.txt` | `INCONCLUSIVE` if ownership is reported but the write access cannot be established read-only |
| PF-30 | systemd | `systemd --version`, `systemctl is-system-running` | systemd present and the system reported `running` | `PF-30-systemd.txt` | `INCONCLUSIVE` for `degraded`, `BLOCKED` if systemd is absent |

Creating a transient scope to prove delegation would be a **write** to host state and is
therefore not part of preflight; it belongs to the per-run capability check (RES-08) in
stage B.

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

- One directory per physical host and date: `evidence/preflight/<host-id>/<YYYY-MM-DD>/`.
  The host id is derived from `machine-id` plus the hostname, never from an operator's
  label.
- Each artifact is the **raw** stdout/stderr of the recorded command, with the command,
  the invoking user, the start and end timestamp and the exit status stored beside it.
  A retyped or edited transcript is not evidence.
- A `manifest.sha256` covers every artifact in the directory. Files are not modified
  after the manifest is written; a re-run creates a new timestamped directory.
- Missing output is recorded as missing. An empty file is not "nothing found".
- No command in §3 writes to the host. If a check cannot be performed read-only, it is
  reported as not performed and classified in §5; it is not replaced by an inferred
  result.
- If any command needs a host change to produce a passing result (swap off, governor set,
  forwarding off), the change is made by the operator, recorded as a host mutation, and
  the checks are then re-run from a clean directory. Preflight itself never performs it.

## 5. Readiness classifications

Exactly one classification is issued per host, for stage H only.

| Class | Meaning | What may happen next |
| --- | --- | --- |
| `READY` | Every mandatory check passed, every artifact exists, and the host is bare metal with KVM, cgroup v2 delegation, ≥ 32 GiB, NVMe with ≥ 100 GiB free, and the required tooling | Stage R may be attempted on this host. Nothing about isolation is yet proven. |
| `BLOCKED` | At least one mandatory check failed in a way that cannot be corrected without different hardware or a host reconfiguration | The host is not used as the reference host. The failing check is named; no gate is evaluated, and no result from a different host is substituted. |
| `INCONCLUSIVE` | A mandatory check could not be decided from the evidence: missing artifact, unreadable counter, nested virtualization, unexplained load, or an unavailable tool | No gate may be evaluated on this host. The gap is named, and either the check is repeated with a complete artifact set or another host is chosen. `INCONCLUSIVE` is never rounded to `READY`. |

Decision procedure:

1. Any mandatory check `BLOCKED` ⇒ host `BLOCKED`, regardless of the other rows.
2. Otherwise, any mandatory check `INCONCLUSIVE` or missing artifact ⇒ host
   `INCONCLUSIVE`.
3. Otherwise ⇒ `READY`.

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

## 7. What readiness does not prove

| Observation | What it does not establish |
| --- | --- |
| `READY` on every check in §3 | That any isolation control is implemented, enforced or verified. No control in specification §5 is exercised. |
| `/dev/kvm` accessible | That a microVM starts, that boot or teardown is bounded, or that a run is isolated. |
| cgroup controllers and delegation present | That the declared limits are enforced at their values. That is RES-02..RES-04 and is measured in stage B. |
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
| H → R | Host classified `READY` for a dated artifact set | Preflight bundle and classification | No runtime is installed on an unclassified or non-`READY` host |
| R → B | Runtime artifacts installed, versions and SHA-256 recorded per protocol §3; no gate claimed | Install record | No trial starts without a pinned runtime identity |
| B → I | Report produced from raw per-trial data, with DNS evidence bundles, capture control, cleanup counts and attribution classes | Raw data + report | A summary without raw data is not reviewable; a review cannot start |
| I → A | Two independent reviews recorded, benchmark report attached, gates evaluated | Reviews + report | ADR-0019 stays `Proposed`; Phase 3C stays blocked |
| A → implementation | ADR-0019 formally `Accepted` | `Accepted` ADR revision | Any executor work before this is out of order (ADR-0018 decision 11; spec §11.1) |

No stage may be skipped, and no stage may borrow another's evidence: host readiness is
not installation evidence, installation is not enforcement evidence, a benchmark is not
a review, and a review is not an accepted ADR.

## 9. Report template

A stage-H report contains exactly the following, and nothing that reads as a benchmark
result:

```
Phase 3C host readiness — stage H
Host id:            <machine-id> / <hostname>
Date and user:      <YYYY-MM-DD> / <user>
Host class:         bare metal | nested VM (compatibility datapoint only)
Kernel / OS:        <uname -r> / <ID VERSION_ID>
CPU / memory:       <sockets × cores> physical cores / <MemTotal>
Storage:            <device, transport, filesystem, free bytes>
KVM:                present | absent; readable/writable by benchmark user: yes | no
cgroup v2:          unified | not unified; delegated controllers: <list>
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
- No runtime is installed or measured; no executor, launcher, sandbox or benchmark
  runner exists.
- No benchmark trial has been run, and no gate in protocol §7.1 has been evaluated.
- No independent review is recorded.
- ADR-0019 remains `Proposed`; Phase 3C implementation remains blocked until it is
  `Accepted`.
