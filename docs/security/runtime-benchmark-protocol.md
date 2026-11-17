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

No part of this protocol has been executed. Nothing in this document is a measurement.

## 1. Questions

| ID | Question | Feeds |
| --- | --- | --- |
| B1 | Cold and warm start latency for a realistic Node toolchain image | matrix criterion 6, budgets in §7 |
| B2 | Incremental host memory and disk attributable to one run | criterion 6 |
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
| No resolver | — | No DNS server is reachable from the probe namespace |
| No forwarding | — | `ip_forward=0`, no NAT/MASQUERADE, nftables default-drop, no route to the host uplink |

Properties that make the environment safe and reproducible:

- **Deterministic content.** Sink A returns exactly `voldbase-probe-v1\n`; its SHA-256 is
  recorded in the report and checked by the workload.
- **No production or public target.** The addresses are from a documentation-reserved
  range used only inside the probe namespace; nothing is forwarded outside it.
- **No unintended path into the guest.** The run's TAP (Firecracker) or veth (container)
  is attached to the probe namespace only. The sink processes live in that namespace, not
  on the host uplink, and cannot reach the host loopback.
- **Recorded state.** Before the first trial the report records the namespace's
  interfaces, routes and full `nft list ruleset`; the same dump is taken after each trial
  and must be identical except for per-run entries.
- **No DNS dependency for setup.** Image pulls, if any, happen before the trial and
  outside the probe namespace; a trial that needs the network to prepare is invalid.

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
| W9 | **deny** — resolve `probe.test`, expect name-resolution failure with no query observed | DNS default-deny |
| W10 | **deny** — TCP connect to `[fd00:213::10]:8443`, expect `ENETUNREACH` | IPv6 default-deny |
| W11 | **deny** — connect to `169.254.169.254:80`, `[fd00:ec2::254]:80`, `100.100.100.200:80`, resolve `metadata.google.internal` | metadata-endpoint blocking |
| W12 | read a canary file placed outside the workspace | filesystem boundary |
| W13 | sleep beyond `timeoutMs` | supervisor timeout path |
| W14 | **allowlist positive** — `GET http://10.213.0.10:8443/health`, expect 200 and the recorded body digest | authorized egress works |
| W15 | **allowlist negative** — `10.213.0.10:9443`, `10.213.0.11:8443`, `[fd00:213::10]:8443`, W11 addresses, and `probe.test` | authorization is address-, port- and family-scoped; DNS stays denied |
| W16 | host capture on every interface except the run's TAP during W14 | no unintended network path |

Two mirrored allowlist trials are required: one authorizing the IPv4 sink only, one
authorizing the IPv6 sink only. Each must show the other family failing — a policy that
permits both proves nothing about the rule.

## 5. Procedure

1. **Cold start.** Reboot, drop caches, create one environment with W1, measure from the
   supervisor's create call to the first byte of workload output, then teardown.
   `n = 10`, one reboot per trial.
2. **Warm start.** Same image present, no environment reuse: create → W2 → destroy.
   `n = 30`, randomized interleaving across runtimes to avoid drift.
3. **Memory and disk.** Sample the run's host cgroup `memory.peak` and workspace or
   block-device usage at 100 ms (§6.1 defines the baseline). Report the incremental
   value, the configured guest RAM and the VMM RSS separately.
4. **Concurrency.** N ∈ {1, 2, 4, 8} concurrent W3, `n = 10` per N; record success rate
   and p95 start.
5. **Limits.** W4–W7 at the defaults in specification §5.4; record the value at which the
   environment terminated and whether the supervisor recorded a limit event.
6. **Cleanup.** After every trial enumerate processes, cgroups, TAP/veth devices, jail
   directories, containers, VMs, volumes and the workspace. Any residual resource is a
   failure, counted per trial.
7. **Default-deny network.** With `policy: none`, run W8–W11 and inspect the probe
   namespace. Expected: no interface other than loopback, every connect fails
   **immediately** with `ENETUNREACH`/`EHOSTUNREACH`, DNS fails without a resolver, no
   sink log entry exists, and no packet from the environment appears on any host capture
   point. A **timeout rather than an unreachable error is a failure**, because it implies
   a path exists and packets were dropped.
8. **Allowlist network.** Authorize exactly one destination (IPv4 sink A, port 8443,
   DNS `deny`, addresses pinned at the Control Plane) and run W14 then W15. Repeat with
   the IPv6 sink authorized. Expected: only the authorized destination answers; the
   same sink on another port, the second sink, the other address family, the metadata
   addresses and every hostname fail; the sink's access log shows exactly the authorized
   requests.
9. **Unintended-path check.** During W14/W16, capture on all host interfaces except the
   run's TAP and on the host uplink. Expected: zero packets from the run. Any packet is a
   policy failure, not a flake.
10. **Filesystem.** Canary files in the home directory, `/tmp` and a path outside the
    workspace. W12 must fail, and the canaries must be byte-identical afterwards.
11. **Operator burden.** On a clean host, follow only the published install steps; count
    commands, wall-clock minutes and every privileged step to a first successful W1.
12. **Baseline.** The same workloads on rootless Podman; record the delta. The baseline
    prices isolation; it is not a candidate.

## 6. Measurement definitions and reporting

### 6.1 Incremental memory

- **Metric.** `incremental_bytes = cgroup.memory.peak(run scope) − idle_baseline`, where
  `idle_baseline` is the median of `cgroup.memory.current` sampled every 100 ms for
  5 minutes on an idle host immediately before the trial.
- **What it includes.** Total host memory attributable to the run: VMM or runtime
  process, guest RAM actually resident, page tables, device emulation and per-run
  buffers. It is **not** the configured guest RAM.
- **Reported separately** for diagnosis: configured guest RAM, VMM RSS peak, and
  workspace/block-device size. These are components of the metric, never substitutes
  for it.
- **Sampling.** 100 ms, from outside the environment; peak taken over the steady window
  between environment start and teardown, excluding the first and last second.

### 6.2 Trials

- `n = 30` for warm start, memory, cleanup and network; `n = 10` for cold start; three
  warm-up iterations discarded and reported as discarded.
- Report **median, p95, min, max, interquartile range and failure count**. Never a mean
  alone. Report outliers and the exclusion criterion chosen before the run.
- Publish raw CSV or JSON with the report, including per-trial runtime identity, probe
  namespace state and host state. A summary without raw data is not evidence.
- A failed trial is reported as a failure and is never re-run until it passes. Re-running
  a cell requires a documented cause (for example a thermal event) recorded in the report.
- The report labels its own numbers as measured, vendor-quoted, projected or unknown.

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
| Incremental host memory per idle run | ≤ 128 MiB | **Preliminary target** | eight runs plus host overhead should fit a 16 GiB laptop; not yet measured there |
| Concurrency on the reference host | 8 of 8 succeed | Gate | density floor |
| Limit enforcement | ≤ ±5% of declared value | Gate | RES-02..RES-04 |
| Cleanup residuals | 0 across 30 trials | Gate | LC-04, LC-09 |
| Network deny | 0 egress, 0 DNS queries, 0 packets outside the TAP | Gate | NET-01 |
| Allowlist exactness | every authorized destination works; every other fails | Gate | NET-02..NET-06 |
| Filesystem canaries | 0 reads, 0 writes | Gate | FS-04 |
| Operator steps | ≤ 10 documented commands, ≤ 30 minutes | **Preliminary target** | local-first usability, to be confirmed on a second host |

A candidate that exceeds a gate is not selected: ADR-0019 stays `Proposed`, and the
shortfall is reported with the raw data. A missed preliminary target is reported as a
product finding and carried into the review; it does not on its own change the decision.

### 7.2 Reference host versus target user hardware

- The reference host (§2) exists to produce **measurements**. It has 32 GiB, and the
  8-run concurrency gate is evaluated there.
- The **target user machine** is a 16 GiB developer laptop, which is not the measurement
  instrument and is not required for the decision.
- The 16 GiB fit is an **arithmetic projection**, not a measurement:
  `8 × incremental_p95 + measured_os_baseline ≤ 90% of 16 GiB`. It is reported as
  `projected_fit: yes|no|unknown`, with the inputs shown.
- `unknown` is a valid result and must not be rounded up to `yes`.
- A 16 GiB host run is required before the memory target is promoted to a gate; that run
  is a prerequisite for changing the target, not for accepting the ADR.

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
