/**
 * Filesystem race (time-of-check/time-of-use) tests for the scanner.
 *
 * The scanner discovers an entry, then opens it. These tests swap or remove the
 * entry in exactly that window — deterministically, through the scanner's
 * `beforeRead` test hook — and assert the scan fails loudly instead of silently
 * hashing whatever the path now points at.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { DomainError, LocalProjectScanner } from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-race-'));
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

describe('scanner filesystem safety', () => {
  it('skips symbolic links to files without reading the target', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFile(outside, 'secret.env', 'TOKEN=super-secret\n');
    await writeFile(root, 'real.txt', 'inside\n');
    await fs.symlink(path.join(outside, 'secret.env'), path.join(root, 'link.env'));

    const scan = await new LocalProjectScanner().scan(root);

    assert.equal(scan.fileCount, 1);
    assert.equal(scan.skipped.symlinks, 1);
  });

  it('skips symbolic links to directories without traversing them', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFile(outside, 'nested/secret.txt', 'outside\n');
    await writeFile(root, 'real.txt', 'inside\n');
    await fs.symlink(outside, path.join(root, 'linked-directory'));

    const scan = await new LocalProjectScanner().scan(root);

    assert.equal(scan.fileCount, 1);
    assert.equal(scan.skipped.symlinks, 1);
  });

  it('rejects an entry that disappears between discovery and read', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'content\n');
    await writeFile(root, 'b.txt', 'other\n');

    const scanner = new LocalProjectScanner(
      {},
      {
        async beforeRead(absolutePath, relativePath) {
          if (relativePath === 'a.txt') {
            await fs.rm(absolutePath, { force: true });
          }
        },
      },
    );

    await assert.rejects(scanner.scan(root), isDomainError('scan_entry_changed'));
  });

  it('rejects an entry replaced by a symbolic link before it is opened', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFile(outside, 'secret.txt', 'outside secret\n');
    await writeFile(root, 'a.txt', 'inside\n');

    const scanner = new LocalProjectScanner(
      {},
      {
        async beforeRead(absolutePath, relativePath) {
          if (relativePath === 'a.txt') {
            await fs.rm(absolutePath, { force: true });
            await fs.symlink(path.join(outside, 'secret.txt'), absolutePath);
          }
        },
      },
    );

    // Either `O_NOFOLLOW` refuses the open (POSIX) or the descriptor identity
    // check catches the swap (platforms without `O_NOFOLLOW`).
    await assert.rejects(scanner.scan(root), isDomainError('scan_entry_changed'));
  });

  it('rejects an entry replaced by a different regular file', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'original\n');
    // A pre-created file with a distinct inode: renaming it over `a.txt` swaps the
    // entry without the filesystem being free to reuse the original inode.
    await writeFile(outside, 'replacement.bin', 'replacement\n');

    const scanner = new LocalProjectScanner(
      {},
      {
        async beforeRead(absolutePath, relativePath) {
          if (relativePath === 'a.txt') {
            await fs.rename(path.join(outside, 'replacement.bin'), absolutePath);
          }
        },
      },
    );

    const error = await scanner.scan(root).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    assert.ok(error instanceof DomainError, 'expected the scan to fail');
    assert.equal(error.code, 'scan_entry_changed');
  });

  it('rejects an entry that becomes unreadable during the scan', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'content\n');

    const scanner = new LocalProjectScanner(
      {},
      {
        async beforeRead(absolutePath, relativePath) {
          if (relativePath === 'a.txt') {
            await fs.chmod(absolutePath, 0o000);
          }
        },
      },
    );

    // Root ignores permissions, so only assert the failure where it applies.
    if (process.getuid?.() === 0) {
      const scan = await scanner.scan(root);
      assert.equal(scan.fileCount, 1);
      return;
    }

    await assert.rejects(scanner.scan(root), isDomainError('path_unreadable'));
  });

  it('still scans an unchanged project normally', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'package.json', '{"name":"demo"}\n');
    await writeFile(root, 'src/index.js', 'export const a = 1;\n');

    const hookCalls: string[] = [];
    const scanner = new LocalProjectScanner(
      {},
      {
        beforeRead(_absolutePath, relativePath) {
          hookCalls.push(relativePath);
        },
      },
    );

    const scan = await scanner.scan(root);

    assert.equal(scan.fileCount, 2);
    assert.match(scan.revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(hookCalls.sort(), ['package.json', 'src/index.js']);
  });

  it('succeeds again after the interfering change is undone', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFile(outside, 'secret.txt', 'outside\n');
    await writeFile(root, 'a.txt', 'inside\n');

    let interfere = true;
    const scanner = new LocalProjectScanner(
      {},
      {
        async beforeRead(absolutePath, relativePath) {
          if (interfere && relativePath === 'a.txt') {
            await fs.rm(absolutePath, { force: true });
            await fs.symlink(path.join(outside, 'secret.txt'), absolutePath);
          }
        },
      },
    );

    await assert.rejects(scanner.scan(root), isDomainError('scan_entry_changed'));

    await fs.rm(path.join(root, 'a.txt'), { force: true });
    await writeFile(root, 'a.txt', 'inside\n');
    interfere = false;

    const scan = await scanner.scan(root);
    assert.equal(scan.fileCount, 1);
  });
});
