/**
 * Regression: a valid empty source file is analysable (Phase 2A).
 *
 * An empty `.js` file is a legitimate source file with size 0. The shared
 * verified reader rejects an allowance of 0, so the analyzer must request at
 * least one byte of headroom; requesting exactly `scanned.size` made every
 * empty file fail the whole analysis with `scan_limit_exceeded` — a limit error
 * for a file that is over no limit at all.
 *
 * Nothing here claims a type, a resolution or a runtime behaviour: these tests
 * assert only that the empty file is read, recorded with size 0, and produces no
 * finding of its own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { analyzeFiles, fileByPath, findingsFor } from './helpers/analysis-fixture.ts';

describe('static analysis: empty source files', () => {
  it('analyses a project that contains a valid empty .js file', async (t) => {
    const { result } = await analyzeFiles(t, {
      'src/index.js': 'export const answer = 42;\n',
      'src/empty.js': '',
    });

    const empty = fileByPath(result, 'src/empty.js');
    assert.equal(empty.language, 'javascript');
    assert.equal(empty.size, 0);
    assert.match(empty.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(empty.declarations, []);
    assert.deepEqual(empty.imports, []);

    // The empty file is part of the analysed set, not dropped from it.
    assert.deepEqual(
      result.files.map((file) => file.path).sort(),
      ['src/empty.js', 'src/index.js'],
    );

    // Emptiness is not a syntax problem: no diagnostic may be reported for it,
    // and the clean neighbouring file produces none either.
    assert.deepEqual(findingsFor(result, 'VB001'), []);
  });

  it('analyses a project whose only source file is empty', async (t) => {
    const { result } = await analyzeFiles(t, { 'src/empty.js': '' });

    assert.deepEqual(
      result.files.map((file) => [file.path, file.size, file.declarations.length, file.imports.length]),
      [['src/empty.js', 0, 0, 0]],
    );
    assert.deepEqual(findingsFor(result, 'VB001'), []);
  });
});
