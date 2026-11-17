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

No part of this protocol has been executed. Nothing in this document is a measurement.

## 1. Questions

| ID | Question | Feeds |
| --- | --- | --- |
| B1 | Cold and warm start latency for a realistic Node toolchain image | matrix criterion 6, budgets in §7 |
| B2 | Peak host memory and disk attributable to one run | criterion 6 |
| B3 | Successful concurrent runs at N = 1, 2, 4, 8 | criterion 7 |
| B4 | Are CPU, memory, PID and disk limits enforced at the declared values? | criterion 5 |
| B5 | Zero residual resources across 30 trials? | criterion 8 |
| B6 | Complete default-deny for IPv4, IPv6, DNS and metadata endpoints? | criterion 3 |
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
| Hygiene | No other workloads; CPU governor `performance`; record SMT state, microcode, kernel and mount options |
| Clock | `CLOCK_MONOTONIC` read by the supervisor, outside the environment |

Record per host: `uname -a`, `/proc/cpuinfo`, `lscpu`, `free -h`, `lsblk`, `mount`,
`/sys/fs/cgroup/cgroup.controllers`, `systemd --version`, and the checksum of every
runtime artifact.

## 3. Runtime identity

Identity is recorded from the runtime itself, not from memory.

| Runtime | Record |
| --- | --- |
| Podman | `podman --version`, `podman info --format json`, `crun --version`, storage driver, network backend and version |
| Docker rootless | `docker version`, `docker info`, `rootlesskit --version`, `slirp4netns --version`, cgroup driver |
| Firecracker | `firecracker --version`, SHA-256 of binary, jailer, guest kernel and rootfs; conversion-tool version |
| Kata | `kata-runtime --version` or `kata-collect-data.sh`, VMM binary and version, kernel, shim path, manager version |

## 4. Images and workloads

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
| W8 | `curl` to a public IP with a 3 s timeout, expect failure | IPv4 deny |
| W9 | resolve a hostname, expect failure | DNS deny |
| W10 | connect to an IPv6 literal, expect failure | IPv6 deny |
| W11 | read a canary file placed outside the workspace | filesystem boundary |
| W12 | sleep beyond `timeoutMs` | supervisor timeout path |

## 5. Procedure

1. **Cold start.** Reboot, drop caches, create one environment with W1, measure from the
   supervisor's create call to the first byte of workload output, then teardown.
   `n = 10`, one reboot per trial.
2. **Warm start.** Same image present, no environment reuse: create → W2 → destroy.
   `n = 30`, randomized interleaving across runtimes to avoid drift.
3. **Memory and disk.** Sample the runtime's host cgroup `memory.peak` and workspace or
   block-device usage at 100 ms intervals; report peak deltas against an idle baseline.
4. **Concurrency.** N ∈ {1, 2, 4, 8} concurrent W3, `n = 10` per N; record success rate
   and p95 start.
5. **Limits.** W4–W7 at the defaults in specification §5.4; record the value at which the
   environment terminated and whether the supervisor recorded a limit event.
6. **Cleanup.** After every trial enumerate processes, cgroups, TAP/veth devices, jail
   directories, containers, VMs, volumes and the workspace. Any residual resource is a
   failure, counted per trial.
7. **Network.** W8–W10 with `policy: none`, then with an allowlist for one host and port.
   Count successful egress and DNS queries observed on the host with `tcpdump`.
8. **Filesystem.** Canary files in the home directory, `/tmp` and a path outside the
   workspace. W11 must fail, and the canaries must be byte-identical afterwards.
9. **Operator burden.** On a clean host, follow only the published install steps; count
   commands, wall-clock minutes and every privileged step to a first successful W1.
10. **Baseline.** The same workloads on rootless Podman; record the delta. The baseline
    prices isolation; it is not a candidate.

## 6. Trials and reporting

- `n = 30` for warm start, memory, cleanup and network; `n = 10` for cold start; three
  warm-up iterations discarded and reported as discarded.
- Report **median, p95, min, max, interquartile range and failure count**. Never a mean
  alone. Report outliers and the exclusion criterion chosen before the run.
- Publish raw CSV or JSON with the report, including per-trial runtime identity and host
  state. A summary without raw data is not evidence.
- A failed trial is reported as a failure and is never re-run until it passes. Re-running
  a cell requires a documented cause (for example a thermal event) recorded in the report.
- The report labels its own numbers as measured, vendor-quoted or unknown.

## 7. Hard budgets, fixed before measurement

| Budget | Threshold | Rationale |
| --- | --- | --- |
| Warm start p95 | ≤ 750 ms | environment creation must not dominate a 10 s suite |
| Cold start p95 | ≤ 2 000 ms | the first run of a session may pay image setup |
| Memory overhead per idle run | ≤ 128 MiB | eight runs must fit a 16 GiB laptop |
| Concurrency | 8 of 8 succeed on the reference host | density floor |
| Limit enforcement | ≤ ±5% of declared value | RES-02..RES-04 |
| Cleanup residuals | 0 across 30 trials | LC-04, LC-09 |
| Network deny | 0 successful egress, 0 DNS queries | NET-01 |
| Filesystem canaries | 0 reads, 0 writes | FS-04 |
| Operator steps | ≤ 10 documented commands, ≤ 30 minutes | local-first usability |

A candidate that exceeds a budget is not selected: ADR-0019 stays `Proposed`, and the
shortfall is reported with the raw data.

## 8. Decision rule

1. Run this protocol on the reference host for Firecracker and Kata; run the rootless
   Podman baseline for B9.
2. If Firecracker meets every budget and Kata does not, Firecracker is named in the
   `Accepted` revision of ADR-0019.
3. If both meet every budget, the ADR's documented score stands unless measured scores for
   criteria 5–8 reverse the ranking; a reversal is documented with the measurements that
   caused it.
4. If neither meets every budget, no runtime is selected, Phase 3C does not start, and the
   shortfall becomes its own decision problem. Controls are not relaxed to fit a runtime.
5. If the reference host cannot provide KVM, the result is `BLOCKED` for that host class.
   There is no container fallback (ADR-0018 decision 2).
