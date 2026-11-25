/**
 * Source structure extraction (Phase 2A).
 *
 * These tests assert what the parser saw: languages, declarations, exports,
 * imports, locations and syntax diagnostics. Nothing here claims a type, a
 * runtime behaviour or a resolved package.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ANALYSIS_SCHEMA_VERSION, createAnalysisSnapshot } from '../src/index.ts';
import { analyzeFiles, fileByPath, findingsFor } from './helpers/analysis-fixture.ts';

describe('static analysis: source structure', () => {
  it('parses JavaScript and records language, size and digest', async (t) => {
    const source = 'export function greet(name) {\n  return `hi ${name}`;\n}\n';
    const { result } = await analyzeFiles(t, { 'src/index.js': source });

    const file = fileByPath(result, 'src/index.js');
    assert.equal(file.language, 'javascript');
    assert.equal(file.size, Buffer.byteLength(source));
    assert.match(file.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      file.declarations.map((declaration) => [declaration.kind, declaration.name, declaration.exported]),
      [['function', 'greet', true]],
    );
  });

  it('parses TypeScript declarations: interface, enum, type alias, class and methods', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/model.ts': [
        'export interface User { id: string }',
        'export enum Role { Admin, Viewer }',
        'export type UserId = string;',
        'export class Store {',
        '  constructor(private readonly users: User[]) {}',
        '  get count(): number { return this.users.length; }',
        '  add(user: User): void {}',
        '}',
        'const secret = 1;',
      ].join('\n'),
    });

    const file = fileByPath(result, 'src/model.ts');
    assert.equal(file.language, 'typescript');
    const kinds = file.declarations.map((declaration) => `${declaration.kind}:${declaration.name}:${declaration.exported}`);
    assert.ok(kinds.includes('interface:User:true'));
    assert.ok(kinds.includes('enum:Role:true'));
    assert.ok(kinds.includes('type-alias:UserId:true'));
    assert.ok(kinds.includes('class:Store:true'));
    assert.ok(kinds.includes('method:constructor:false'));
    assert.ok(kinds.includes('method:count:false'));
    assert.ok(kinds.includes('method:add:false'));
    assert.ok(kinds.includes('variable:secret:false'));
  });

  it('parses JSX and TSX by extension', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/widget.jsx': 'export const Widget = () => <div>hello</div>;\n',
      'src/view.tsx': 'export function View({ name }: { name: string }) { return <p>{name}</p>; }\n',
    });

    assert.equal(fileByPath(result, 'src/widget.jsx').language, 'javascript');
    assert.equal(fileByPath(result, 'src/view.tsx').language, 'typescript');
    assert.deepEqual(findingsFor(result, 'VB001'), []);
  });

  it('supports every documented source extension', async (t) => {
    const { result } = await analyzeFiles(t, {
      'a.js': 'export const a = 1;\n',
      'b.jsx': 'export const b = <i />;\n',
      'c.mjs': 'export const c = 1;\n',
      'd.cjs': 'module.exports = 1;\n',
      'e.ts': 'export const e: number = 1;\n',
      'f.tsx': 'export const f = <i />;\n',
      'g.mts': 'export const g: number = 1;\n',
      'h.cts': 'module.exports = 1;\n',
    });

    assert.deepEqual(
      result.files.map((file) => `${file.path}:${file.language}`),
      [
        'a.js:javascript',
        'b.jsx:javascript',
        'c.mjs:javascript',
        'd.cjs:javascript',
        'e.ts:typescript',
        'f.tsx:typescript',
        'g.mts:typescript',
        'h.cts:typescript',
      ],
    );
    assert.deepEqual(result.settings.supportedExtensions, [
      '.cjs',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.mts',
      '.ts',
      '.tsx',
    ]);
  });

  it('records export declarations of every shape', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/exports.ts': [
        'const a = 1;',
        'export { a };',
        'export default function main() {}',
        'export function named() {}',
      ].join('\n'),
    });

    const declarations = fileByPath(result, 'src/exports.ts').declarations;
    assert.ok(declarations.some((d) => d.kind === 'export' && d.name === 'a'));
    assert.ok(declarations.some((d) => d.kind === 'function' && d.name === 'main' && d.exported));
    assert.ok(declarations.some((d) => d.kind === 'function' && d.name === 'named' && d.exported));
  });

  it('records static imports and literal dynamic imports with exact specifiers', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/a.ts': 'export const a = 1;\n',
      'src/main.ts': [
        "import { a } from './a';",
        "import type { X } from 'pkg';",
        "export * from './a';",
        "const later = await import('./a');",
      ].join('\n'),
    });

    const imports = fileByPath(result, 'src/main.ts').imports;
    assert.deepEqual(
      imports.map((edge) => [edge.specifier, edge.kind, edge.typeOnly, edge.resolution]),
      [
        ['./a', 'static', false, 'resolved-relative'],
        ['pkg', 'static', true, 'external'],
        ['./a', 'export-from', false, 'resolved-relative'],
        ['./a', 'dynamic', false, 'resolved-relative'],
      ],
    );
    assert.equal(imports[0]?.resolvedPath, 'src/a.ts');
  });

  it('reports a syntax diagnostic with a stable rule id and a location', async (t) => {
    const { result } = await analyzeFiles(t, {
      // Unbalanced brace: the parser must reject it, loudly and specifically.
      'src/broken.ts': 'export function broken() {\n  return 1;\n',
    });

    const diagnostics = findingsFor(result, 'VB001');
    assert.equal(diagnostics.length > 0, true, 'expected at least one parse finding');
    const [first] = diagnostics;
    assert.equal(first?.severity, 'error');
    assert.equal(first?.certainty, 'certain');
    assert.equal(first?.path, 'src/broken.ts');
    // The parser reports the position it gave up at; it must carry one.
    assert.ok((first?.location?.line ?? 0) >= 1);
    assert.ok((first?.location?.column ?? 0) >= 1);
    assert.match(first?.message ?? '', /parser could not read/i);
  });

  it('locates declarations by line and column', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/where.ts': '\n\nfunction third() {}\n',
    });

    const declaration = fileByPath(result, 'src/where.ts').declarations[0];
    assert.deepEqual(declaration?.location, { line: 3, column: 1 });
  });

  it('ignores non-source files and does not claim to analyse them', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/a.ts': 'export const a = 1;\n',
      'README.md': '# hello\n',
      'style.css': 'body { color: red }\n',
      'data.json': '{"a":1}\n',
    });

    assert.deepEqual(result.files.map((file) => file.path), ['src/a.ts']);
    assert.equal(result.files.length, 1);
  });

  it('records nested and anonymous declarations without inventing names', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/nested.ts': [
        'export default class {}',
        'export default () => 1;',
        'const anon = () => 1;',
        'function outer() { function inner() {} }',
      ].join('\n'),
    });

    const declarations = fileByPath(result, 'src/nested.ts').declarations;
    assert.deepEqual(
      declarations.map((d) => [d.kind, d.name, d.exported]),
      [
        ['class', 'default', true],
        ['export', 'default', true],
        ['variable', 'anon', false],
        ['function', 'outer', false],
        ['function', 'inner', false],
      ],
    );
  });

  it('records no class declaration when the parser recovers a nameless class', async (t) => {
    // Not valid JavaScript: V8 rejects `class {}` with a SyntaxError. It is here
    // because TypeScript recovers a ClassDeclaration with no name from it, and no
    // name may be invented for what the syntax does not name.
    const { result } = await analyzeFiles(t, { 'src/recovered-class.ts': 'class {}\n' });

    const declarations = fileByPath(result, 'src/recovered-class.ts').declarations;
    assert.deepEqual(declarations.map((d) => [d.kind, d.name, d.exported]), []);
    assert.equal(
      declarations.some((d) => d.name === '<anonymous>'),
      false,
      'no placeholder name may be fabricated',
    );
  });

  it('records no class declaration for a nameless class in JavaScript source', async (t) => {
    // The same invalid `class {}` on the JavaScript path: the .js extension selects
    // the javascript language branch, so the no-placeholder rule is asserted there
    // too, not only on the .ts path above.
    const { result } = await analyzeFiles(t, { 'src/recovered-class.js': 'class {}\n' });

    const file = fileByPath(result, 'src/recovered-class.js');
    assert.equal(file.language, 'javascript');
    assert.deepEqual(file.declarations.map((d) => [d.kind, d.name, d.exported]), []);
    assert.equal(
      file.declarations.some((d) => d.name === '<anonymous>'),
      false,
      'no placeholder name may be fabricated',
    );
  });

  it('does not read an export modifier alone as the name default', async (t) => {
    // Not valid JavaScript: V8 rejects `export class {}` with a SyntaxError, and
    // TypeScript recovers a ClassDeclaration carrying `ExportKeyword` but no
    // `DefaultKeyword`. An export modifier is not a name, and only `export
    // default` gives the name `default`.
    const { result } = await analyzeFiles(t, { 'src/export-class.ts': 'export class {}\n' });

    const declarations = fileByPath(result, 'src/export-class.ts').declarations;
    assert.equal(
      declarations.some((d) => d.kind === 'class' && d.name === 'default'),
      false,
      'ExportKeyword alone must not produce the name default',
    );
    assert.deepEqual(declarations.map((d) => [d.kind, d.name, d.exported]), []);
  });

  it('keeps member extraction when the enclosing recovered class has no name', async (t) => {
    // Not valid JavaScript: `class { run() {} }` is missing a binding name.
    const { result } = await analyzeFiles(t, {
      'src/recovered-member.ts': 'class { run() {} }\n',
    });

    const declarations = fileByPath(result, 'src/recovered-member.ts').declarations;
    assert.deepEqual(
      declarations.map((d) => [d.kind, d.name, d.exported]),
      [['method', 'run', false]],
    );
  });

  it('keeps variable extraction for a named class expression', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/class-expression.ts': 'const Named = class {};\n',
    });

    const declarations = fileByPath(result, 'src/class-expression.ts').declarations;
    assert.deepEqual(
      declarations.map((d) => [d.kind, d.name, d.exported]),
      [['variable', 'Named', false]],
    );
  });

  it('records an export default class as default and exported', async (t) => {
    // Valid JavaScript with no class name: the default export is what names it.
    const { result } = await analyzeFiles(t, { 'src/default-class.ts': 'export default class {}\n' });

    const declarations = fileByPath(result, 'src/default-class.ts').declarations;
    assert.deepEqual(
      declarations.map((d) => [d.kind, d.name, d.exported]),
      [['class', 'default', true]],
    );
  });

  it('records an export default function as default and exported', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/default-function.ts': 'export default function () {}\n',
    });

    const declarations = fileByPath(result, 'src/default-function.ts').declarations;
    assert.deepEqual(
      declarations.map((d) => [d.kind, d.name, d.exported]),
      [['function', 'default', true]],
    );
  });

  it('records nothing for a recovered function with an empty name, and still snapshots', async (t) => {
    // Not valid JavaScript, and not valid TypeScript either: TypeScript reports
    // "Identifier expected." and recovers a FunctionDeclaration whose name node
    // has empty text. That is not a name, so no declaration is recorded.
    const { project, result } = await analyzeFiles(t, {
      'src/recovered-function.ts': 'function () {}\n',
    });

    const declarations = fileByPath(result, 'src/recovered-function.ts').declarations;
    assert.deepEqual(declarations, []);
    assert.equal(findingsFor(result, 'VB001').length > 0, true, 'the parse diagnostic is kept');

    const snapshot = createAnalysisSnapshot({
      analysisId: 'ana_recovered_function',
      projectId: project.id,
      projectRevision: project.revision,
      analyzerVersion: result.analyzerVersion,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      settings: result.settings,
      files: result.files,
      findings: result.findings,
    });
    assert.equal(snapshot.summary.declarationCount, 0);
    assert.equal(snapshot.analyzerVersion, result.analyzerVersion);
  });
});
