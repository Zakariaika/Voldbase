/**
 * ADR index consistency (ADR-0008 rules 1-3).
 *
 * The index in docs/adr/README.md is the only map of the decision log, and the
 * log is only trustworthy if it is complete, ordered, and agrees with each ADR.
 * These checks read the files; they never write them.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ADR_DIR = new URL('../docs/adr/', import.meta.url);
const INDEX = new URL('../docs/adr/README.md', import.meta.url);

const STATUS_WORDS = ['Accepted', 'Proposed', 'Superseded', 'Deprecated'];

interface AdrFile {
  readonly number: string;
  readonly file: string;
  readonly title: string;
  readonly status: string;
}

interface IndexRow {
  readonly number: string;
  readonly link: string;
  readonly title: string;
  readonly status: string;
}

function adrFiles(): AdrFile[] {
  return readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort()
    .map((file) => {
      const text = readFileSync(new URL(file, ADR_DIR), 'utf8');
      const heading = /^# (\d{4})\s+—\s+(.+)$/m.exec(text);
      const status = /^- Status:\s*(.+)$/m.exec(text);

      assert.ok(heading, `${file} must start with "# NNNN — Title"`);
      assert.ok(status, `${file} must declare "- Status: ..."`);

      return {
        number: heading[1] ?? '',
        file,
        title: heading[2]?.trim() ?? '',
        status: (status[1] ?? '').replace(/\*/g, '').trim(),
      };
    });
}

function indexRows(): IndexRow[] {
  const text = readFileSync(INDEX, 'utf8');
  const rows: IndexRow[] = [];

  for (const line of text.split('\n')) {
    const match = /^\| \[(\d{4})\]\(([^)]+)\) \| (.+) \| (.+) \|$/.exec(line.trim());
    if (match === null) continue;
    rows.push({
      number: match[1] ?? '',
      link: match[2] ?? '',
      title: (match[3] ?? '').trim(),
      status: (match[4] ?? '').trim(),
    });
  }

  return rows;
}

function statusWord(value: string): string {
  return value.split(/\s+/)[0] ?? '';
}

describe('ADR index', () => {
  it('lists every ADR exactly once and in numeric order', () => {
    const files = adrFiles();
    const rows = indexRows();

    assert.deepEqual(
      rows.map((row) => row.number),
      files.map((adr) => adr.number),
      'the index must list every ADR once, in order',
    );

    assert.equal(new Set(rows.map((row) => row.number)).size, rows.length);
    assert.deepEqual(
      rows.map((row) => row.link),
      files.map((adr) => adr.file),
      'each index row must link to the file it names',
    );
  });

  it('numbers ADRs consecutively from 0001 without reuse', () => {
    const numbers = adrFiles().map((adr) => Number(adr.number));

    numbers.forEach((number, offset) => {
      assert.equal(number, offset + 1, `expected ADR ${String(offset + 1).padStart(4, '0')}`);
    });
  });

  it('resolves every link in the index', () => {
    for (const row of indexRows()) {
      assert.doesNotThrow(
        () => readFileSync(new URL(row.link, ADR_DIR), 'utf8'),
        `index links to a missing ADR: ${row.link}`,
      );
    }
  });

  it('agrees with each ADR on its title and status', () => {
    const files = adrFiles();
    const rows = indexRows();

    for (const [offset, row] of rows.entries()) {
      const adr = files[offset];
      assert.ok(adr, `no ADR file for index row ${row.number}`);

      assert.equal(row.title, adr.title, `index title differs from ${adr.file}`);
      assert.equal(
        statusWord(row.status),
        statusWord(adr.status),
        `index status differs from ${adr.file}`,
      );
      assert.ok(
        STATUS_WORDS.includes(statusWord(row.status)),
        `unexpected ADR status "${row.status}" in ${adr.file}`,
      );
    }
  });
});
