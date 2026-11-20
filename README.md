# VOLDBASE

**Universal Experiment & Verification Infrastructure for software and AI projects.**

VOLDBASE turns "it should work" into evidence. You connect a GitHub repository or
import a local software project; VOLDBASE analyzes its structure, revision,
dependencies and configuration, identifies testable components, helps you design
reproducible experiments, and records what happened when (and if) they ran.

Every verification result is classified as exactly one of:

| Status | Meaning |
| --- | --- |
| `PASS` | The experiment ran under the recorded conditions and every stated expectation was met. |
| `FAIL` | The experiment ran and at least one stated expectation was not met. |
| `INCONCLUSIVE` | The experiment ran, but the observations do not support a definitive verdict. |
| `NOT_TESTED` | No execution was attempted. |
| `BLOCKED` | Execution was attempted but could not proceed (missing toolchain, unreachable dependency, isolation unavailable, …). |

`UNKNOWN`, "probably fine" and silent omissions are not valid results. If a
component was never exercised, the honest answer is `NOT_TESTED`, and VOLDBASE
should say so.

## Project status

**Phase 3B — isolation runtime decision.** Phases 1, 2A, 2B and 3A are implemented:
local import with reproducible snapshots, durable storage, syntax-level static
analysis, architecture intelligence, and the execution safety specification, through
the `import` / `list` / `show` / `analyze` / `analysis` / `architecture` CLI. The
current phase selects, and does not build, the future execution engine's isolation
runtime. It runs entirely on your machine: no account, no network, no telemetry.

**No project code is ever executed.** There is no executor, no install step and no
`child_process` in the product; the analyzer parses text, it does not run it, type
check it or resolve packages, and the architecture layer reads only that analysis
— never the project files again. Verifying experiments (Phases 3C onward) is still
ahead; see the [roadmap](#roadmap) and
[ADR-0005](docs/adr/0005-execution-isolation.md).

**Phase 3A adds no execution capability.** The
[execution safety specification](docs/security/execution-safety-specification-v1.md)
defines the trust boundaries, threat model, control matrix and acceptance tests a
future engine must satisfy before any project code may run. Nothing in this repository
implements it: there is no executor, no sandbox and no `PASS` — an experiment that was
never executed is `NOT_TESTED`.

**Phase 3B adds no runtime.** [ADR-0019](docs/adr/0019-isolation-runtime-selection.md)
compares rootless containers, Firecracker microVMs and Kata Containers against the
Phase 3A controls, excludes a shared kernel as the sole isolation boundary, and leaves
the product choice **pending** the reproducible benchmark it defines. No runtime, no
launcher and no sandbox dependency is added, and no project code is executed.

## What works today

```bash
$ voldbase import ~/code/demo
Imported project proj_df02e24be8d04a2390f3
  name        demo
  source      /home/me/code/demo
  revision    sha256:c5dfb407e8b95c551285a3ddcd1e4d1510fcdd9c67d8cf60f287f83644b001bf
  files       1842 (12.4 MiB)
  manifests   2
    npm       package.json                sha256:e55654f16429…
    npm       package-lock.json           sha256:9d1b0a17c3ef…
  skipped     3 excluded directories, 0 symbolic links

$ voldbase list
ID                          NAME                    REVISION              IMPORTED
proj_df02e24be8d04a2390f3   demo                    sha256:c5dfb407e8b9…  2026-11-15

$ voldbase show proj_df02e24be8d04a2390f3
Project proj_df02e24be8d04a2390f3
  name        demo
  source      local /home/me/code/demo
  revision    sha256:c5dfb407…44b001bf
  imported    2026-11-15T20:27:42.760Z
  manifests   2
    npm       package.json                sha256:e55654f1…
    npm       package-lock.json           sha256:9d1b0a17…

$ voldbase analyze proj_df02e24be8d04a2390f3
Analysed project proj_df02e24be8d04a2390f3 (demo)
  project      proj_df02e24be8d04a2390f3
  revision     sha256:c5dfb407e8b9…
  analyzer     1.0.0
  analysed     2026-11-16T09:00:00.000Z
  source       184 source files (javascript, typescript)
  declarations 1204
  imports      638 (512 resolved)
  findings     9 (0 error, 7 warning, 2 info)
  digest       sha256:41c0a7…
  Note: syntax-level analysis only. No findings does not mean the code is safe.
  voldbase analysis ana_7f31…   # findings in detail

$ voldbase analysis ana_7f31…
Analysis ana_7f31…
  …the same summary…
SEVERITY  RULE    LOCATION                                   EXPLANATION
WARNING   VB002   src/index.js:1:24                          This relative import does not
                                                             match any analysed file…
          evidence: ./missing

$ voldbase architecture ana_7f31…
Architecture of analysis ana_7f31…
  project     proj_df02e24be8d04a2390f3
  revision    sha256:c5dfb407e8b9…
  analysis    sha256:8eee98350f90…
  engine      1.0.0 (schema 1)
  files       61
  graph       192 edges, 194 imports merged
  modules     10
  cycles      0 (largest 0)
  isolated    2 files, 1 modules
  fan-in/out  max 28 / 29
  findings    17 (0 error, 0 warning, 17 info)
  digest      sha256:1d78a613b081…

MODULES (10)
ID                                FILES  FAN-IN  FAN-OUT  ISOLATED
src/application                   6      5       1        no
src/domain                        11     6       0        no
…

FINDINGS (17)
SEVERITY  RULE   CERTAINTY    SUBJECT              EXPLANATION
INFO      VA003  conditional  src/cli/main.ts      This file imports 18 other internal files…
          evidence: src/cli/main.ts -> src/application/ports.ts
…
```

## Installation

Requires **Node.js >= 22.18** (24 or 26 recommended). The package has exactly one
runtime dependency: `typescript`, used as the parser for JavaScript and TypeScript
(justified in [ADR-0016](docs/adr/0016-static-analysis-boundary.md)). It installs
no scripts and needs no network at run time.

VOLDBASE is **not published to npm**: `package.json` is `"private": true`, there is
no registry release and no tag. `npx voldbase` and `npm install -g voldbase`
therefore cannot work yet. Install it from a checkout:

```bash
git clone https://github.com/Zakariaika/Voldbase.git
cd Voldbase

npm ci          # install the runtime dependency (typescript) and @types/node
npm run build   # emit the distribution to dist/ (ADR-0010)

# 1. first run: the built CLI, straight from the checkout
node bin/voldbase.js help

# 2. optional: put `voldbase` on your PATH for this checkout
npm link
voldbase help
```

`bin/voldbase.js` loads the compiled CLI from `dist/`, not the TypeScript sources
(ADR-0010), so `npm run build` must run before the first command. A checkout
without `dist/` fails with a module-not-found error instead of running the
sources. `npm pack` — and therefore `npm install <checkout-dir>` or an install
from a tarball — rebuilds `dist/` through the `prepack` script, so a packed
artifact is never missing the code its `bin` entry imports.

Every command in this README is written as `voldbase …`; from a checkout run the
same command as `node bin/voldbase.js …`, or use the optional `npm link` above.
