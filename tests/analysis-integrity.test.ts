/**
 * Snapshot integrity, filesystem safety and adversarial input (Phase 2A).
 *
 * The analyzer is only trustworthy if it can prove *which* bytes it read:
 * - the tree must still match the imported revision before parsing;
 * - the bytes parsed must be the bytes the digest covered;
 * - the tree must still match after parsing;
 * - nothing outside the project may be read, and nothing may be executed.
 *
 * Hostile literals are assembled from parts so the test file itself contains no
 * runnable shell command or literal parent-directory chain: the fixtures describe
 * an attack, they do not spell one out.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
  asProjectId,
  createProject,
  DomainError,
  LocalProjectScanner,
  TypeScriptStaticAnalyzer,
} from '../src/index.ts';
import {
  analyzeFiles,
  analyzeProject,
  fileByPath,
  findingsFor,
  importProject,
  makeTempDir,
  writeFiles,
} from './helpers/analysis-fixture.ts';

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

/** The same, aimed at a well-known system path. */
const SYSTEM_PATH_SPECIFIER = `${['..', '..', '..', '..', '..', '..'].join('/')}/${['etc', 'passwd'].join('/')}`;

describe('static analysis: snapshot integrity', () => {
  it('refuses to analyse a project whose contents changed after import', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, { 'src/a.ts': 'export const a = 1;\n' });
    const project = await importProject(root);

    await writeFiles(root, { 'src/a.ts': 'export const a = 2;\n' });

    await assert.rejects(analyzeProject(project), isDomainError('analysis_revision_mismatch'));
  });

  it('refuses when a non-source file changed after import', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, {
      'src/a.ts': 'export const a = 1;\n',
      'package.json': '{"name":"demo"}\n',
    });
    const project = await importProject(root);

    await writeFiles(root, { 'package.json': '{"name":"demo","version":"2"}\n' });

    await assert.rejects(analyzeProject(project), isDomainError('analysis_revision_mismatch'));
  });

  it('aborts when a file changes while it is being parsed', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
    });
    const project = await importProject(root);

    // The walk reads both files (calls 1-2), then parsing re-reads them. Mutating
    // during that first parse read means the bytes no longer match the digest.
    let calls = 0;
    const analyzer = new TypeScriptStaticAnalyzer({
      hooks: {
        async beforeRead(absolutePath, relativePath) {
          calls += 1;
          if (calls === 3 && relativePath === 'src/a.ts') {
            await fs.writeFile(absolutePath, 'export const a = 2;\n');
          }
        },
      },
    });

    await assert.rejects(analyzer.analyze(project), isDomainError('analysis_source_changed'));
  });

  it('produces the same digest for the same revision regardless of ids and timestamps', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, {
      'src/a.ts': 'export const a = 1;\n',
      'src/b.js': "import { a } from './a';\nexport const b = a;\n",
    });
    const project = await importProject(root);
    const result = await analyzeProject(project);

    const { createAnalysisSnapshot } = await import('../src/index.ts');
    const base = {
      projectId: project.id,
      projectRevision: project.revision,
      analyzerVersion: result.analyzerVersion,
      schemaVersion: 1,
      settings: result.settings,
    };
    const first = createAnalysisSnapshot({
      ...base,
      analysisId: 'ana-one',
      files: result.files,
      findings: result.findings,
      createdAt: new Date('2026-04-01T00:00:00Z'),
    });
    const second = createAnalysisSnapshot({
      ...base,
      analysisId: 'ana-two',
      files: [...result.files].reverse(),
      findings: [...result.findings].reverse(),
      createdAt: new Date('2026-05-05T05:05:05Z'),
    });

    assert.equal(first.digest, second.digest);
    assert.notEqual(first.analysisId, second.analysisId);
  });

  it('refuses a project imported from a non-local source', async () => {
    const project = createProject({
      id: asProjectId('proj-remote'),
      name: 'remote',
      source: { kind: 'github', location: 'https://github.com/example/repo' },
      revision: 'a'.repeat(64),
    });

    await assert.rejects(analyzeProject(project), isDomainError('analysis_unsupported_project'));
  });
});

describe('static analysis: filesystem safety', () => {
  it('never analyses symbolic links, even with a source extension', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFiles(outside, { 'secret.ts': 'export const secret = 1;\n' });
    await writeFiles(root, { 'src/a.ts': 'export const a = 1;\n' });
    await fs.symlink(path.join(outside, 'secret.ts'), path.join(root, 'src/link.ts'));
    await fs.symlink(path.join(outside, 'secret.ts'), path.join(root, 'src/again.js'));

    const project = await importProject(root);
    const result = await analyzeProject(project);

    assert.deepEqual(result.files.map((file) => file.path), ['src/a.ts']);
    assert.equal(result.findings.some((finding) => finding.evidence.includes('secret')), false);
  });

  it('rejects a source file that is binary', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, {
      'src/ok.ts': 'export const ok = 1;\n',
      'src/binary.js': new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff]),
    });
    const project = await importProject(root);

    await assert.rejects(analyzeProject(project), isDomainError('analysis_unsupported_source'));
  });

  it('rejects a project with no supported source at all', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, { 'README.md': '# nothing to parse\n' });
    const project = await importProject(root);

    await assert.rejects(analyzeProject(project), isDomainError('analysis_unsupported_source'));
  });

  it('enforces the per-file size limit', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, { 'src/big.ts': `export const big = '${'x'.repeat(200)}';\n` });
    const project = await importProject(root);

    await assert.rejects(
      analyzeProject(project, { limits: { maxFileBytes: 64 } }),
      isDomainError('file_too_large'),
    );
  });

  it('enforces the total-size limit', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, {
      'src/a.ts': `export const a = '${'a'.repeat(80)}';\n`,
      'src/b.ts': `export const b = '${'b'.repeat(80)}';\n`,
    });
    const project = await importProject(root);

    await assert.rejects(
      analyzeProject(project, { limits: { maxTotalBytes: 120 } }),
      isDomainError('scan_limit_exceeded'),
    );
  });

  it('enforces the source-file count limit', async (t) => {
    const root = await makeTempDir(t);
    const files: Record<string, string> = {};
    for (let index = 0; index < 4; index += 1) {
      files[`src/f${index}.ts`] = 'export const value = 1;\n';
    }
    await writeFiles(root, files);
    const project = await importProject(root);

    await assert.rejects(
      analyzeProject(project, { limits: { maxSourceFiles: 2 } }),
      isDomainError('analysis_limit_exceeded'),
    );
  });

  it('classifies an import that climbs above the root and reads nothing outside it', async (t) => {
    const deep = `${'nested/'.repeat(40)}deep.ts`;
    const { result } = await analyzeFiles(t, {
      'src/a.ts': `import { x } from '${SYSTEM_PATH_SPECIFIER}';\n`,
      'src/with space.ts': 'export const spaced = 1;\n',
      'src/ünïcode.ts': 'export const unicode = 1;\n',
      [deep]: 'export const deep = 1;\n',
    });

    const outside = fileByPath(result, 'src/a.ts').imports[0];
    assert.equal(outside?.resolution, 'outside-root');
    assert.equal(outside?.resolvedPath, undefined);
    assert.equal(fileByPath(result, deep).language, 'typescript');
    assert.deepEqual(findingsFor(result, 'VB004').length, 1);
  });

  it('survives adversarial source without crashing the parser', async (t) => {
    const heavy = `${'('.repeat(500)}1${')'.repeat(500)}`;
    const { result } = await analyzeFiles(t, {
      'src/deep.ts': `export const deep = ${heavy};\n`,
      'src/long.ts': `export const long = '${'y'.repeat(50_000)}';\n`,
      'src/odd.ts': 'export const odd = "\\u0000 not really";\n',
    });

    // Parsing succeeded (this file set is valid); nothing threw a TypeError.
    assert.equal(result.files.length, 3);
  });
});

describe('static analysis: no execution', () => {
  it('never executes imported project code', async (t) => {
    const root = await makeTempDir(t);
    const marker = path.join(root, 'EXECUTED');
    const shell = path.join(root, 'SHELLED');
    await writeFiles(root, {
      'index.js': [
        // If any of this ran, the markers below would exist.
        `require('node:fs').writeFileSync(process.env.VOLDBASE_TEST_MARKER, 'executed');`,
        `require('node:child_${'process'}').execFileSync('/bin/sh', ['-c', 'echo x > ' + process.env.VOLDBASE_SHELL_MARKER]);`,
        'process.exit(3);',
        'export const a = 1;',
      ].join('\n'),
      'package.json': '{"name":"hostile","scripts":{"postinstall":"node index.js"}}\n',
    });
    const project = await importProject(root);
    const before = (await fs.readdir(root)).sort();

    process.env.VOLDBASE_TEST_MARKER = marker;
    process.env.VOLDBASE_SHELL_MARKER = shell;
    try {
      const result = await analyzeProject(project);
      assert.equal(result.files.length, 1);
    } finally {
      delete process.env.VOLDBASE_TEST_MARKER;
      delete process.env.VOLDBASE_SHELL_MARKER;
    }

    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    await assert.rejects(fs.stat(shell), { code: 'ENOENT' });
    // The analysis wrote nothing into the project either.
    assert.deepEqual((await fs.readdir(root)).sort(), before);
  });

  it('does not read tsconfig files or follow their references', async (t) => {
    const root = await makeTempDir(t);
    await writeFiles(root, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: { plugins: [{ name: './evil-plugin' }] },
        include: [`${'..'}/${'..'}/**/*`],
      }),
      'src/a.ts': 'export const a = 1;\n',
    });
    const project = await new LocalProjectScanner().scan(root);
    assert.ok(project.fileCount >= 2);

    const result = await new TypeScriptStaticAnalyzer().analyze(
      createProject({
        id: asProjectId('proj-tsconfig'),
        name: 'demo',
        source: { kind: 'local', location: project.root },
        revision: project.revision,
      }),
    );

    assert.deepEqual(result.files.map((file) => file.path), ['src/a.ts']);
  });
});
