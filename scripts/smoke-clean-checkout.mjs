#!/usr/bin/env node
/**
 * Clean-checkout smoke test — PR 1 (distribution and first-run usability).
 *
 * The distribution tests in `tests/` run against a tree that has already been
 * built, so they cannot catch a broken first run: a missing `dist/`, a `bin`
 * entry that no longer resolves, or an install step that a fresh clone needs but
 * the repository does not document. This script starts from the opposite state.
 *
 * It:
 *   1. refuses to run on a dirty working tree (a "clean checkout" must be
 *      reproducible), then clones the current commit into a temporary directory;
 *   2. runs `npm ci` and `npm run build` there, with no node_modules and no
 *      dist/ to start from;
 *   3. imports and analyses a small prepared project, then runs
 *      `architecture <analysis-id> --format json` through the built
 *      `bin/voldbase.js`;
 *   4. validates that the command exits 0, that stdout is valid JSON with
 *      canonical (recursively sorted) keys, that it describes the prepared
 *      graph, and that a second run is byte-identical.
 *
 * Nothing is written outside the temporary directory or VOLDBASE_HOME inside it.
 * No project code is executed: the fixture is only read, parsed and hashed.
 *
 * Usage:
 *   node scripts/smoke-clean-checkout.mjs [--ref <git-ref>] [--keep]
 *
 *   --ref <git-ref>  Commit to clone (default: HEAD).
 *   --keep           Keep the temporary checkout and print its path.
 *
 * Exit codes: 0 success, 1 a step failed, 2 usage error.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const USAGE =
  'usage: node scripts/smoke-clean-checkout.mjs [--ref <git-ref>] [--keep]';

class SmokeError extends Error {}

function fail(message) {
  throw new SmokeError(message);
}

function parseArguments(argv) {
  const options = { ref: 'HEAD', keep: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--keep') {
      options.keep = true;
      continue;
    }
    if (argument === '--ref') {
      const value = argv[index + 1];
      if (value === undefined || value === '') {
        fail(`--ref needs a value\n${USAGE}`);
      }
      options.ref = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--ref=')) {
      const value = argument.slice('--ref='.length);
      if (value === '') {
        fail(`--ref needs a value\n${USAGE}`);
      }
      options.ref = value;
      continue;
    }

    fail(`unknown argument '${argument}'\n${USAGE}`);
  }

  return options;
}

/** Run a command and fail with its output when it does not exit 0. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    fail(
      `command failed (exit ${String(result.status)}): ${command} ${args.join(' ')}` +
        (output === '' ? '' : `\n--- output ---\n${output}\n--------------`),
    );
  }

  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function step(message) {
  process.stdout.write(`→ ${message}\n`);
}

function writeFileTree(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }
}

/**
 * The prepared analysis input. Two of the files import each other, so the
 * architecture report must contain a real cycle as well as plain edges — a JSON
 * document of the right shape is not enough.
 */
function createFixture(root) {
  writeFileTree(root, {
    'package.json': '{"name":"smoke-fixture","private":true}\n',
    'src/index.js': "import { double } from './util.js';\n\nexport const answer = double(21);\n",
    'src/util.js': 'export function double(value) {\n  return value * 2;\n}\n',
    'src/counter.js': "import { read } from './store.js';\n\nexport function count() {\n  return read() + 1;\n}\n",
    'src/store.js': "import { count } from './counter.js';\n\nexport function read() {\n  return count() + 1;\n}\n",
  });
}

function assert(condition, message) {
  if (!condition) {
    fail(`assertion failed: ${message}`);
  }
}

function assertSortedKeys(value, where) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSortedKeys(item, `${where}[${String(index)}]`));
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }

  const keys = Object.keys(value);
  const sorted = [...keys].sort();
  assert(
    keys.length === sorted.length && keys.every((key, index) => key === sorted[index]),
    `object keys must be sorted at ${where}; saw ${keys.join(', ')}`,
  );
  for (const key of keys) {
    assertSortedKeys(value[key], `${where}.${key}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  const dirty = run('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: REPO_ROOT,
  }).stdout.trim();
  assert(
    dirty === '',
    'the working tree must be clean so the clone is a real checkout; commit or stash:\n' +
      dirty,
  );

  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'voldbase-smoke-'));
  const checkout = path.join(temporaryRoot, 'checkout');
  const fixture = path.join(temporaryRoot, 'fixture');
  const home = path.join(temporaryRoot, 'home');
  let succeeded = false;

  try {
    step(`cloning ${REPO_ROOT} → ${checkout}`);
    run('git', ['clone', '--quiet', '--no-hardlinks', REPO_ROOT, checkout], {
      cwd: temporaryRoot,
    });
    run('git', ['checkout', '--quiet', '--detach', options.ref], { cwd: checkout });

    const declared = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
    const expected = run('git', ['rev-parse', options.ref], { cwd: REPO_ROOT }).stdout.trim();
    assert(
      declared === expected,
      `cloned commit ${declared} must match ${options.ref} (${expected})`,
    );

    step('checking the checkout is unbuilt');
    assert(!existsSync(path.join(checkout, 'node_modules')), 'a clean checkout has no node_modules');
    assert(!existsSync(path.join(checkout, 'dist')), 'a clean checkout has no dist/');
    assert(
      run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: checkout }).stdout
        .trim() === '',
      'the cloned working tree must be clean',
    );

    step('npm ci');
    run(NPM, ['ci', '--no-audit', '--no-fund'], { cwd: checkout });

    step('npm run build');
    run(NPM, ['run', 'build'], { cwd: checkout });
    assert(
      existsSync(path.join(checkout, 'dist', 'cli', 'main.js')),
      'dist/cli/main.js must exist for the bin entry point to resolve',
    );

    step('preparing the analysis fixture');
    createFixture(fixture);
    mkdirSync(home, { recursive: true });

    const env = { VOLDBASE_HOME: home };
    const cli = (args) =>
      run(process.execPath, [path.join('bin', 'voldbase.js'), ...args], {
        cwd: checkout,
        env,
      });

    step('voldbase import <fixture>');
    const imported = cli(['import', fixture]).stdout;
    const projectId = /proj_[0-9a-f]+/.exec(imported)?.[0];
    assert(projectId !== undefined, `import output must contain a project id:\n${imported}`);

    step(`voldbase analyze ${projectId}`);
    const analysed = cli(['analyze', projectId]).stdout;
    const analysisId = /ana_[0-9a-f]+/.exec(analysed)?.[0];
    assert(analysisId !== undefined, `analyze output must contain an analysis id:\n${analysed}`);

    step(`voldbase architecture ${analysisId} --format json`);
    const report = cli(['architecture', analysisId, '--format', 'json']).stdout;
    assert(report.endsWith('\n'), 'architecture JSON must end with a newline');

    let snapshot;
    try {
      snapshot = JSON.parse(report);
    } catch (error) {
      fail(`architecture output is not valid JSON: ${error.message}\n${report}`);
    }

    assertSortedKeys(snapshot, 'architecture');
    assert(
      snapshot.analysisId === analysisId,
      `JSON analysisId ${String(snapshot.analysisId)} must be ${analysisId}`,
    );
    assert(
      snapshot.schemaVersion === 1,
      `JSON schemaVersion ${String(snapshot.schemaVersion)} must be 1`,
    );
    // The architecture model's digest is a bare SHA-256 hex string (the
    // `sha256:` prefix belongs to stored project revisions, not to this model).
    assert(
      /^[0-9a-f]{64}$/.test(snapshot.digest),
      `JSON digest ${String(snapshot.digest)} must be a SHA-256 hex digest`,
    );

    const paths = snapshot.nodes.map((node) => node.path);
    const fixturePaths = ['src/counter.js', 'src/index.js', 'src/store.js', 'src/util.js'];
    assert(
      fixturePaths.every((filePath) => paths.includes(filePath)),
      `JSON nodes must include ${fixturePaths.join(', ')}; saw ${paths.join(', ')}`,
    );
    assert(
      paths.every((filePath, index) => index === 0 || paths[index - 1] < filePath),
      `JSON nodes must be sorted by path; saw ${paths.join(', ')}`,
    );
    assert(snapshot.edges.length === 3, `expected 3 edges, saw ${String(snapshot.edges.length)}`);
    assert(
      snapshot.cycles.length === 1,
      `expected 1 cycle (src/counter.js ↔ src/store.js), saw ${String(snapshot.cycles.length)}`,
    );

    step('re-running architecture to confirm deterministic JSON');
    const again = cli(['architecture', analysisId, '--format=json']).stdout;
    assert(again === report, 'two runs over the same analysis must produce byte-identical JSON');

    step(
      `ok — clone ${declared.slice(0, 12)}, ${String(paths.length)} nodes, ` +
        `${String(snapshot.edges.length)} edges, digest ${String(snapshot.digest).slice(0, 16)}…`,
    );
    succeeded = true;
  } finally {
    if (succeeded && !options.keep) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } else {
      process.stdout.write(`temporary checkout kept at ${temporaryRoot}\n`);
    }
  }
}

main().catch((error) => {
  if (error instanceof SmokeError) {
    process.stderr.write(`error: ${error.message}\n`);
  } else {
    process.stderr.write(`error: ${error?.stack ?? String(error)}\n`);
  }
  process.exitCode = 1;
});
