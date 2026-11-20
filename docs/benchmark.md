# VOLDBASE Benchmark Protocol

**Status:** Protocol published; performance measurements not yet published.

**Benchmark scope:** Local import, syntax-level analysis, and architecture output.

**VOLDBASE commit:** `7e72e5ae4d1737ac8e4769d1f508107dd35e9667`

**Sample repository:** webpack

**Sample commit:** `c443ac35551c90e540837dbdbc88a9ed907cb762`

## 1. Purpose and scope

This protocol defines a reproducible procedure for measuring VOLDBASE's current local workflow:

1. Import a source repository.
2. Run syntax-level static analysis.
3. Generate architecture JSON.
4. Verify that repeated architecture generation is deterministic.

This is not a benchmark of code execution, sandboxing, containers, microVMs, or runtime isolation. VOLDBASE does not execute imported project code.

No performance result is claimed by publishing this protocol. Results must be collected and published separately with raw measurements and host details.

## 2. Pinned inputs

The benchmark must use the exact commits listed above.

Verify the VOLDBASE checkout:

```bash
git rev-parse HEAD
```

Expected:

```text
7e72e5ae4d1737ac8e4769d1f508107dd35e9667
```

Verify the webpack checkout:

```bash
git -C "$WEBPACK_DIR" rev-parse HEAD
```

Expected:

```text
c443ac35551c90e540837dbdbc88a9ed907cb762
```

Do not benchmark a moving branch or an unpinned dependency revision.

## 3. Environment capture

Record the following before running the benchmark:

```bash
date -u
uname -a
node --version
npm --version
lscpu
free -h
df -h .
```

Also record:

- CPU model and logical CPU count.
- Physical RAM.
- Operating system and kernel.
- Node.js and npm versions.
- Storage type, where known.
- Whether the machine was under other significant workloads.

CI currently tests Node.js `22.x`, `24.x`, and `26.x`. Its clean-checkout smoke job uses `24.x`.

These are CI version ranges, not a claim that CI is pinned to `v24.22.2`. The benchmark report must state the exact output of `node --version` on the benchmark host.

The package requires Node.js `>=22.18.0`.

## 4. Prepare the repositories

Use a clean working directory:

```bash
set -euo pipefail

WORK_DIR="$(mktemp -d)"
VOLDBASE_DIR="$WORK_DIR/Voldbase"
WEBPACK_DIR="$WORK_DIR/webpack"

git clone https://github.com/Zakariaika/Voldbase.git "$VOLDBASE_DIR"
git -C "$VOLDBASE_DIR" checkout --detach 7e72e5ae4d1737ac8e4769d1f508107dd35e9667

git clone https://github.com/webpack/webpack.git "$WEBPACK_DIR"
git -C "$WEBPACK_DIR" checkout --detach c443ac35551c90e540837dbdbc88a9ed907cb762

test "$(git -C "$VOLDBASE_DIR" rev-parse HEAD)" = "7e72e5ae4d1737ac8e4769d1f508107dd35e9667"
test "$(git -C "$WEBPACK_DIR" rev-parse HEAD)" = "c443ac35551c90e540837dbdbc88a9ed907cb762"

test -z "$(git -C "$VOLDBASE_DIR" status --porcelain)"
test -z "$(git -C "$WEBPACK_DIR" status --porcelain)"
```

Install and verify VOLDBASE:

```bash
cd "$VOLDBASE_DIR"

npm ci
npm run typecheck
npm run build
npm test
```

If any command fails, stop. Record the failure and do not publish performance measurements as if the benchmark completed.

## 5. File-count preflight

VOLDBASE has two distinct limits relevant to this sample:

- Import scanner: at most 20,000 files in one project snapshot.
- Static analyzer: at most 5,000 supported source files.

The supported source extensions are:

`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`.

The following script counts tracked candidate source paths without splitting paths on spaces:

```bash
python3 - "$WEBPACK_DIR" <<'PY'
import subprocess
import sys
from pathlib import PurePosixPath

root = sys.argv[1]
extensions = {
    ".js", ".jsx", ".mjs", ".cjs",
    ".ts", ".tsx", ".mts", ".cts",
}

raw = subprocess.check_output(
    ["git", "-C", root, "ls-files", "-z"]
)

paths = [p for p in raw.split(b"\0") if p]
source_paths = [
    p for p in paths
    if PurePosixPath(p.decode("utf-8", "surrogateescape")).suffix.lower()
    in extensions
]

print(f"Tracked files: {len(paths)}")
print(f"Tracked candidate source files: {len(source_paths)}")
PY
```

This is a Git-tracked candidate count, not the analyzer's final discovered-file count. VOLDBASE excludes certain directories, including `node_modules`, `dist`, `build`, `coverage`, and VCS directories. Therefore, the preflight count must not be presented as the exact number VOLDBASE analyzed.

For the pinned webpack revision, the preflight script reports 26,514 tracked candidate source paths, verified by re-running the script against that exact commit. The earlier figure of 17,324 is not valid and must not be cited. This count is a preflight observation, not a performance measurement or proof of the final scanner count.

The benchmark must still run the actual VOLDBASE import and analysis checks below. The first real limit reached determines the blocking stage.

## 6. Import eligibility

Use a fresh, isolated VOLDBASE store:

```bash
export VOLDBASE_HOME="$WORK_DIR/voldbase-home"
mkdir -p "$VOLDBASE_HOME"
```

Import the pinned sample:

```bash
cd "$VOLDBASE_DIR"

set +e
IMPORT_OUTPUT="$(node bin/voldbase.js import "$WEBPACK_DIR" 2>&1)"
IMPORT_STATUS=$?
set -e

printf '%s\n' "$IMPORT_OUTPUT"
printf 'Import exit status: %s\n' "$IMPORT_STATUS"

if [ "$IMPORT_STATUS" -ne 0 ]; then
  if printf '%s' "$IMPORT_OUTPUT" | grep -q 'scan_limit_exceeded'; then
    printf 'Result: BLOCKED\n'
    printf 'Stage: import\n'
    printf 'Reason: scan_limit_exceeded\n'
  else
    printf 'Result: BLOCKED\n'
    printf 'Stage: import\n'
    printf 'Reason: import_failed\n'
  fi
  printf 'Exit status: %s\n' "$IMPORT_STATUS"
  exit "$IMPORT_STATUS"
fi
```

Extract the project ID from the actual import output:

```bash
PROJECT_ID="$(
  printf '%s\n' "$IMPORT_OUTPUT" |
  sed -n 's/^Imported project \(proj_[[:alnum:]]*\)$/\1/p' |
  tail -n 1
)"

if [ -z "$PROJECT_ID" ]; then
  printf 'Result: BLOCKED\n'
  printf 'Stage: import\n'
  printf 'Reason: project_id_not_extracted\n'
  exit 1
fi

printf 'PROJECT_ID=%s\n' "$PROJECT_ID"
```

The expected import line is:

```text
Imported project proj_...
```

Do not use a pattern expecting `Project proj_...`. The latter does not match the import command's output.

If import fails because the scanner's 20,000-file limit is exceeded, the script above records:

```text
Result: BLOCKED
Stage: import
Reason: scan_limit_exceeded
```

A failed import is never treated as a completed step: the exit status is printed and preserved, the attempt is classified `BLOCKED` because the import prerequisite or a configured limit prevented it, and the script exits with the import's own status. No warm-up, no measured run and no reported timing follows a failed import.

Do not proceed to analysis and do not report analysis timings.

## 7. Analysis eligibility

Before collecting timings, verify that the imported project can be analyzed. The exit status is captured explicitly, so a failed eligibility check stops the protocol instead of being timed as if it had succeeded:

```bash
set +e
ANALYZE_OUTPUT="$(node bin/voldbase.js analyze "$PROJECT_ID" 2>&1)"
ANALYZE_STATUS=$?
set -e

printf '%s\n' "$ANALYZE_OUTPUT"
printf 'Analyze exit status: %s\n' "$ANALYZE_STATUS"

if [ "$ANALYZE_STATUS" -ne 0 ]; then
  if printf '%s' "$ANALYZE_OUTPUT" | grep -q 'analysis_limit_exceeded'; then
    printf 'Result: BLOCKED\n'
    printf 'Stage: static analysis\n'
    printf 'Reason: analysis_limit_exceeded\n'
  else
    printf 'Result: FAIL\n'
    printf 'Stage: static analysis\n'
    printf 'Reason: analyze exited with status %s\n' "$ANALYZE_STATUS"
  fi
  printf 'Exit status: %s\n' "$ANALYZE_STATUS"
  exit "$ANALYZE_STATUS"
fi
```

If analysis fails with `analysis_limit_exceeded`, record:

```text
Result: BLOCKED
Stage: static analysis
Reason: analysis_limit_exceeded
```

Do not report a successful analysis benchmark.

A blocked result is a valid benchmark outcome. It is not a performance result and must not be converted into a zero, an estimated duration, or a successful run.

A non-zero exit status from either eligibility stage ends this run: sections 8 and 9 are not executed, and no timing of any kind is reported. A configured limit is recorded as `BLOCKED`; an analyzer that started and then failed for another reason is recorded as `FAIL` (section 11), with its exit status.

## 8. Analysis measurements

Only proceed if import and analysis eligibility checks succeed.

Perform 3 warm-up runs, followed by 20 measured runs.

The measured operation is the complete CLI analysis command. It includes the CLI, analysis service, parsing, and local persistence. It is not a parser-only microbenchmark.

Section 4 enables `set -e`, and GNU `/usr/bin/time` exits with the status of the command it wraps. Each run is therefore wrapped in `set +e` / `set -e` so that a failed run is recorded and classified instead of aborting the protocol without a result.

```bash
RESULTS="$WORK_DIR/analysis-results.tsv"
: > "$RESULTS"

WARMUP_RESULTS="$WORK_DIR/warmup-status.tsv"
: > "$WARMUP_RESULTS"

for i in 1 2 3; do
  set +e
  /usr/bin/time -f '%e\t%M' \
    -o "$WORK_DIR/warmup-$i.time" \
    node bin/voldbase.js analyze "$PROJECT_ID" \
    > "$WORK_DIR/warmup-$i.log" 2>&1
  STATUS=$?
  set -e

  printf '%s\t%s\n' "$i" "$STATUS" >> "$WARMUP_RESULTS"

  if [ "$STATUS" -ne 0 ]; then
    printf 'Result: FAIL\n'
    printf 'Stage: analysis measurements (warm-up run %s)\n' "$i"
    printf 'Reason: warm-up exited with status %s\n' "$STATUS"
    printf 'Exit status: %s\n' "$STATUS"
    exit "$STATUS"
  fi
done

FAILED_RUNS=0
FAILED_RUN_LIST="$WORK_DIR/analysis-failures.tsv"
: > "$FAILED_RUN_LIST"

for i in $(seq 1 20); do
  set +e
  /usr/bin/time -f '%e\t%M' \
    -o "$WORK_DIR/run-$i.time" \
    node bin/voldbase.js analyze "$PROJECT_ID" \
    > "$WORK_DIR/run-$i.log" 2>&1
  STATUS=$?
  set -e

  if [ "$STATUS" -eq 0 ]; then
    printf '%s\t' "$i" >> "$RESULTS"
    cat "$WORK_DIR/run-$i.time" >> "$RESULTS"
  else
    FAILED_RUNS=$((FAILED_RUNS + 1))
    printf '%s\t%s\n' "$i" "$STATUS" >> "$FAILED_RUN_LIST"
  fi
done

printf 'Failed runs: %s of 20\n' "$FAILED_RUNS"

if [ "$FAILED_RUNS" -ne 0 ]; then
  cat "$FAILED_RUN_LIST"
  printf 'Result: FAIL\n'
  printf 'Stage: analysis measurements\n'
  printf 'Reason: %s of 20 measured runs failed; see %s\n' \
    "$FAILED_RUNS" "$FAILED_RUN_LIST"
  exit 1
fi
```

The TSV columns are:

1. Run number.
2. Elapsed wall-clock seconds.
3. Maximum resident set size in KiB, as reported by GNU `/usr/bin/time`.

Keep all raw logs and timing files, including `warmup-<n>.log`, `warmup-<n>.time`, `run-<n>.log`, `run-<n>.time`, `warmup-status.tsv` and `analysis-failures.tsv`. A failed run keeps its log and time file, and its exit status is recorded in `analysis-failures.tsv`. Do not silently discard failed runs.

A failed run is never counted as a successful observation. If any measured run fails, the attempt is classified `FAIL` under section 11, the completed-run count is 20 minus the failed-run count, and no statistic may be presented with n = 20.

## 9. Architecture determinism

This stage is reached only when the eligibility check and all 23 runs exited 0; `run-20.log` exists only then.

Extract the analysis ID from a successful analysis output:

```bash
ANALYSIS_ID="$(
  sed -n 's/^  voldbase analysis \(ana_[[:alnum:]]*\).*/\1/p' \
    "$WORK_DIR/run-20.log" |
  tail -n 1
)"

test -n "$ANALYSIS_ID"
```

Generate the architecture JSON twice from the same stored analysis:

```bash
node bin/voldbase.js architecture "$ANALYSIS_ID" --format json \
  > "$WORK_DIR/architecture-1.json"

node bin/voldbase.js architecture "$ANALYSIS_ID" --format json \
  > "$WORK_DIR/architecture-2.json"

cmp "$WORK_DIR/architecture-1.json" "$WORK_DIR/architecture-2.json"

sha256sum \
  "$WORK_DIR/architecture-1.json" \
  "$WORK_DIR/architecture-2.json"
```

A successful byte comparison supports deterministic output for this exact stored analysis and configuration. It does not prove semantic correctness or general determinism across all projects and environments.

## 10. Statistical reporting

For the 20 measured analysis runs, report:

- Median elapsed time.
- p95 elapsed time.
- Minimum and maximum elapsed time.
- Interquartile range (IQR).
- Median and maximum reported RSS.
- Failed-run count.

Use the nearest-rank percentile convention for every reported quantile:

`rank = ceil(p × n)`

For p95 with 20 observations, report the 19th value after sorting in ascending order.

The IQR uses the same nearest-rank convention, applied to the sorted elapsed times in column 2 of the TSV:

`Q1 = value at rank ceil(0.25 × n)`, `Q3 = value at rank ceil(0.75 × n)`, `IQR = Q3 − Q1`.

Values are read at those ranks without interpolation. For n = 20 that is Q1 = the 5th value, Q3 = the 15th value and IQR = 15th − 5th; the median (p50) is the 10th value (rank ceil(0.5 × 20) = 10), not the average of the 10th and 11th. State this convention in the report so the numbers can be reproduced.

If any measured run failed, do not compute these statistics as though all 20 runs completed and do not present n = 20. Report the failed-run count, the number of completed runs, and any statistic labelled with its actual n; the attempt is classified `FAIL` under section 11.

Do not report the arithmetic mean alone. Do not remove outliers unless the exclusion rule was written before the benchmark and every excluded observation is disclosed.

## 11. Required result classification

Every benchmark attempt must receive one of these classifications:

| Result | Meaning |
| --- | --- |
| `PASS` | The specified operation completed and all stated checks passed. |
| `FAIL` | The operation ran but a required check failed. |
| `BLOCKED` | The operation could not proceed because a defined limit or prerequisite prevented it. |
| `INCONCLUSIVE` | The evidence is incomplete or does not support a reliable conclusion. |

A blocked webpack import or analysis must be reported as `BLOCKED`, with the exact stage and error code. It must not be described as a slow successful analysis.

## 12. Methodological limitations

This protocol has the following limitations:

1. It uses one pinned sample repository and one pinned revision.
2. Results from one host do not establish performance on other hardware.
3. Twenty measured runs provide a limited sample; tail estimates are not universal guarantees.
4. GNU `time` maximum RSS is a process-level measurement, not total system memory attribution.
5. Import and analysis are different operations and must not be combined into one performance figure.
6. The tracked-file preflight count is not identical to the scanner's effective file count.
7. The analyzer is syntax-level. It does not execute project code, install dependencies, perform TypeScript type checking, or resolve package internals.
8. Architecture output is derived only from imports classified as resolved relative imports.
9. Byte-identical output does not prove semantic correctness.
10. A blocked sample says that the current configured limits prevent that workload from reaching the measured stage. It does not establish how fast the workload would run if those limits were different.
11. No comparison with another analyzer or tool is valid unless the same pinned source, host, workload, and measurement scope are used.
12. This protocol does not measure the future VOLDBASE isolation runtime.

## 13. Publication requirements

A benchmark report must include:

- Exact VOLDBASE and sample repository commit SHAs.
- Host and operating-system details.
- Exact Node.js and npm versions.
- Full commands used.
- Warm-up and measured iteration counts.
- Raw TSV results and relevant command logs.
- Failure and blocking details.
- Statistical calculations and percentile convention.
- Architecture JSON comparison and hashes, if that stage was reached.
- Any deviations from this protocol.

Do not publish a performance claim without the raw data supporting it.

Current publication status: This document specifies the procedure. It does not claim that performance measurements have been completed or that a performance target has been met.
