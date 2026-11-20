/**
 * `voldbase analysis <id> --fail-on <level>`.
 *
 * The threshold is an exit-code contract, not an analysis feature: the stored
 * snapshot, the findings, the text report and the JSON document must be exactly
 * what they were without it. These tests build projects whose findings cover all
 * three severities and then check the exit code for every level in both output
 * modes.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { FixedClock, SequentialIdGenerator } from '../src/index.ts';
import { main } from '../src/cli/main.ts';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliHarness {
  readonly cwd: string;
  readonly home: string;
  run(argv: readonly string[]): Promise<CliResult>;
}

type Fixture = 'mixed' | 'error-only' | 'warning-only' | 'info-only' | 'clean';

/**
 * Source files chosen so the analyzer produces exactly the findings named by
 * `expected`: VB001 (error, unparsable file), VB002 (warning, unresolved relative
 * import) and VB003 (info, computed dynamic import).
 */
const FIXTURES: Readonly<
  Record<Fixture, { files: Readonly<Record<string, string>>; expected: string[] }>
> = {
  mixed: {
    files: {
      'package.json': '{"name":"mixed"}\n',
      'src/ok.js': 'export const value = 1;\n',
      'src/broken.js': 'export function broken( {\n',
      'src/warn.js': "import { helper } from './missing';\nexport const x = helper;\n",
      'src/dyn.js': "const name = './mod';\nexport const load = () => import(name);\n",
    },
    expected: ['error', 'info', 'warning'],
  },
  'error-only': {
    files: { 'src/broken.js': 'export function broken( {\n' },
    expected: ['error'],
  },
  'warning-only': {
    files: { 'src/warn.js': "import { helper } from './missing';\nexport const x = helper;\n" },
    expected: ['warning'],
  },
  'info-only': {
    files: { 'src/dyn.js': "const name = './mod';\nexport const load = () => import(name);\n" },
    expected: ['info'],
  },
  clean: {
    files: { 'src/ok.js': 'export const value = 1;\n' },
    expected: [],
  },
};

async function makeHarness(t: TestContext): Promise<CliHarness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-fail-on-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const cwd = path.join(directory, 'work');
  const home = path.join(directory, 'home');
  await fs.mkdir(cwd, { recursive: true });

  const ids = new SequentialIdGenerator('proj');

  return {
    cwd,
    home,
    async run(argv) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await main(argv, {
        cwd,
        env: { VOLDBASE_HOME: home },
        streams: {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        ids,
        analysisIds: new SequentialIdGenerator('ana'),
        clock: new FixedClock(new Date('2026-04-03T09:00:00Z')),
      });
      return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    },
  };
}

async function writeFile(root: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

/**
 * Import and analyse a fixture, asserting first that it produced the severities
 * the exit-code expectations depend on: a fixture that silently stopped producing
 * a finding would otherwise make these tests pass for the wrong reason.
 */
async function analyzeFixture(harness: CliHarness, fixture: Fixture): Promise<void> {
  const { files, expected } = FIXTURES[fixture];
  const root = path.join(harness.cwd, fixture);
  for (const [relativePath, contents] of Object.entries(files)) {
    await writeFile(root, relativePath, contents);
  }

  const imported = await harness.run(['import', fixture]);
  assert.equal(imported.code, 0, imported.stderr);
  const analyzed = await harness.run(['analyze', 'proj-1']);
  assert.equal(analyzed.code, 0, analyzed.stderr);

  const document = JSON.parse(
    await fs.readFile(path.join(harness.home, 'analyses.json'), 'utf8'),
  ) as { analyses: { findings: { severity: string }[] }[] };
  const findings = document.analyses[0]?.findings ?? [];
  assert.deepEqual(
    [...new Set(findings.map((finding) => finding.severity))].sort(),
    expected,
    `fixture ${fixture} must produce exactly these severities`,
  );
}

async function withFixture(t: TestContext, fixture: Fixture): Promise<CliHarness> {
  const harness = await makeHarness(t);
  await analyzeFixture(harness, fixture);
  return harness;
}

describe('voldbase analysis --fail-on', () => {
  it('never fails on findings when the level is none, which is the default', async (t) => {
    const harness = await withFixture(t, 'mixed');

    const byDefault = await harness.run(['analysis', 'ana-1']);
    const explicitNone = await harness.run(['analysis', 'ana-1', '--fail-on', 'none']);
    const jsonNone = await harness.run(['analysis', 'ana-1', '--format', 'json', '--fail-on', 'none']);

    assert.equal(byDefault.code, 0, byDefault.stderr);
    assert.equal(explicitNone.code, 0, explicitNone.stderr);
    assert.equal(jsonNone.code, 0, jsonNone.stderr);
    assert.equal(explicitNone.stdout, byDefault.stdout);
  });

  it('fails only on errors at the error level', async (t) => {
    const mixed = await withFixture(t, 'mixed');
    assert.equal((await mixed.run(['analysis', 'ana-1', '--fail-on', 'error'])).code, 3);

    const warningOnly = await withFixture(t, 'warning-only');
    assert.equal((await warningOnly.run(['analysis', 'ana-1', '--fail-on', 'error'])).code, 0);

    const infoOnly = await withFixture(t, 'info-only');
    assert.equal((await infoOnly.run(['analysis', 'ana-1', '--fail-on', 'error'])).code, 0);
  });

  it('fails on warnings and errors at the warning level', async (t) => {
    const mixed = await withFixture(t, 'mixed');
    assert.equal((await mixed.run(['analysis', 'ana-1', '--fail-on', 'warning'])).code, 3);

    const warningOnly = await withFixture(t, 'warning-only');
    assert.equal((await warningOnly.run(['analysis', 'ana-1', '--fail-on', 'warning'])).code, 3);

    const infoOnly = await withFixture(t, 'info-only');
    assert.equal((await infoOnly.run(['analysis', 'ana-1', '--fail-on', 'warning'])).code, 0);
  });

  it('fails on any finding at the info level', async (t) => {
    const infoOnly = await withFixture(t, 'info-only');
    assert.equal((await infoOnly.run(['analysis', 'ana-1', '--fail-on', 'info'])).code, 3);

    const mixed = await withFixture(t, 'mixed');
    assert.equal((await mixed.run(['analysis', 'ana-1', '--fail-on', 'info'])).code, 3);

    const clean = await withFixture(t, 'clean');
    assert.equal((await clean.run(['analysis', 'ana-1', '--fail-on', 'info'])).code, 0);
  });

  it('never fails when the analysis has no findings', async (t) => {
    const harness = await withFixture(t, 'clean');

    for (const level of ['error', 'warning', 'info']) {
      const text = await harness.run(['analysis', 'ana-1', '--fail-on', level]);
      assert.equal(text.code, 0, `--fail-on ${level} must not fail without findings`);
      assert.match(text.stdout, /No syntax-level findings\./);

      const json = await harness.run(['analysis', 'ana-1', '--format', 'json', '--fail-on', level]);
      assert.equal(json.code, 0);
      assert.equal((JSON.parse(json.stdout) as { findings: unknown[] }).findings.length, 0);
    }
  });

  it('keeps the JSON document byte-identical when the threshold is reached', async (t) => {
    const harness = await withFixture(t, 'mixed');

    const passing = await harness.run(['analysis', 'ana-1', '--format', 'json']);
    const failing = await harness.run(['analysis', 'ana-1', '--format', 'json', '--fail-on', 'info']);

    assert.equal(passing.code, 0);
    assert.equal(failing.code, 3);
    assert.equal(failing.stderr, '');
    assert.equal(failing.stdout, passing.stdout);

    // One document, no prose, and the same findings the stored snapshot has.
    const parsed = JSON.parse(failing.stdout) as {
      findings: { severity: string }[];
      digest: string;
    };
    assert.deepEqual(
      [...new Set(parsed.findings.map((finding) => finding.severity))].sort(),
      ['error', 'info', 'warning'],
    );
    assert.match(parsed.digest, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(failing.stdout, /^Analysis ana-1$/m);
  });

  it('keeps the text report identical when the threshold is reached', async (t) => {
    const harness = await withFixture(t, 'mixed');

    const passing = await harness.run(['analysis', 'ana-1']);
    const failing = await harness.run(['analysis', 'ana-1', '--fail-on', 'warning']);

    assert.equal(passing.code, 0);
    assert.equal(failing.code, 3);
    assert.equal(failing.stderr, '');
    assert.equal(failing.stdout, passing.stdout);
    assert.match(failing.stdout, /WARNING\s+VB002/);
    assert.match(failing.stdout, /ERROR\s+VB001/);
    assert.match(failing.stdout, /INFO\s+VB003/);
  });

  it('accepts --fail-on=level and combines it with --format=json', async (t) => {
    const harness = await withFixture(t, 'warning-only');

    const spaced = await harness.run(['analysis', 'ana-1', '--format', 'json', '--fail-on', 'warning']);
    const joined = await harness.run(['analysis', 'ana-1', '--format=json', '--fail-on=warning']);

    assert.equal(spaced.code, 3, spaced.stderr);
    assert.equal(joined.code, 3, joined.stderr);
    assert.equal(joined.stdout, spaced.stdout);
  });

  it('rejects an unsupported or empty level with exit code 2', async (t) => {
    const harness = await withFixture(t, 'mixed');

    for (const argv of [
      ['analysis', 'ana-1', '--fail-on', 'fatal'],
      ['analysis', 'ana-1', '--fail-on', 'Error'],
      ['analysis', 'ana-1', '--fail-on='],
      ['analysis', 'ana-1', '--fail-on', 'all'],
    ]) {
      const result = await harness.run(argv);
      assert.equal(result.code, 2, `expected a usage error for ${argv.join(' ')}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--fail-on must be 'error', 'warning', 'info' or 'none'/);
    }
  });

  it('rejects a missing --fail-on value with exit code 2', async (t) => {
    const harness = await withFixture(t, 'mixed');

    const result = await harness.run(['analysis', 'ana-1', '--fail-on']);

    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Option '--fail-on' needs a value/);
  });

  it('keeps exit code 1 for an unknown analysis id', async (t) => {
    const harness = await withFixture(t, 'mixed');

    const plain = await harness.run(['analysis', 'ana-404']);
    const withThreshold = await harness.run(['analysis', 'ana-404', '--fail-on', 'error']);

    assert.equal(plain.code, 1);
    assert.equal(withThreshold.code, 1);
    assert.equal(withThreshold.stderr, plain.stderr);
    assert.equal(withThreshold.stdout, '');
    assert.match(withThreshold.stderr, /no analysis with id 'ana-404'/);
  });

  it('keeps exit code 2 for invalid arguments', async (t) => {
    const harness = await withFixture(t, 'mixed');

    assert.equal((await harness.run(['analysis'])).code, 2);
    assert.equal((await harness.run(['analysis', 'a', 'b', '--fail-on', 'error'])).code, 2);
    assert.equal((await harness.run(['analysis', 'ana-1', '--unknown'])).code, 2);
  });

  it('documents the option in the usage text', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['help']);

    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      /voldbase analysis <analysis-id> \[--format text\|json\] \[--fail-on error\|warning\|info\|none\]/,
    );
    assert.match(result.stdout, /--fail-on <level>\s+Exit 3 when a finding reaches/);
  });
});
