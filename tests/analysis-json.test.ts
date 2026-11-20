/**
 * `voldbase analysis <id> --format json`.
 *
 * The JSON form is a delivery-layer projection of the snapshot already stored by
 * `voldbase analyze`: no recalculation, no reformatting of the digest, no prose
 * mixed into stdout. These tests drive the real command against a real temporary
 * home and compare the printed document with the stored one.
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

interface StoredAnalysisDocument {
  readonly schemaVersion: number;
  readonly analyses: readonly {
    readonly analysisId: string;
    readonly projectId: string;
    readonly projectRevision: string;
    readonly analyzerVersion: string;
    readonly schemaVersion: number;
    readonly digest: string;
    readonly createdAt: string;
    readonly settings: Record<string, unknown>;
    readonly files: readonly unknown[];
    readonly findings: readonly {
      readonly ruleId: string;
      readonly evidence: string;
      readonly message: string;
    }[];
  }[];
}

interface JsonSnapshot {
  readonly analysisId: string;
  readonly projectId: string;
  readonly projectRevision: string;
  readonly analyzerVersion: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly digest: string;
  readonly settings: Record<string, unknown>;
  readonly files: readonly { readonly path: string; readonly imports: unknown[] }[];
  readonly findings: readonly {
    readonly ruleId: string;
    readonly severity: string;
    readonly certainty: string;
    readonly path: string;
    readonly location?: { readonly line: number; readonly column: number };
    readonly message: string;
    readonly evidence: string;
  }[];
  readonly summary: Record<string, unknown>;
}

async function makeHarness(t: TestContext): Promise<CliHarness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-analysis-json-'));
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
 * A project with exactly one finding (VB002) so the test can prove that evidence
 * survives the JSON projection.
 */
async function analyzeFixture(harness: CliHarness): Promise<void> {
  const root = path.join(harness.cwd, 'demo');
  await writeFile(root, 'package.json', '{"name":"demo"}\n');
  await writeFile(
    root,
    'src/index.js',
    ["import { helper } from './missing';", 'export function run() { return helper(); }'].join('\n') + '\n',
  );
  assert.equal((await harness.run(['import', 'demo'])).code, 0);
  assert.equal((await harness.run(['analyze', 'proj-1'])).code, 0);
}

async function readStored(harness: CliHarness): Promise<StoredAnalysisDocument['analyses'][number]> {
  const document = JSON.parse(
    await fs.readFile(path.join(harness.home, 'analyses.json'), 'utf8'),
  ) as StoredAnalysisDocument;
  const stored = document.analyses[0];
  assert.ok(stored, 'the fixture analysis must be stored');
  return stored;
}

function parseJson(result: CliResult): JsonSnapshot {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as JsonSnapshot;
}

describe('voldbase analysis --format json', () => {
  it('prints one parseable JSON document carrying the complete snapshot', async (t) => {
    const harness = await makeHarness(t);
    await analyzeFixture(harness);

    const result = await harness.run(['analysis', 'ana-1', '--format', 'json']);
    const parsed = parseJson(result);
    const stored = await readStored(harness);

    // Exactly one document, and no human-readable prose alongside it.
    assert.equal(result.stderr, '');
    assert.match(result.stdout.trim(), /^\{/);
    assert.match(result.stdout.trim(), /\}$/);
    assert.doesNotMatch(result.stdout, /^Analysis ana-1$/m);
    assert.doesNotMatch(result.stdout, /^SEVERITY\s/m);

    assert.equal(parsed.analysisId, 'ana-1');
    assert.equal(parsed.projectId, 'proj-1');
    assert.equal(parsed.projectRevision, stored.projectRevision);
    assert.equal(parsed.analyzerVersion, stored.analyzerVersion);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.createdAt, stored.createdAt);
    assert.equal(parsed.createdAt, '2026-04-03T09:00:00.000Z');
    assert.deepEqual(Object.keys(parsed.settings).sort(), [
      'maxFileBytes',
      'maxFiles',
      'maxSourceFiles',
      'maxTotalBytes',
      'supportedExtensions',
    ]);
    assert.ok(Array.isArray(parsed.files) && parsed.files.length === 1);
    assert.ok(Array.isArray(parsed.findings) && parsed.findings.length === 1);
    assert.deepEqual(Object.keys(parsed.summary).sort(), [
      'declarationCount',
      'fileCount',
      'findingCount',
      'findingsBySeverity',
      'importCount',
      'languages',
      'resolvedImportCount',
      'sourceFileCount',
    ]);
    assert.equal(parsed.summary.findingCount, 1);
  });

  it('preserves files, findings and evidence exactly as stored', async (t) => {
    const harness = await makeHarness(t);
    await analyzeFixture(harness);

    const parsed = parseJson(await harness.run(['analysis', 'ana-1', '--format=json']));
    const stored = await readStored(harness);

    assert.deepEqual(parsed.files, stored.files);
    assert.deepEqual(parsed.findings, stored.findings);
    assert.deepEqual(parsed.settings, stored.settings);

    const [finding] = parsed.findings;
    assert.ok(finding);
    assert.equal(finding.ruleId, 'VB002');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.certainty, 'certain');
    assert.equal(finding.path, 'src/index.js');
    assert.equal(finding.evidence, './missing');
    assert.match(finding.message, /does not match any analysed file/);
    assert.equal(finding.location?.line, 1);
  });

  it('reports the stored digest unchanged', async (t) => {
    const harness = await makeHarness(t);
    await analyzeFixture(harness);

    const parsed = parseJson(await harness.run(['analysis', 'ana-1', '--format', 'json']));
    const stored = await readStored(harness);

    assert.equal(parsed.digest, stored.digest);
    assert.match(parsed.digest, /^[0-9a-f]{64}$/);
  });

  it('is byte-identical on repeated runs and accepts --format=json', async (t) => {
    const harness = await makeHarness(t);
    await analyzeFixture(harness);

    const spaced = await harness.run(['analysis', 'ana-1', '--format', 'json']);
    const repeated = await harness.run(['analysis', 'ana-1', '--format', 'json']);
    const joined = await harness.run(['analysis', 'ana-1', '--format=json']);

    assert.equal(spaced.code, 0, spaced.stderr);
    assert.equal(repeated.stdout, spaced.stdout);
    assert.equal(joined.stdout, spaced.stdout);

    // Canonical JSON: keys sorted at the top level, so a diff shows only changes.
    const keys = Object.keys(JSON.parse(spaced.stdout) as Record<string, unknown>);
    assert.deepEqual(keys, [...keys].sort());
  });

  it('rejects an unknown format with usage exit code 2 and no stdout', async (t) => {
    const harness = await makeHarness(t);
    await analyzeFixture(harness);

    for (const argv of [
      ['analysis', 'ana-1', '--format', 'yaml'],
      ['analysis', 'ana-1', '--format=markdown'],
      ['analysis', 'ana-1', '--format'],
    ]) {
      const result = await harness.run(argv);
      assert.equal(result.code, 2, `expected a usage error for ${argv.join(' ')}`);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--format|needs a value/);
    }
  });

  it('keeps the existing unknown-analysis error behaviour', async (t) => {
    const harness = await makeHarness(t);

    const text = await harness.run(['analysis', 'ana-404']);
    assert.equal(text.code, 1);
    assert.match(text.stderr, /no analysis with id 'ana-404'/);
    assert.match(text.stderr, /Run `voldbase analyze <project-id>` to create one\./);

    const json = await harness.run(['analysis', 'ana-404', '--format', 'json']);
    assert.equal(json.code, 1);
    assert.equal(json.stdout, '');
    assert.equal(json.stderr, text.stderr);
  });

  it('leaves the default text output unchanged', async (t) => {
    const harness = await makeHarness(t);
    await analyzeFixture(harness);

    const byDefault = await harness.run(['analysis', 'ana-1']);
    const explicitText = await harness.run(['analysis', 'ana-1', '--format', 'text']);

    assert.equal(byDefault.code, 0, byDefault.stderr);
    assert.equal(explicitText.stdout, byDefault.stdout);
    assert.match(byDefault.stdout, /^Analysis ana-1$/m);
    assert.match(byDefault.stdout, /^SEVERITY\s+RULE\s+LOCATION\s+EXPLANATION$/m);
    assert.match(byDefault.stdout, /WARNING\s+VB002/);
    assert.match(byDefault.stdout, /evidence: \.\/missing/);
    assert.match(byDefault.stdout, /Syntax-level observations only/);
    // The text report is not JSON and must never become a parseable document.
    assert.throws(() => JSON.parse(byDefault.stdout));
  });

  it('documents the option in the usage text', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['help']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /voldbase analysis <analysis-id> \[--format text\|json\]/);
    assert.match(result.stdout, /--format <format>\s+Output format for analysis and architecture/);
  });
});
