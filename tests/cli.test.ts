import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { FixedClock, type IdGenerator } from '../src/index.ts';
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

function countingIds(prefix = 'proj'): IdGenerator {
  let next = 0;
  return {
    next() {
      next += 1;
      return `${prefix}-${next}`;
    },
  };
}

async function makeHarness(t: TestContext): Promise<CliHarness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-cli-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const cwd = path.join(directory, 'work');
  const home = path.join(directory, 'home');
  await fs.mkdir(cwd, { recursive: true });

  const ids = countingIds();

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
        clock: new FixedClock(new Date('2026-03-03T12:00:00Z')),
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

async function projectFixture(harness: CliHarness, name = 'demo'): Promise<string> {
  const root = path.join(harness.cwd, name);
  await writeFile(root, 'package.json', '{"name":"demo"}\n');
  await writeFile(root, 'src/index.js', 'export const a = 1;\n');
  return root;
}

describe('voldbase CLI', () => {
  it('prints help when invoked without arguments', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run([]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /voldbase import <path>/);
  });

  it('prints help for the help command', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['help']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /VOLDBASE never executes project code/);
  });

  it('imports a project given a path relative to the working directory', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);

    const result = await harness.run(['import', 'demo']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Imported project proj-1/);
    assert.match(result.stdout, /name\s+demo/);
    assert.match(result.stdout, /revision\s+sha256:[0-9a-f]{64}/);
    assert.match(result.stdout, /npm\s+package\.json/);

    const document = JSON.parse(
      await fs.readFile(path.join(harness.home, 'projects.json'), 'utf8'),
    ) as { schemaVersion: number; projects: unknown[] };
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.projects.length, 1);
  });

  it('accepts an explicit project name', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);

    const result = await harness.run(['import', 'demo', '--name', 'Demo Project']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /name\s+Demo Project/);
  });

  it('supports --name=value syntax', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);

    const result = await harness.run(['import', 'demo', '--name=Inline']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /name\s+Inline/);
  });

  it('reports an unchanged re-import without creating a second project', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);

    await harness.run(['import', 'demo']);
    const second = await harness.run(['import', 'demo']);

    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Already imported: proj-1/);

    const list = await harness.run(['list']);
    assert.equal((list.stdout.match(/proj-\d+/g) ?? []).length, 1);
  });

  it('fails with a non-zero exit code when the contents changed', async (t) => {
    const harness = await makeHarness(t);
    const root = await projectFixture(harness);

    await harness.run(['import', 'demo']);
    await writeFile(root, 'package.json', '{"name":"demo","version":"2"}\n');

    const result = await harness.run(['import', 'demo']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /already imported/);
    assert.match(result.stderr, /--name/);
  });

  it('lists imported projects in a table', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);
    await harness.run(['import', 'demo']);

    const result = await harness.run(['list']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /^ID\s+NAME\s+REVISION\s+IMPORTED$/m);
    assert.match(result.stdout, /proj-1\s+demo\s+sha256:[0-9a-f]{12}…/);
    assert.match(result.stdout, /2026-03-03/);
  });

  it('explains how to start when nothing is imported', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['list']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /No projects imported yet/);
    assert.match(result.stdout, /voldbase import <path>/);
  });

  it('shows a single project with its full revision and manifests', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);
    await harness.run(['import', 'demo']);

    const result = await harness.run(['show', 'proj-1']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Project proj-1$/m);
    assert.match(result.stdout, /source\s+local \//);
    assert.match(result.stdout, /revision\s+sha256:[0-9a-f]{64}$/m);
    assert.match(result.stdout, /npm\s+package\.json\s+sha256:[0-9a-f]{64}/);
  });

  it('exits 1 with a helpful message for an unknown project id', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['show', 'proj-404']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no project with id 'proj-404'/);
    assert.match(result.stderr, /voldbase list/);
  });

  it('exits 2 for an unknown command', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['frobnicate']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unknown command 'frobnicate'/);
  });

  it('exits 2 when import has no path', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['import']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /exactly one directory path/);
  });

  it('exits 2 for an unknown option', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['import', 'demo', '--recursive']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unknown option '--recursive'/);
  });

  it('exits 2 when --name has no value', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['import', 'demo', '--name']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /needs a value/);
  });

  it('exits 2 when --name is empty', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);
    const result = await harness.run(['import', 'demo', '--name=']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /--name must not be empty/);
  });

  it('exits 2 when show has no id', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['show']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /exactly one project id/);
  });

  it('exits 2 when a command receives unexpected positional arguments', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['list', 'extra']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /list takes no arguments/);
  });

  it('exits 1 for a path that does not exist', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['import', 'missing']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not exist/);
    assert.match(result.stderr, /code: path_not_found/);
  });

  it('exits 1 for an empty directory', async (t) => {
    const harness = await makeHarness(t);
    await fs.mkdir(path.join(harness.cwd, 'empty'), { recursive: true });

    const result = await harness.run(['import', 'empty']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /code: empty_project/);
  });

  it('persists state between separate CLI invocations', async (t) => {
    const harness = await makeHarness(t);
    await projectFixture(harness);
    const imported = await harness.run(['import', 'demo']);
    assert.equal(imported.code, 0, imported.stderr);

    // A second harness with the same home directory sees the stored project.
    const reopened = await makeHarnessWithHome(t, harness.home, harness.cwd);
    const result = await reopened.run(['show', 'proj-1']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Project proj-1$/m);
  });
});

async function makeHarnessWithHome(
  t: TestContext,
  home: string,
  cwd: string,
): Promise<CliHarness> {
  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });
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
      });
      return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    },
  };
}
