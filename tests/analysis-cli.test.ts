/**
 * `voldbase analyze` and `voldbase analysis` (Phase 2A).
 *
 * The CLI is the delivery adapter: these tests drive the real commands against a
 * temporary home and a real project directory and assert exit codes, stable
 * output and persistence — plus that a changed project is refused rather than
 * analysed against the wrong revision.
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

async function makeHarness(t: TestContext): Promise<CliHarness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2a-cli-'));
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

async function projectFixture(harness: CliHarness): Promise<string> {
  const root = path.join(harness.cwd, 'demo');
  await writeFile(root, 'package.json', '{"name":"demo"}\n');
  await writeFile(
    root,
    'src/index.js',
    ["import { helper } from './missing';", 'export function run() { return helper(); }'].join('\n') + '\n',
  );
  return root;
}

describe('voldbase analyze', () => {
  it('analyses an imported project and persists the snapshot', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);
    assert.equal((await harness.run(['import', 'demo'])).code, 0);

    const result = await harness.run(['analyze', 'proj-1']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Analysed project proj-1 \(demo\)/);
    assert.match(result.stdout, /analysis\s+ana-1/);
    assert.match(result.stdout, /revision\s+sha256:[0-9a-f]{64}/);
    assert.match(result.stdout, /source\s+1 files \(javascript\)/);
    assert.match(result.stdout, /imports\s+1 \(0 resolved\)/);
    assert.match(result.stdout, /findings\s+1 \(0 error, 1 warning, 0 info\)/);
    assert.match(result.stdout, /No findings does not mean the code is safe/);

    const document = JSON.parse(
      await fs.readFile(path.join(harness.home, 'analyses.json'), 'utf8'),
    ) as { schemaVersion: number; analyses: { analysisId: string }[] };
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.analyses.length, 1);
    assert.equal(document.analyses[0]?.analysisId, 'ana-1');
  });

  it('exits 1 for an unknown project id', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['analyze', 'proj-404']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /No project with id 'proj-404'/);
    assert.match(result.stderr, /code: project_not_found/);
  });

  it('exits 1 when the project changed after import', async (t) => {
    const harness = await makeHarness(t);
    const root = await projectFixture(harness);
    assert.equal((await harness.run(['import', 'demo'])).code, 0);
    await writeFile(root, 'src/index.js', 'export const changed = true;\n');

    const result = await harness.run(['analyze', 'proj-1']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /code: analysis_revision_mismatch/);
    assert.match(result.stderr, /Import it again/);
    // Nothing was stored against a revision that was never verified.
    await assert.rejects(fs.stat(path.join(harness.home, 'analyses.json')), { code: 'ENOENT' });
  });

  it('exits 1 for a project with no analysable source', async (t) => {
    const harness = await makeHarness(t);
    await writeFile(path.join(harness.cwd, 'docs'), 'README.md', '# docs\n');
    assert.equal((await harness.run(['import', 'docs'])).code, 0);

    const result = await harness.run(['analyze', 'proj-1']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /code: analysis_unsupported_source/);
  });

  it('exits 2 without exactly one project id', async (t) => {
    const harness = await makeHarness(t);
    assert.equal((await harness.run(['analyze'])).code, 2);
    assert.equal((await harness.run(['analyze', 'a', 'b'])).code, 2);
    assert.match((await harness.run(['analyze'])).stderr, /exactly one project id/);
  });
});

describe('voldbase analysis', () => {
  it('shows the stored summary and findings', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);
    await harness.run(['import', 'demo']);
    await harness.run(['analyze', 'proj-1']);

    const result = await harness.run(['analysis', 'ana-1']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Analysis ana-1$/m);
    assert.match(result.stdout, /^SEVERITY\s+RULE\s+LOCATION\s+EXPLANATION$/m);
    assert.match(result.stdout, /WARNING\s+VB002\s+src\/index\.js:1:\d+\s+This relative import/);
    assert.match(result.stdout, /evidence: \.\/missing/);
    assert.match(result.stdout, /Syntax-level observations only/);
  });

  it('says plainly that no findings is not a clearance', async (t) => {
    const harness = await makeHarness(t);
    await writeFile(path.join(harness.cwd, 'clean'), 'src/a.ts', 'export const a = 1;\n');
    await harness.run(['import', 'clean']);
    await harness.run(['analyze', 'proj-1']);

    const result = await harness.run(['analysis', 'ana-1']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /No syntax-level findings\./);
    assert.match(result.stdout, /not a statement that the project is correct, safe or secure/);
  });

  it('exits 1 for an unknown analysis id', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['analysis', 'ana-404']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no analysis with id 'ana-404'/);
    assert.match(result.stderr, /voldbase analyze <project-id>/);
  });

  it('exits 2 without exactly one analysis id', async (t) => {
    const harness = await makeHarness(t);
    assert.equal((await harness.run(['analysis'])).code, 2);
    assert.equal((await harness.run(['analysis', 'a', 'b'])).code, 2);
  });

  it('keeps analyses across separate invocations', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);
    await harness.run(['import', 'demo']);
    await harness.run(['analyze', 'proj-1']);

    // A fresh harness over the same home reads the stored document.
    const reopened: CliHarness = {
      cwd: harness.cwd,
      home: harness.home,
      async run(argv) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const code = await main(argv, {
          cwd: harness.cwd,
          env: { VOLDBASE_HOME: harness.home },
          streams: {
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line),
          },
          clock: new FixedClock(new Date('2026-04-04T09:00:00Z')),
        });
        return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
      },
    };

    const result = await reopened.run(['analysis', 'ana-1']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Analysis ana-1$/m);
  });
});
