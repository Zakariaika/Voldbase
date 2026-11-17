# Isolation runtime benchmark protocol (Phase 3B appendix)

- Status: **Appendix to [ADR-0019](../adr/0019-isolation-runtime-selection.md); binding
  once the ADR is accepted.**
- Date: 2026-11-17
- Scope: protocol only. Executing it is Phase 3B follow-up work; no runtime, harness or
  dependency is added by this document.

This protocol exists so that the runtime selection in ADR-0019 can be decided by
measurements that someone else can reproduce. It uses **benign workloads only**: no
exploit payloads, no kernel attack attempts, no escape tooling, no external targets.
Attacking the host to test escape resistance is out of scope for Phase 3C and would
require a separate, authorized security-testing arrangement on isolated hardware.

**No workload may reach the public internet.** Network tests use the controlled probe
environment in §4.1, which is host-local, deterministic and disconnected from any
production or public network.

Nothing in this document has been measured. Every number below is a **target**, and is
labelled as such; results are labelled measured, projected, vendor-quoted or unknown.

## 1. Questions

| ID | Question | Feeds |
| --- | --- | --- |
| B1 | Cold and warm start latency for a realistic Node toolchain image | matrix criterion 6, budgets in §7 |
| B2 | Per-run attributable host memory, with attribution quality stated | criterion 6 |
| B3 | Successful concurrent runs at N = 1, 2, 4, 8 | criterion 7 |
| B4 | Are CPU, memory, PID and disk limits enforced at the declared values? | criterion 5 |
| B5 | Zero residual resources across 30 trials? | criterion 8 |
| B6 | Complete default-deny for IPv4, IPv6, DNS and metadata endpoints, and exact allowlist behaviour? | criterion 3 |
| B7 | Is the host filesystem unreachable and unwritable? | criterion 4 |
| B8 | Operator steps and minutes to a first run on a clean host? | criterion 11 |
| B9 | Overhead of isolation versus the rootless-container baseline? | ADR §6.4 |

## 2. Hosts

| Field | Requirement |
| --- | --- |
| Host class | Bare metal preferred. A nested-virtualization VM is a compatibility datapoint, never a pass criterion. |
| CPU | x86_64, ≥ 8 physical cores, virtualization extensions enabled; aarch64 is an optional second host |
| Memory and disk | ≥ 32 GiB with no swap pressure; NVMe with ≥ 100 GiB free; `ext4` or `xfs`; no network filesystem |
| OS | Ubuntu 24.04 LTS or equivalent, kernel ≥ 6.8, cgroup v2 mounted, systemd |
| KVM | `/dev/kvm` present and accessible to the benchmark user without root |
| Network | The host's own uplinks are not used by any trial. Trials use only the probe environment in §4.1. |
| Cgroups | cgroup v2 only; `memory`, `pids`, `cpu` controllers available at the delegated root |
| Hygiene | No other workloads; CPU governor `performance`; record SMT state, microcode, kernel and mount options |
| Clock | `CLOCK_MONOTONIC` read by the supervisor, outside the environment |

Record per host: `uname -a`, `/proc/cpuinfo`, `lscpu`, `free -h`, `lsblk`, `mount`,
`/sys/fs/cgroup/cgroup.controllers`, `systemd --version`, and the checksum of every
runtime artifact.

The reference host is a measurement instrument, not the target user machine; §7.2
separates the two.

## 3. Runtime identity

Identity is recorded from the runtime itself, not from memory.

| Runtime | Record |
| --- | --- |
| Podman | `podman --version`, `podman info --format json`, `crun --version`, storage driver, network backend and version |
| Docker rootless | `docker version`, `docker info`, `rootlesskit --version`, `slirp4netns --version`, cgroup driver |
| Firecracker | `firecracker --version`, SHA-256 of binary, jailer, guest kernel and rootfs; conversion-tool version |
| Kata | `kata-runtime --version` or `kata-collect-data.sh`, VMM binary and version, kernel, shim path, manager version |

## 4. Images, probe environment and workloads

### 4.1 Controlled probe environment

All network tests run against a **host-local probe namespace** (`vb-probe`) that is
created for the benchmark and destroyed afterwards. It contains no public route and no
resolver.

| Component | Address | Purpose |
| --- | --- | --- |
| Sink A | `10.213.0.10:8443` (IPv4), `[fd00:213::10]:8443` (IPv6) | Controlled allowlist destination; serves a fixed body |
| Sink A, second port | `10.213.0.10:9443` | Proves the allowlist is port-scoped |
| Sink B | `10.213.0.11:8443` | Never allowlisted; proves the allowlist is address-scoped |
| Unauthorized resolver | `10.213.0.53:53` | Never authorized; exists so a DNS query *can* be attempted and observed |
| No forwarding | — | `ip_forward=0`, no NAT/MASQUERADE, nftables default-drop, no route to the host uplink |

Properties that make the environment safe and reproducible:

- **Deterministic content.** Sink A returns exactly `voldbase-probe-v1\n`; its SHA-256 is
  recorded and checked by the workload.
- **No production or public target.** The addresses come from a documentation-reserved
  range used only inside the probe namespace; nothing is forwarded outside it.
- **No unintended path into the guest.** The run's TAP (Firecracker) or veth (container)
  is attached to the probe namespace only. Sink processes live in that namespace, not on
  the host uplink, and cannot reach host loopback.
- **Observed state.** Before the first trial the report records the namespace's
  interfaces, routes and full `nft list ruleset`; the same dump is taken after each trial
  and must be identical except for per-run entries.
- **No DNS dependency for setup.** Image pulls happen before the trial and outside the
  probe namespace; a trial that needs the network to prepare is invalid.

### 4.2 Images and workloads

One OCI image pinned by `sha256:` digest containing Node 22 and npm, identical for every
runtime. The Firecracker rootfs is derived from it and its digest recorded. No mutable
tags, no registry lookup during a trial. Fixture: a small repository (≈50 files, fixed
lockfile) with a deterministic suite of known duration.

| ID | Workload | Measures |
| --- | --- | --- |
| W1 | `/bin/true` | floor: environment creation and teardown |
| W2 | `node -e "console.log(process.version)"` | toolchain readiness, time to first output |
| W3 | fixture suite (~10 s) | realistic run |
| W4 | CPU-bound loop, 10 s | CPU limit |
| W5 | allocate and touch 512 MiB | memory limit and overhead |
| W6 | write 200 MiB to the workspace | disk quota and export behaviour |
| W7 | spawn 200 short-lived children | PID limit |
| W8 | **deny** — TCP connect to `10.213.0.10:8443`, expect immediate `ENETUNREACH`/`EHOSTUNREACH` | IPv4 default-deny |
| W9 | **deny, case A** — resolve `probe.test` with no NIC and no route; expect `path_absent`, no packet anywhere | network path absent (not a DNS drop) |
| W10 | **deny** — TCP connect to `[fd00:213::10]:8443`, expect `ENETUNREACH` | IPv6 default-deny |
| W11 | **deny** — connect to `169.254.169.254:80`, `[fd00:ec2::254]:80`, `100.100.100.200:80`, resolve `metadata.google.internal` | metadata-endpoint blocking |
| W12 | read a canary file placed outside the workspace | filesystem boundary |
| W13 | sleep beyond `timeoutMs` | supervisor timeout path |
| W14 | **allowlist positive** — `GET http://10.213.0.10:8443/health`, expect 200 and the recorded body digest | authorized egress works |
| W15 | **allowlist negative** — `10.213.0.10:9443`, `10.213.0.11:8443`, `[fd00:213::10]:8443`, W11 addresses, and resolve `probe.test` with the unauthorized resolver configured (case B evidence) | authorization is address-, port- and family-scoped; DNS stays denied |
| W16 | host capture on every interface except the run's TAP during W14 | no unintended network path |
| W17 | **deny, case B** — resolver `10.213.0.53:53` configured inside the run, then resolve `probe.test`; expect `denied_at_policy` with a boundary packet and a drop counter | explicit DNS-deny policy, not an absent path |

Two mirrored allowlist trials are required: one authorizing the IPv4 sink only, one
authorizing the IPv6 sink only. Each must show the other family failing — a policy that
permits both proves nothing about the rule.

## 5. Procedure

0. **Capture control (once per host, before any trial).** From a non-sandboxed helper
   inside `vb-probe`, perform one TCP connection to sink A and one DNS query to the
   unauthorized resolver. Both must appear in the capture and counter setup used in
   §6.2. If they do not, the instrumentation is unverified and every zero-count result
   is invalid.
1. **Cold start.** Reboot, drop caches, create one environment with W1, measure from the
   supervisor's create call to the first byte of workload output, then teardown.
   `n = 10`, one reboot per trial.
2. **Warm start.** Same image present, no environment reuse: create → W2 → destroy.
   `n = 30`, randomized interleaving across runtimes to avoid drift.
3. **Memory and disk.** Create the run cgroup before the process, sample as defined in
   §6.1, and report the required decomposition and attribution class. Disk: workspace
   and block-device usage.
4. **Concurrency.** N ∈ {1, 2, 4, 8} concurrent W3, `n = 10` per N; record success rate
   and p95 start.
5. **Limits.** W4–W7 at the defaults in specification §5.4; record the value at which the
   environment terminated and whether the supervisor recorded a limit event.
6. **Cleanup.** After every trial enumerate processes, cgroups, TAP/veth devices, jail
   directories, containers, VMs, volumes and the workspace. Any residual resource is a
   failure, counted per trial.
7. **Default-deny network, case A.** With `policy: none` and no NIC, run W8–W11. Expected:
   no interface other than loopback; connects fail **immediately** with
   `ENETUNREACH`/`EHOSTUNREACH` (a timeout is a failure, because it implies a path
   exists); no sink access-log entry; and the DNS result is `path_absent` — nothing was
   emitted, and no attempted packet is claimed.
8. **Default-deny network, case B.** Configure the unauthorized resolver
   `10.213.0.53:53` inside the run, still confined to `vb-probe`, and run W17. Expected:
   a DNS packet at the run boundary, a matching policy drop counter, zero packets at the
   probe resolver or uplink, and no response — class `denied_at_policy`.
9. **Allowlist network.** Authorize exactly one destination (IPv4 sink A, port 8443, DNS
   `deny`, addresses pinned at the Control Plane); run W14 then W15. Repeat with the IPv6
   sink authorized. Expected: only the authorized destination answers; the same sink on
   another port, the second sink, the other address family and the metadata addresses
   fail; the hostname attempt is case B and must be `denied_at_policy`; the sink's access
   log shows exactly the authorized requests.
10. **Unintended-path check.** During W14/W16, capture on all host interfaces except the
    run's TAP and on the host uplink. Expected: zero packets from the run. Any packet is
    a policy failure, not a flake.
11. **Filesystem.** Canary files in the home directory, `/tmp` and a path outside the
    workspace. W12 must fail, and the canaries must be byte-identical afterwards.
12. **Operator burden.** On a clean host, follow only the published install steps; count
    commands, wall-clock minutes and every privileged step to a first successful W1.
13. **Baseline.** The same workloads on rootless Podman; record the delta. The baseline
    prices isolation; it is not a candidate.

## 6. Measurement definitions and reporting

### 6.1 Per-run memory attribution

Two scopes exist and they are **not interchangeable**. No subtraction crosses them.

| Scope | Path | Contains | Used for |
| --- | --- | --- | --- |
| `S_run` | `/sys/fs/cgroup/voldbase-bench/run-<id>` | the VMM process (Firecracker) or the container process tree (Podman), created before start and destroyed after teardown | per-run attributable memory |
| `S_root` | `/sys/fs/cgroup` | the whole host | context only: pressure and events |
| `S_guest` | — | guest-reported resident memory (balloon/agent), if available | observation only; never a gate input |

**Attributable memory.** `M_run_peak = memory.peak(S_run)`, read from the kernel counter of
that single cgroup. Nothing is subtracted: `S_run` is empty before the run, so it already
excludes other processes, and a host-wide idle figure is a different scope. The value
includes anonymous memory, file pages charged to the run, `pagetables`, `kernel_stack`,
`sock` and chargeable slab.

**Decomposition** at peak and after 5 s of steady state, from `memory.stat`: `anon`,
`file`, `shmem`, `kernel_stack`, `pagetables`, `slab`, `sock`. `memory.events` (`oom`,
`oom_kill`, `high`) and `memory.max` are recorded with it.

**Host-wide impact, reported separately.** `H_delta = max(memory.current(S_root) during
the run) − memory.current(S_root) immediately before create`, plus PSI
`memory.pressure` (some avg10) and root `memory.events`. This is pressure, not
attribution, and is never compared across runs with different co-tenants.

**Shared page cache and uncharged kernel memory.** cgroup v2 charges a file page to the
first cgroup that faults it, so pages shared with the host image store may be charged
elsewhere, and some kernel allocations are not charged to leaves at all. Consequently:

- `M_run_peak` is a **measured lower bound** on the run's system-wide memory impact;
- the **upper bound is unknown**. No numeric interval is constructed: subtracting a
  per-cgroup peak from a host-wide delta mixes two accounting scopes and then presents
  the remainder as if it were the run's uncharged memory. It is not, and no arithmetic
  in this protocol produces an upper bound.
- `H_delta`, PSI and root `memory.events` are reported as separate host-wide
  observations. They can show that the host was under pressure during a trial; they
  cannot be converted into a per-run byte count.

**Attribution classes.** No percentage threshold establishes exact attribution. A run can
produce a small `file` share and a `H_delta` close to `M_run_peak` while still leaving
shared page cache and uncharged kernel memory outside the cgroup, so a threshold would
label unmeasured bytes as measured.

| Class | Meaning | Reported figure |
| --- | --- | --- |
| `partial` | `M_run_peak` is a real measurement, but resident memory charged outside `S_run` is unquantified | `M_run_peak` as a lower bound, upper bound `unknown` |
| `unknown` | the decomposition, the host observation or the cross-check is missing or inconsistent | `unknown`; no numeric per-run claim |
| `exact` | every byte the run causes to be resident is measured inside `S_run` | possible only with the instrumentation in §6.1.1; **not achievable in this protocol version** |

**The default classification is `partial`.** It is `unknown` when `memory.stat` cannot be
read, when the matched idle control was not run, or when the decomposition does not
reconcile. `exact` is never inferred from `M_run_peak` alone.

#### 6.1.1 What exact attribution would require

Before any result may be labelled `exact`, all five of the following must exist as
implemented instrumentation and be demonstrated on a control run:

1. **An exclusive host.** No co-tenant workloads during the trial, plus a matched idle
   control — the same cgroup create/sample/destroy sequence with no workload — recorded
   alongside every trial, so host drift is bounded rather than assumed absent.
2. **Run-private page cache.** Image and rootfs bytes not shared with any other cgroup:
   a per-run copy, read into `S_run` after the cgroup is created, so `memory.stat.file`
   can be checked against a known byte count instead of trusted.
3. **Verified kernel-memory accounting.** `slab`, `pagetables`, `kernel_stack` and the
   device-side buffers a run causes (TAP queues, KVM allocations) charged to `S_run`,
   verified by reconciling the `memory.stat` components against `memory.current`.
4. **An independent PSS cross-check.** Proportional set size summed over the run's
   processes, with shared pages divided by their sharers, reconciling with `M_run_peak`
   within a tolerance fixed before the run. A residual means memory is still uncharged
   somewhere, and the class stays `partial`.
5. **Guest-memory accounting.** VMM-owned guest pages (a memfd for Firecracker)
   reconciled against configured guest RAM, so guest-resident memory is neither counted
   twice nor omitted.

Until those exist and are shown to agree, `exact` is unavailable and the figure is a
bound. Naming the instrumentation is the point: the gap is stated, not papered over.

**Always reported separately, never substituted for each other:** configured guest RAM
(manifest), VMM RSS peak (`VmRSS` sampled from `/proc/<pid>/status`), guest resident
memory (observation), `M_run_peak` with its decomposition and attribution class, and
`H_delta`/PSI/events.

**Budget.** The 128 MiB preliminary target is compared against `M_run_peak`, and may be
recorded as **met only when `attribution` is `exact`**. Under `partial` or `unknown` the
result is `memory_target: unknown`, with the range or the missing instrumentation named.
`unknown` is not a pass: it never satisfies a gate, never counts toward the 16 GiB
projection, and is never reported as "within budget".

**Limit enforcement** (RES-02) is judged from `memory.max`, `memory.peak` measured against
that cap, `memory.events` and the supervisor's termination record — never from RSS, and
never by subtracting anything.

### 6.2 DNS denial evidence

Two different claims are tested separately. A failed lookup is evidence of neither: it
may only mean that no resolver was configured.

**Case A — no network path.** With `policy: none` and no NIC or route, a resolution
attempt cannot emit a packet. The result is recorded as *path absent*: interfaces and
routes dumped, resolver inventory recorded, and capture on the run boundary, the probe
namespace and the uplinks showing zero packets. The claim is "there is no path", not "a
DNS packet was sent and denied", and no attempted packet is claimed when none was
emitted.

**Case B — explicit DNS-deny policy.** The workload is configured with the controlled
unauthorized resolver `10.213.0.53:53` and stays confined to `vb-probe`. Here a packet
**must** be observed at the run boundary, so the trial can distinguish an attempted query
from an absent path. A missing capture or counter is `inconclusive`, never a pass.

Each trial that claims either result produces a bundle with four parts.

| Part | Content |
| --- | --- |
| Resolver inventory | SHA-256 and contents of `/etc/resolv.conf`, `/etc/nsswitch.conf`, `/etc/hosts` collected as untrusted observations; "absent" is a recorded value |
| Run-side capture | `tcpdump` on the host end of the run's TAP/veth, filter `udp port 53 or tcp port 53`, plus a filter for any packet from the run's address |
| Boundary capture | the same filter on the probe-namespace interfaces and on the host uplink |
| Policy counters | nftables counters for the run's chain (accept and drop per rule), read before and after |

**Capture points, exactly:** (1) host side of the run TAP/veth; (2) each interface in
`vb-probe`; (3) each host uplink; (4) the nftables chain scoped to the run. A capture
that misses any of (1)–(3) is incomplete and yields `inconclusive`.

**Classification (one per trial):**

| Class | Boundary packets | nft drop counter | Probe/uplink packets | Response | Meaning |
| --- | --- | --- | --- | --- | --- |
| `path_absent` | 0 | 0 | 0 | none | case A: no interface or route, so nothing was emitted |
| `denied_at_policy` | > 0 | > 0 | 0 | none | case B: the query was attempted and the policy dropped it |
| `leaked` | any | any | > 0, or a resolver answered | any | **failure** |
| `inconclusive` | — | — | — | — | capture or counters missing, **or** case B with a configured resolver and zero boundary packets (the query was never attempted, so the trial proves nothing) |

**Expected observations:**

- Case A (no NIC, no route): `path_absent`. `denied_at_policy` is not achievable there and
  must not be claimed, because no packet existed to drop.
- Case B (resolver configured, policy denying): `denied_at_policy`, with the packet count,
  the drop count and the absence of any response recorded. Zero boundary packets is
  `inconclusive` — a test fault, not a pass.
- Allowlist with DNS `deny` and addresses pinned at the Control Plane: the hostname attempt
  is case B; a hostname must not resolve even though an IP is authorized.
- Any `leaked` result fails the trial regardless of what the application observed.

The **capture control in §5 step 0** is mandatory and is what makes a zero count
meaningful: without it, "no packet seen" is indistinguishable from "capture not working".
A missing DNS response is never accepted as proof of denied egress on its own.

### 6.3 Trials and reporting

- `n = 30` for warm start, memory, cleanup and network; `n = 10` for cold start; three
  warm-up iterations discarded and reported as discarded.
- Report **median, p95, min, max, interquartile range and failure count**. Never a mean
  alone. Report outliers and the exclusion criterion chosen before the run.
- Publish raw CSV or JSON with the report, including per-trial runtime identity, memory
  decomposition and attribution class, DNS evidence bundle, probe-namespace state and
  host state. A summary without raw data is not evidence.
- A failed trial is reported as a failure and is never re-run until it passes. Re-running
  a cell requires a documented cause (for example a thermal event) recorded in the report.
- Every figure carries one label: **measured**, **projected**, **vendor-quoted** or
  **unknown**. A figure with `partial` or `unknown` attribution is **unknown** with a
  bound, and no gate may pass on it.

## 7. Budgets

### 7.1 Reference-host gates and preliminary targets

Fixed before measurement. A **gate** decides selection. A **preliminary target** is
recorded and reported but does not by itself reject a candidate, because no measurement
exists on target hardware yet; promoting it to a gate requires the 16 GiB host run in
§7.2.

| Budget | Threshold | Type | Rationale |
| --- | --- | --- | --- |
| Warm start p95 | ≤ 750 ms | Gate | environment creation must not dominate a 10 s suite |
| Cold start p95 | ≤ 2 000 ms | Gate | the first run of a session may pay image setup |
| `M_run_peak` per idle run | ≤ 128 MiB, recorded as met only under `exact` attribution | **Preliminary target** | eight runs plus host overhead should fit a 16 GiB laptop; not yet measured there. Under `partial`/`unknown` attribution the result is `unknown`, which is not a pass |
| Concurrency on the reference host | 8 of 8 succeed | Gate | density floor |
| Limit enforcement | ≤ ±5% of declared value | Gate | RES-02..RES-04 |
| Cleanup residuals | 0 across 30 trials | Gate | LC-04, LC-09 |
| Network deny | `path_absent` (case A) or evidenced `denied_at_policy` (case B); never `leaked`; `inconclusive` fails | Gate | NET-01 |
| Allowlist exactness | every authorized destination works; every other fails | Gate | NET-02..NET-06 |
| Filesystem canaries | 0 reads, 0 writes | Gate | FS-04 |
| Operator steps | ≤ 10 documented commands, ≤ 30 minutes | **Preliminary target** | local-first usability, to be confirmed on a second host |

A candidate that exceeds a gate is not selected: ADR-0019 stays `Proposed`, and the
shortfall is reported with the raw data. A missed preliminary target is reported as a
product finding and carried into the review; it does not on its own change the decision.
Neither outcome may be reported as met — and no memory budget may be reported as passed —
while attribution is `partial` or `unknown`.

### 7.2 Reference host versus target user hardware

- The reference host (§2) exists to produce **measurements**. It has 32 GiB, the cgroup
  hierarchy of §6.1, and the 8-run concurrency gate is evaluated there.
- The **target user machine** is a 16 GiB developer laptop: not the measurement
  instrument, and not required for the decision.
- The 16 GiB fit is an **arithmetic projection** over a lower bound, labelled as such:
  `8 × M_run_peak_p95 + measured_os_baseline ≤ 90% of 16 GiB`. It can only refute a fit:
  if the lower bound alone already exceeds the threshold, the answer is `no`. Otherwise
  the projection is `projected_fit: unknown` under `partial` or `unknown` attribution,
  because a lower bound cannot demonstrate a fit. `unknown` must not be rounded up to
  `yes`.
- A 16 GiB host run is required before the memory target becomes a gate. That run is a
  prerequisite for changing the target, not for accepting the ADR.

## 8. Decision rule

1. Run this protocol on the reference host for Firecracker and Kata; run the rootless
   Podman baseline for B9.
2. If Firecracker meets every gate and Kata does not, Firecracker is named in the
   `Accepted` revision of ADR-0019.
3. If both meet every gate, the ADR's documented score stands unless measured scores for
   criteria 5–8 reverse the ranking; a reversal is documented with the measurements that
   caused it.
4. If neither meets every gate, no runtime is selected, Phase 3C does not start, and the
   shortfall becomes its own decision problem. Controls are not relaxed to fit a runtime.
5. If the reference host cannot provide KVM, the result is `BLOCKED` for that host class.
   There is no container fallback (ADR-0018 decision 2).
