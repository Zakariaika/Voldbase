/**
 * End-to-end test of the *built* CLI.
 *
 * It spawns `node bin/voldbase.js` exactly as an installed user would, so the
 * emitted JavaScript, the `rewriteRelativeImportExtensions` output and the bin
 * entry point are all exercised — not just the TypeScript sources.
 *
 * Requires `npm run build` first; without `dist/` the test is skipped rather than
 * silently passing.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const binPath = path.join(projectRoot, 'bin', 'voldbase.js');
const distEntry = path.join(projectRoot, 'dist', 'cli', 'main.js');
const distAvailable = existsSync(distEntry);

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runBin(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      { cwd, env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}

async function makeWorkspace(t: TestContext): Promise<{
  root: string;
  home: string;
  project: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-dist-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const home = path.join(root, 'home');
  const project = path.join(root, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), '{"name":"demo"}\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'index.js'), 'export const a = 1;\n', 'utf8');

  return { root, home, project };
}

describe('built CLI', () => {
  it(
    'imports, lists and shows through the compiled entry point',
    { skip: distAvailable ? false : 'dist/ is missing; run `npm run build` first' },
    async (t) => {
      const { root, home, project } = await makeWorkspace(t);
      const env: NodeJS.ProcessEnv = { ...process.env, VOLDBASE_HOME: home };

      const imported = await runBin(['import', 'demo'], env, root);
      assert.equal(imported.code, 0, imported.stderr);
      assert.match(imported.stdout, /Imported project proj_/);
      assert.match(imported.stdout, /revision\s+sha256:[0-9a-f]{64}/);

      const listed = await runBin(['list'], env, root);
      assert.equal(listed.code, 0, listed.stderr);
      assert.match(listed.stdout, /proj_[0-9a-f]+\s+demo\s+sha256:/);

      const projectId = /proj_[0-9a-f]+/.exec(listed.stdout)?.[0];
      assert.ok(projectId, 'list output must contain the project id');

      const shown = await runBin(['show', projectId], env, root);
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, new RegExp(`^Project ${projectId}$`, 'm'));
      assert.match(
        shown.stdout,
        new RegExp(`source\\s+local ${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );

      // Persistence: the store is a real, inspectable file.
      const document = JSON.parse(
        await fs.readFile(path.join(home, 'projects.json'), 'utf8'),
      ) as { schemaVersion: number; projects: unknown[] };
      assert.equal(document.schemaVersion, 1);
      assert.equal(document.projects.length, 1);
    },
  );

  it(
    'reports usage and runtime failures with distinct exit codes',
    { skip: distAvailable ? false : 'dist/ is missing; run `npm run build` first' },
    async (t) => {
      const { root, home } = await makeWorkspace(t);
      const env: NodeJS.ProcessEnv = { ...process.env, VOLDBASE_HOME: home };

      const help = await runBin([], env, root);
      assert.equal(help.code, 0);
      assert.match(help.stdout, /Usage:/);

      const usage = await runBin(['import'], env, root);
      assert.equal(usage.code, 2);
      assert.match(usage.stderr, /exactly one directory path/);

      const missing = await runBin(['import', 'nope'], env, root);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /does not exist/);
    },
  );
});
