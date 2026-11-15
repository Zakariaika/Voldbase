/**
 * Scan limits are enforced on the bytes actually read (ADR-0014).
 *
 * A size is only an observation: the file can grow between the check and the
 * read. These tests grow files in that window (or replace them after the
 * descriptor was validated) and assert the scan aborts instead of accepting an
 * oversized read into a snapshot.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { DomainError, LocalProjectScanner } from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-limits-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeFile(root: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

describe('scanner read limits', () => {
  it('rejects a file that grows past the per-file limit after validation', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', '0123456789');

    const scanner = new LocalProjectScanner(
      { maxFileBytes: 64, maxTotalBytes: 1024 * 1024 },
      {
        async beforeReadBytes(absolutePath, relativePath) {
          if (relativePath === 'a.txt') {
            await fs.appendFile(absolutePath, 'x'.repeat(200), 'utf8');
          }
        },
      },
    );

    await assert.rejects(scanner.scan(root), isDomainError('file_too_large'));
  });

  it('counts the bytes actually read against the total budget', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'a'.repeat(60));
    await writeFile(root, 'b.txt', 'bbbbb');

    const scanner = new LocalProjectScanner(
      { maxFileBytes: 1_000, maxTotalBytes: 100 },
      {
        async beforeReadBytes(absolutePath, relativePath) {
          // Grows past what is left of the total budget (100 - 60 = 40 bytes).
          if (relativePath === 'b.txt') {
            await fs.appendFile(absolutePath, 'y'.repeat(200), 'utf8');
          }
        },
      },
    );

    await assert.rejects(scanner.scan(root), isDomainError('scan_limit_exceeded'));
  });

  it('accepts a file exactly at the per-file limit and rejects one byte more', async (t) => {
    const atLimit = await makeTempDir(t);
    await writeFile(atLimit, 'exact.bin', 'z'.repeat(32));
    const scanner = new LocalProjectScanner({ maxFileBytes: 32, maxTotalBytes: 1024 });

    const scan = await scanner.scan(atLimit);
    assert.equal(scan.fileCount, 1);
    assert.equal(scan.totalBytes, 32);

    const overLimit = await makeTempDir(t);
    await writeFile(overLimit, 'over.bin', 'z'.repeat(33));
    await assert.rejects(scanner.scan(overLimit), isDomainError('file_too_large'));
  });

  it('rejects a file replaced by a symbolic link after the descriptor was validated', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFile(outside, 'secret.txt', 'outside secret\n');
    await writeFile(root, 'a.txt', 'inside\n');

    const scanner = new LocalProjectScanner(
      {},
      {
        // Windows has no `O_NOFOLLOW`; this is the check that still catches a
        // substitution there, so it is exercised on every platform.
        async beforeReadBytes(absolutePath, relativePath) {
          if (relativePath === 'a.txt') {
            await fs.rm(absolutePath, { force: true });
            await fs.symlink(path.join(outside, 'secret.txt'), absolutePath);
          }
        },
      },
    );

    await assert.rejects(scanner.scan(root), isDomainError('scan_entry_changed'));
  });

  it('produces the same revision on repeated scans of unchanged content', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'package.json', '{"name":"demo"}\n');
    await writeFile(root, 'src/deep/module.js', 'export const value = 1;\n');

    const scanner = new LocalProjectScanner();
    const first = await scanner.scan(root);
    const second = await scanner.scan(root);

    assert.equal(first.revision, second.revision);
    assert.equal(first.fileCount, 2);
    assert.match(first.revision, /^[0-9a-f]{64}$/);
  });
});
