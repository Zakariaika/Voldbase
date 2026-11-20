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

For the pinned webpack revision, a previous audit reported 26,513 tracked candidate source paths after correcting a path-with-spaces counting error. The earlier figure of 17,324 is not valid. This count is a preflight observation, not a performance measurement or proof of the final scanner count.

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

if IMPORT_OUTPUT="$(node bin/voldbase.js import "$WEBPACK_DIR" 2>&1)"; then
  printf '%s\n' "$IMPORT_OUTPUT"
else
  IMPORT_STATUS=$?
  printf '%s\n' "$IMPORT_OUTPUT"
  printf 'Import failed with exit code %s\n' "$IMPORT_STATUS"
  exit 0
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
  echo "BLOCKED: could not extract a newly imported project ID."
  exit 0
fi

printf 'PROJECT_ID=%s\n' "$PROJECT_ID"
```

The expected import line is:

```text
Imported project proj_...
```

Do not use a pattern expecting `Project proj_...`. The latter does not match the import command's output.

If import fails because the scanner's 20,000-file limit is exceeded, record:

```text
Result: BLOCKED
Stage: import
Reason: scan_limit_exceeded
```

Do not proceed to analysis and do not report analysis timings.

## 7. Analysis eligibility

Before collecting timings, verify that the imported project can be analyzed:

```bash
node bin/voldbase.js analyze "$PROJECT_ID"
```

If analysis fails with `analysis_limit_exceeded`, record:

```text
Result: BLOCKED
Stage: static analysis
Reason: analysis_limit_exceeded
```

Do not report a successful analysis benchmark.

A blocked result is a valid benchmark outcome. It is not a performance result and must not be converted into a zero, an estimated duration, or a successful run.

## 8. Analysis measurements

Only proceed if import and analysis eligibility checks succeed.

Perform 3 warm-up runs, followed by 20 measured runs.

The measured operation is the complete CLI analysis command. It includes the CLI, analysis service, parsing, and local persistence. It is not a parser-only microbenchmark.

```bash
RESULTS="$WORK_DIR/analysis-results.tsv"
: > "$RESULTS"

for i in 1 2 3; do
  /usr/bin/time -f '%e\t%M' \
    -o "$WORK_DIR/warmup-$i.time" \
    node bin/voldbase.js analyze "$PROJECT_ID" \
    > "$WORK_DIR/warmup-$i.log"
done

for i in $(seq 1 20); do
  /usr/bin/time -f '%e\t%M' \
    -o "$WORK_DIR/run-$i.time" \
    node bin/voldbase.js analyze "$PROJECT_ID" \
    > "$WORK_DIR/run-$i.log"

  printf '%s\t' "$i" >> "$RESULTS"
  cat "$WORK_DIR/run-$i.time" >> "$RESULTS"
done
```

The TSV columns are:

1. Run number.
2. Elapsed wall-clock seconds.
3. Maximum resident set size in KiB, as reported by GNU `/usr/bin/time`.

Keep all raw logs and timing files. Do not silently discard failed runs.

## 9. Architecture determinism

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

Use the nearest-rank percentile convention:

`rank = ceil(p × n)`

For p95 with 20 observations, report the 19th value after sorting in ascending order.

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
