/**
 * NodeNext relative import substitution (S2).
 *
 * A TypeScript importer's `.js`/`.mjs`/`.cjs` specifier is tried against its
 * approved TypeScript counterparts first and the literal JavaScript file last.
 * JavaScript importers never substitute, and no other mapping exists. Every case
 * asserts an observable classification, snapshot or architecture value.
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import {
  ANALYSIS_SCHEMA_VERSION,
  buildArchitecture,
  createAnalysisSnapshot,
} from '../src/index.ts';
import { analyzeFiles, fileByPath, findingsFor } from './helpers/analysis-fixture.ts';

type Fixture = Awaited<ReturnType<typeof analyzeFiles>>;
type ImportEdge = Fixture['result']['files'][number]['imports'][number];

/** Analyse a fixture and return the one import edge with `specifier`. */
async function analyzedImport(
  t: TestContext,
  files: Readonly<Record<string, string>>,
  fromPath: string,
  specifier: string,
): Promise<Fixture & { edge: ImportEdge }> {
  const fixture = await analyzeFiles(t, files);
  const matches = fileByPath(fixture.result, fromPath).imports.filter(
    (item) => item.specifier === specifier,
  );
  assert.equal(matches.length, 1, `expected exactly one '${specifier}' import in ${fromPath}`);
  return { ...fixture, edge: matches[0]! };
}

/** Build the snapshot Phase 2A would store, so validation itself is exercised. */
function snapshotFor(fixture: Fixture, analysisId = 'ana_nodenext') {
  return createAnalysisSnapshot({
    analysisId,
    projectId: fixture.project.id,
    projectRevision: fixture.project.revision,
    analyzerVersion: fixture.result.analyzerVersion,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    settings: fixture.result.settings,
    files: fixture.result.files,
    findings: fixture.result.findings,
  });
}

function architectureEdge(
  snapshot: ReturnType<typeof buildArchitecture>,
  from: string,
  to: string,
) {
  const found = snapshot.edges.filter((edge) => edge.from === from && edge.to === to);
  assert.equal(found.length, 1, `expected exactly one edge ${from} -> ${to}`);
  return found[0]!;
}

describe('static analysis: NodeNext import substitution', () => {
  it('resolves .js to .ts for a TypeScript importer', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
    assert.deepEqual(findingsFor(result, 'VB002'), []);
  });

  it('resolves .js to .tsx when only a tsx file exists', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.tsx': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.tsx');
  });

  it('resolves .js to .d.ts and keeps the import resolved', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.d.ts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.d.ts');
    assert.deepEqual(findingsFor(result, 'VB002'), []);
  });

  it('resolves .mjs to .mts for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.mts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.mjs';\n",
      },
      'src/main.ts',
      './module.mjs',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.mts');
  });

  it('resolves .mjs to .d.mts when only a declaration exists', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.d.mts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.mjs';\n",
      },
      'src/main.ts',
      './module.mjs',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.d.mts');
  });

  it('resolves .cjs to .cts for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.cts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.cjs';\n",
      },
      'src/main.ts',
      './module.cjs',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.cts');
  });

  it('resolves .cjs to .d.cts when only a declaration exists', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.d.cts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.cjs';\n",
      },
      'src/main.ts',
      './module.cjs',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.d.cts');
  });

  it('falls back to a literal .js file when no TypeScript candidate exists', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.js');
  });

  it('falls back to literal .mjs and .cjs files when no TypeScript candidate exists', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/module.mjs': 'export const value = 1;\n',
      'src/module.cjs': 'export const other = 2;\n',
      'src/main.ts': [
        "import { value } from './module.mjs';",
        "import { other } from './module.cjs';",
      ].join('\n'),
    });

    const imports = fileByPath(result, 'src/main.ts').imports;
    assert.deepEqual(
      imports.map((item) => [item.specifier, item.resolvedPath]),
      [
        ['./module.mjs', 'src/module.mjs'],
        ['./module.cjs', 'src/module.cjs'],
      ],
    );
  });

  it('prefers .ts over a literal .js for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/module.ts': 'export const value = 2;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('prefers .tsx over a literal .js for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/module.tsx': 'export const value = 2;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolvedPath, 'src/module.tsx');
  });

  it('prefers .d.ts over a literal .js for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/module.d.ts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolvedPath, 'src/module.d.ts');
  });

  it('prefers .mts over a literal .mjs for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.mjs': 'export const value = 1;\n',
        'src/module.mts': 'export const value = 2;\n',
        'src/main.ts': "import { value } from './module.mjs';\n",
      },
      'src/main.ts',
      './module.mjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.mts');
  });

  it('prefers .d.mts over a literal .mjs for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.mjs': 'export const value = 1;\n',
        'src/module.d.mts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.mjs';\n",
      },
      'src/main.ts',
      './module.mjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.d.mts');
  });

  it('prefers .cts over a literal .cjs for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.cjs': 'export const value = 1;\n',
        'src/module.cts': 'export const value = 2;\n',
        'src/main.ts': "import { value } from './module.cjs';\n",
      },
      'src/main.ts',
      './module.cjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.cts');
  });

  it('prefers .d.cts over a literal .cjs for a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.cjs': 'export const value = 1;\n',
        'src/module.d.cts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.cjs';\n",
      },
      'src/main.ts',
      './module.cjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.d.cts');
  });

  it('keeps the approved .js precedence when .ts, .tsx and the literal all exist', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/module.ts': 'export const value = 2;\n',
        'src/module.tsx': 'export const value = 3;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('keeps .ts before .d.ts and the literal .js', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/module.ts': 'export const value = 2;\n',
        'src/module.d.ts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('keeps the approved .mjs precedence when .mts, .d.mts and the literal all exist', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.mjs': 'export const value = 1;\n',
        'src/module.mts': 'export const value = 2;\n',
        'src/module.d.mts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.mjs';\n",
      },
      'src/main.ts',
      './module.mjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.mts');
  });

  it('keeps the approved .cjs precedence when .cts, .d.cts and the literal all exist', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.cjs': 'export const value = 1;\n',
        'src/module.cts': 'export const value = 2;\n',
        'src/module.d.cts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.cjs';\n",
      },
      'src/main.ts',
      './module.cjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.cts');
  });

  it('resolves ./dir/index.js to dir/index.ts', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/dir/index.ts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './dir/index.js';\n",
      },
      'src/main.ts',
      './dir/index.js',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/dir/index.ts');
    assert.deepEqual(findingsFor(result, 'VB002'), []);
  });

  it('stays unresolved when no candidate exists', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      { 'src/main.ts': "import { value } from './module.js';\n" },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolution, 'unresolved-relative');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB002').length, 1);
  });

  it('never substitutes for a path that climbs above the root', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from '../../../module.js';\n",
      },
      'src/main.ts',
      '../../../module.js',
    );

    assert.equal(edge.resolution, 'outside-root');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB004').length, 1);
    assert.deepEqual(findingsFor(result, 'VB002'), []);
  });

  it('does not substitute for a JavaScript importer with only a .ts counterpart', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.js': "import { value } from './module.js';\n",
      },
      'src/main.js',
      './module.js',
    );

    assert.equal(edge.resolution, 'unresolved-relative');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB002').length, 1);
  });

  it('does not substitute for a JavaScript importer with only a declaration counterpart', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.d.ts': 'export declare const value: number;\n',
        'src/main.js': "import { value } from './module.js';\n",
      },
      'src/main.js',
      './module.js',
    );

    assert.equal(edge.resolution, 'unresolved-relative');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB002').length, 1);
  });

  it('lets a JavaScript importer keep its literal .js even when .ts exists', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/module.ts': 'export const value = 2;\n',
        'src/main.js': "import { value } from './module.js';\n",
      },
      'src/main.js',
      './module.js',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.js');
  });

  it('lets a JavaScript importer keep its literal .mjs over a .mts', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.mjs': 'export const value = 1;\n',
        'src/module.mts': 'export const value = 2;\n',
        'src/main.js': "import { value } from './module.mjs';\n",
      },
      'src/main.js',
      './module.mjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.mjs');
  });

  it('lets a JavaScript importer keep its literal .cjs over a .cts', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.cjs': 'export const value = 1;\n',
        'src/module.cts': 'export const value = 2;\n',
        'src/main.js': "import { value } from './module.cjs';\n",
      },
      'src/main.js',
      './module.cjs',
    );

    assert.equal(edge.resolvedPath, 'src/module.cjs');
  });

  it('leaves a JavaScript importer literal dynamic import on the exact source', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.mjs': 'export const value = 1;\n',
        'src/module.mts': 'export const value = 2;\n',
        'src/main.js': "async function load() { return await import('./module.mjs'); }\n",
      },
      'src/main.js',
      './module.mjs',
    );

    assert.equal(edge.kind, 'dynamic');
    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.mjs');
    assert.deepEqual(findingsFor(result, 'VB002'), []);
  });

  it('substitutes for a literal dynamic import from a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "async function load() { return await import('./module.js'); }\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.kind, 'dynamic');
    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('substitutes for a literal require() from a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "const loaded = require('./module.js');\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.kind, 'require');
    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('substitutes for import x = require() from a TypeScript importer', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "import loaded = require('./module.js');\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.kind, 'require');
    assert.equal(edge.typeOnly, false);
    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('substitutes for an export-from re-export', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "export { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.kind, 'export-from');
    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('substitutes for a type-only import and keeps the flag', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export interface T { value: number }\n',
        'src/main.ts': "import type { T } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.typeOnly, true);
    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('substitutes for a type-only re-export and keeps the flag', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export interface T { value: number }\n',
        'src/main.ts': "export type { T } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.kind, 'export-from');
    assert.equal(edge.typeOnly, true);
    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('leaves a computed dynamic import out of the resolver', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/module.ts': 'export const value = 1;\n',
      'src/main.ts':
        'async function load(name: string) { return await import(`./${name}.js`); }\n',
    });

    assert.deepEqual(fileByPath(result, 'src/main.ts').imports, []);
    assert.equal(findingsFor(result, 'VB003').length, 1);
    assert.deepEqual(findingsFor(result, 'VB002'), []);
  });

  it('leaves an extensionless import on its existing .ts-before-.js behavior', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/module.js': 'export const value = 1;\n',
        'src/module.ts': 'export const value = 2;\n',
        'src/main.ts': "import { value } from './module';\n",
      },
      'src/main.ts',
      './module',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/module.ts');
  });

  it('leaves extensionless index resolution unchanged', async (t) => {
    const { edge } = await analyzedImport(
      t,
      {
        'src/dir/index.ts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './dir';\n",
      },
      'src/main.ts',
      './dir',
    );

    assert.equal(edge.resolution, 'resolved-relative');
    assert.equal(edge.resolvedPath, 'src/dir/index.ts');
  });

  it('never resolves a non-source file even when it exists', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/styles.css': 'body { color: red; }\n',
      'src/data.json': '{"ok":true}\n',
      'src/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" />\n',
      'src/main.ts': [
        "import './styles.css';",
        "import data from './data.json' with { type: 'json' };",
        "import './logo.svg';",
      ].join('\n'),
    });

    const imports = fileByPath(result, 'src/main.ts').imports;
    assert.equal(imports.length, 3);
    for (const item of imports) {
      assert.equal(item.resolution, 'unresolved-relative');
      assert.equal(item.resolvedPath, undefined);
    }
  });

  it('keeps a non-relative .js specifier external', async (t) => {
    const { edge } = await analyzedImport(
      t,
      { 'src/main.ts': "import { value } from 'pkg/x.js';\n" },
      'src/main.ts',
      'pkg/x.js',
    );

    assert.equal(edge.resolution, 'external');
    assert.equal(edge.resolvedPath, undefined);
  });

  it('never maps .js to .mjs, .mts or .cts', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.mjs': 'export const value = 1;\n',
        'src/module.mts': 'export const value = 2;\n',
        'src/module.cts': 'export const value = 3;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    assert.equal(edge.resolution, 'unresolved-relative');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB002').length, 1);
  });

  it('never maps .mjs to .ts or .tsx', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/module.tsx': 'export const value = 2;\n',
        'src/main.ts': "import { value } from './module.mjs';\n",
      },
      'src/main.ts',
      './module.mjs',
    );

    assert.equal(edge.resolution, 'unresolved-relative');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB002').length, 1);
  });

  it('never maps .cjs to .ts or .tsx', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/module.tsx': 'export const value = 2;\n',
        'src/main.ts': "import { value } from './module.cjs';\n",
      },
      'src/main.ts',
      './module.cjs',
    );

    assert.equal(edge.resolution, 'unresolved-relative');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB002').length, 1);
  });

  it('does not substitute .jsx at all', async (t) => {
    const { result, edge } = await analyzedImport(
      t,
      {
        'src/module.tsx': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.jsx';\n",
      },
      'src/main.ts',
      './module.jsx',
    );

    assert.equal(edge.resolution, 'unresolved-relative');
    assert.equal(edge.resolvedPath, undefined);
    assert.equal(findingsFor(result, 'VB002').length, 1);
  });

  it('builds a valid, reproducible snapshot for a substituted import', async (t) => {
    const fixture = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    const first = snapshotFor(fixture, 'ana_nodenext_one');
    const second = snapshotFor(fixture, 'ana_nodenext_two');

    assert.equal(first.summary.resolvedImportCount, 1);
    assert.equal(first.summary.importCount, 1);
    assert.equal(first.digest.length, 64);
    assert.equal(first.digest, second.digest);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.analyzerVersion, '1.0.2');
  });

  it('validates a .d.ts target in the snapshot and records the exact architecture edge', async (t) => {
    const fixture = await analyzedImport(
      t,
      {
        'src/module.d.ts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    const snapshot = snapshotFor(fixture);
    const edge = architectureEdge(buildArchitecture(snapshot), 'src/main.ts', 'src/module.d.ts');

    assert.equal(fixture.edge.resolvedPath, 'src/module.d.ts');
    assert.deepEqual(edge, {
      from: 'src/main.ts',
      to: 'src/module.d.ts',
      kinds: ['static'],
      specifiers: ['./module.js'],
      importCount: 1,
    });
  });

  it('validates a .d.mts target in the snapshot and records the exact architecture edge', async (t) => {
    const fixture = await analyzedImport(
      t,
      {
        'src/module.d.mts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.mjs';\n",
      },
      'src/main.ts',
      './module.mjs',
    );

    const snapshot = snapshotFor(fixture);
    const edge = architectureEdge(buildArchitecture(snapshot), 'src/main.ts', 'src/module.d.mts');

    assert.equal(fixture.edge.resolvedPath, 'src/module.d.mts');
    assert.deepEqual(edge, {
      from: 'src/main.ts',
      to: 'src/module.d.mts',
      kinds: ['static'],
      specifiers: ['./module.mjs'],
      importCount: 1,
    });
  });

  it('validates a .d.cts target in the snapshot and records the exact architecture edge', async (t) => {
    const fixture = await analyzedImport(
      t,
      {
        'src/module.d.cts': 'export declare const value: number;\n',
        'src/main.ts': "import { value } from './module.cjs';\n",
      },
      'src/main.ts',
      './module.cjs',
    );

    const snapshot = snapshotFor(fixture);
    const edge = architectureEdge(buildArchitecture(snapshot), 'src/main.ts', 'src/module.d.cts');

    assert.equal(fixture.edge.resolvedPath, 'src/module.d.cts');
    assert.deepEqual(edge, {
      from: 'src/main.ts',
      to: 'src/module.d.cts',
      kinds: ['static'],
      specifiers: ['./module.cjs'],
      importCount: 1,
    });
  });

  it('records a substituted .ts import as one architecture edge and updates fan-in/out', async (t) => {
    const fixture = await analyzedImport(
      t,
      {
        'src/module.ts': 'export const value = 1;\n',
        'src/main.ts': "import { value } from './module.js';\n",
      },
      'src/main.ts',
      './module.js',
    );

    const architecture = buildArchitecture(snapshotFor(fixture));
    const edge = architectureEdge(architecture, 'src/main.ts', 'src/module.ts');
    const importer = architecture.nodes.find((node) => node.path === 'src/main.ts');
    const target = architecture.nodes.find((node) => node.path === 'src/module.ts');

    assert.deepEqual(edge, {
      from: 'src/main.ts',
      to: 'src/module.ts',
      kinds: ['static'],
      specifiers: ['./module.js'],
      importCount: 1,
    });
    assert.equal(importer?.fanOut, 1);
    assert.equal(target?.fanIn, 1);
  });
});
