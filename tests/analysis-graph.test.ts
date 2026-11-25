/**
 * Import relationship graph (Phase 2A).
 *
 * The graph is deliberately conservative: a relative specifier is "resolved" only
 * when it names a file that was actually analysed, and a package specifier is
 * never claimed as resolved because VOLDBASE performs no module resolution.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANALYSIS_SCHEMA_VERSION, createAnalysisSnapshot } from '../src/index.ts';
import { analyzeFiles, fileByPath, findingsFor } from './helpers/analysis-fixture.ts';

function edge(result: Awaited<ReturnType<typeof analyzeFiles>>['result'], file: string, specifier: string) {
  const found = fileByPath(result, file).imports.filter((item) => item.specifier === specifier);
  assert.equal(found.length > 0, true, `expected ${file} to import '${specifier}'`);
  return found[0]!;
}

describe('static analysis: import graph', () => {
  it('resolves relative imports, with and without extensions, and index files', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/lib/index.ts': 'export const lib = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.js': 'export const b = 1;\n',
      'src/main.ts': [
        "import { a } from './a';",
        "import { b } from './b.js';",
        "import { lib } from './lib';",
      ].join('\n'),
    });

    assert.deepEqual(
      [
        edge(result, 'src/main.ts', './a').resolvedPath,
        edge(result, 'src/main.ts', './b.js').resolvedPath,
        edge(result, 'src/main.ts', './lib').resolvedPath,
      ],
      ['src/a.ts', 'src/b.js', 'src/lib/index.ts'],
    );
    for (const specifier of ['./a', './b.js', './lib']) {
      assert.equal(edge(result, 'src/main.ts', specifier).resolution, 'resolved-relative');
    }
    assert.equal(result.files.length, 4);
  });

  it('classifies package and builtin imports as external without resolving them', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/main.ts': [
        "import express from 'express';",
        "import { readFile } from 'node:fs/promises';",
        "import scoped from '@scope/pkg/sub';",
      ].join('\n'),
    });

    const imports = fileByPath(result, 'src/main.ts').imports;
    assert.deepEqual(
      imports.map((item) => [item.specifier, item.resolution, item.resolvedPath]),
      [
        ['express', 'external', undefined],
        ['node:fs/promises', 'external', undefined],
        ['@scope/pkg/sub', 'external', undefined],
      ],
    );
    // Nothing was claimed: no finding, no resolution, no network.
    assert.deepEqual(findingsFor(result, 'VB002'), []);
  });

  it('reports an unresolved relative import and keeps the original specifier', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/main.ts': "import { gone } from './missing';\n",
    });

    const unresolved = edge(result, 'src/main.ts', './missing');
    assert.equal(unresolved.resolution, 'unresolved-relative');
    assert.equal(unresolved.resolvedPath, undefined);

    const [finding] = findingsFor(result, 'VB002');
    assert.equal(finding?.severity, 'warning');
    assert.equal(finding?.certainty, 'certain');
    assert.equal(finding?.path, 'src/main.ts');
    // Points at the opening quote of the specifier, not at the statement.
    assert.deepEqual(finding?.location, { line: 1, column: 22 });
    assert.equal(finding?.evidence, './missing');
  });

  it('classifies a path that climbs above the project root', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/main.ts': "import { x } from '../../../outside/module';\n",
    });

    const outside = edge(result, 'src/main.ts', '../../../outside/module');
    assert.equal(outside.resolution, 'outside-root');
    assert.equal(outside.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB004').length, 1);
  });

  it('records a dynamic import with a literal specifier as an edge', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/lazy.ts': 'export const lazy = 1;\n',
      'src/main.ts': "async function load() { return await import('./lazy'); }\n",
    });

    const dynamic = edge(result, 'src/main.ts', './lazy');
    assert.equal(dynamic.kind, 'dynamic');
    assert.equal(dynamic.resolvedPath, 'src/lazy.ts');
  });

  it('reports a computed dynamic import as a limit, not a fault', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/main.ts': 'async function load(name: string) { return await import(`./${name}`); }\n',
    });

    const imports = fileByPath(result, 'src/main.ts').imports;
    assert.deepEqual(imports, []);

    const [finding] = findingsFor(result, 'VB003');
    assert.equal(finding?.severity, 'info');
    assert.equal(finding?.certainty, 'conditional');
    assert.match(finding?.message ?? '', /cannot be determined statically/i);
  });

  it('treats require() with a literal as an import edge and ignores a computed one', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/a.cjs': 'module.exports = 1;\n',
      'src/main.cjs': [
        "const a = require('./a');",
        'const name = "b";',
        'const b = require(name);',
      ].join('\n'),
    });

    const imports = fileByPath(result, 'src/main.cjs').imports;
    assert.equal(imports.length, 1);
    assert.equal(imports[0]?.kind, 'require');
    assert.equal(imports[0]?.resolution, 'resolved-relative');
    assert.equal(imports[0]?.resolvedPath, 'src/a.cjs');
  });

  it('records a type-only import as erased at runtime', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/types.ts': 'export interface T { a: number }\n',
      'src/main.ts': "import type { T } from './types';\n",
    });

    const imports = fileByPath(result, 'src/main.ts').imports;
    assert.equal(imports[0]?.typeOnly, true);
    assert.equal(imports[0]?.resolvedPath, 'src/types.ts');
  });

  it('never resolves an existing non-source target, and still builds a snapshot', async (t) => {
    const { project, result } = await analyzeFiles(t, {
      'src/styles.css': 'body { color: red; }\n',
      'src/data.json': '{"ok":true}\n',
      'src/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" />\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/main.ts': [
        "import './styles.css';",
        "import data from './data.json' with { type: 'json' };",
        "import './logo.svg';",
        "import { a } from './a';",
        "import { gone } from './missing';",
        "import { x } from '../../../outside/module';",
      ].join('\n'),
    });

    const imports = fileByPath(result, 'src/main.ts').imports;
    const bySpecifier = new Map(imports.map((item) => [item.specifier, item]));

    // An existing asset is still not an analysed source file: it must be
    // classified without a resolvedPath, never as a resolved source import.
    for (const specifier of ['./styles.css', './data.json', './logo.svg']) {
      const item = bySpecifier.get(specifier);
      assert.ok(item, `expected an import edge for ${specifier}`);
      assert.notEqual(item.resolution, 'resolved-relative');
      assert.equal(item.resolvedPath, undefined);
    }

    // Valid source imports, unresolved paths and out-of-root paths are unchanged.
    assert.equal(bySpecifier.get('./a')?.resolution, 'resolved-relative');
    assert.equal(bySpecifier.get('./a')?.resolvedPath, 'src/a.ts');
    assert.equal(bySpecifier.get('./missing')?.resolution, 'unresolved-relative');
    assert.equal(bySpecifier.get('../../../outside/module')?.resolution, 'outside-root');
    assert.equal(
      findingsFor(result, 'VB002').some((finding) => finding.evidence === './missing'),
      true,
    );
    assert.equal(findingsFor(result, 'VB004').length, 1);

    // The failure this guards against was `invalid_analysis_snapshot` in the
    // domain, so the test must build the snapshot, not just the analyzer result.
    const snapshot = createAnalysisSnapshot({
      analysisId: 'ana_non_source_targets',
      projectId: project.id,
      projectRevision: project.revision,
      analyzerVersion: result.analyzerVersion,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      settings: result.settings,
      files: result.files,
      findings: result.findings,
    });
    assert.equal(snapshot.summary.resolvedImportCount, 1);
  });

  it('never resolves a specifier to a file that was not analysed', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/main.ts': "import { x } from './node_modules/pkg/index';\nimport { y } from '../main';\n",
    });

    for (const item of fileByPath(result, 'src/main.ts').imports) {
      assert.equal(item.resolution !== 'resolved-relative', true);
      assert.equal(item.resolvedPath, undefined);
    }
  });
});
