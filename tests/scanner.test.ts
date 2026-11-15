import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  DomainError,
  EXCLUDED_DIRECTORY_NAMES,
  LocalProjectScanner,
  MANIFEST_ECOSYSTEMS,
  snapshotDigest,
} from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-scan-'));
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

describe('local project scanner', () => {
  it('produces a stable snapshot revision for the same contents', async (t) => {
    const root = await makeTempDir(t);
    const manifest = '{"name":"demo"}\n';
    const source = 'export const value = 1;\n';
    await writeFile(root, 'package.json', manifest);
    await writeFile(root, 'src/index.js', source);

    const scanner = new LocalProjectScanner();
    const first = await scanner.scan(root);
    const second = await scanner.scan(root);

    assert.equal(first.revision, second.revision);
    assert.match(first.revision, /^[0-9a-f]{64}$/);
    assert.equal(first.fileCount, 2);
    assert.equal(first.totalBytes, manifest.length + source.length);
    assert.equal(first.root, await fs.realpath(root));
    assert.equal(first.suggestedName, path.basename(root));
    assert.deepEqual(snapshotDigest([]), snapshotDigest([]));
  });

  it('hashes relative paths, not absolute ones, so copies share a revision', async (t) => {
    const firstRoot = await makeTempDir(t);
    const secondRoot = await makeTempDir(t);
    await writeFile(firstRoot, 'a.txt', 'same\n');
    await writeFile(secondRoot, 'a.txt', 'same\n');

    const scanner = new LocalProjectScanner();
    const first = await scanner.scan(firstRoot);
    const second = await scanner.scan(secondRoot);

    assert.equal(first.revision, second.revision);
  });

  it('changes the revision when file contents change', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'one\n');

    const scanner = new LocalProjectScanner();
    const before = await scanner.scan(root);

    await writeFile(root, 'a.txt', 'two\n');
    const after = await scanner.scan(root);

    assert.notEqual(before.revision, after.revision);
  });

  it('changes the revision when a file is added', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'one\n');
    const scanner = new LocalProjectScanner();
    const before = await scanner.scan(root);

    await writeFile(root, 'b.txt', 'two\n');
    const after = await scanner.scan(root);

    assert.notEqual(before.revision, after.revision);
    assert.equal(after.fileCount, 2);
  });

  it('rejects a missing path', async (t) => {
    const root = await makeTempDir(t);
    const scanner = new LocalProjectScanner();

    await assert.rejects(
      scanner.scan(path.join(root, 'does-not-exist')),
      isDomainError('path_not_found'),
    );
  });

  it('rejects a path that is a file, not a directory', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'x\n');
    const scanner = new LocalProjectScanner();

    await assert.rejects(scanner.scan(path.join(root, 'a.txt')), isDomainError('not_a_directory'));
  });

  it('rejects a missing path argument', async () => {
    const scanner = new LocalProjectScanner();
    await assert.rejects(scanner.scan('   '), isDomainError('invalid_path'));
  });

  it('rejects an empty directory instead of storing an empty snapshot', async (t) => {
    const root = await makeTempDir(t);
    const scanner = new LocalProjectScanner();

    await assert.rejects(scanner.scan(root), isDomainError('empty_project'));
  });

  it('rejects a directory containing only excluded entries', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'node_modules/dependency/index.js', 'module.exports = 1;\n');
    const scanner = new LocalProjectScanner();

    await assert.rejects(scanner.scan(root), isDomainError('empty_project'));
  });

  it('detects every supported dependency manifest with its own digest', async (t) => {
    const root = await makeTempDir(t);
    for (const [fileName] of MANIFEST_ECOSYSTEMS) {
      await writeFile(root, fileName, `${fileName} contents\n`);
    }
    // A nested manifest is detected too: monorepos keep manifests in packages.
    await writeFile(root, 'packages/api/package.json', '{"name":"api"}\n');

    const scanner = new LocalProjectScanner();
    const scan = await scanner.scan(root);
    const byPath = new Map(scan.manifests.map((entry) => [entry.manifestPath, entry]));

    assert.equal(scan.manifests.length, MANIFEST_ECOSYSTEMS.size + 1);
    assert.equal(byPath.get('package.json')?.ecosystem, 'npm');
    assert.equal(byPath.get('requirements.txt')?.ecosystem, 'pypi');
    assert.equal(byPath.get('Cargo.lock')?.ecosystem, 'cargo');
    assert.equal(byPath.get('go.sum')?.ecosystem, 'gomod');
    assert.equal(byPath.get('composer.lock')?.ecosystem, 'composer');
    assert.equal(byPath.get('packages/api/package.json')?.ecosystem, 'npm');

    const digest = byPath.get('package.json')?.digest;
    assert.match(digest ?? '', /^[0-9a-f]{64}$/);
    // The manifest digest is the file's own content hash, not the snapshot hash.
    assert.notEqual(digest, scan.revision);
  });

  it('excludes dependency, build and VCS directories', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'src/index.ts', 'export {};\n');
    for (const directory of EXCLUDED_DIRECTORY_NAMES) {
      await writeFile(root, `${directory}/ignored.txt`, 'ignored\n');
    }

    const scanner = new LocalProjectScanner();
    const scan = await scanner.scan(root);

    assert.equal(scan.fileCount, 1);
    assert.equal(scan.skipped.excludedDirectories, EXCLUDED_DIRECTORY_NAMES.size);
  });

  it('skips symbolic links without following them', async (t) => {
    const root = await makeTempDir(t);
    const outside = await makeTempDir(t);
    await writeFile(outside, 'secret.txt', 'outside content\n');
    await writeFile(root, 'real.txt', 'inside\n');

    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'));
    await fs.symlink(outside, path.join(root, 'directory-link'));

    const scanner = new LocalProjectScanner();
    const scan = await scanner.scan(root);

    assert.equal(scan.fileCount, 1);
    assert.equal(scan.skipped.symlinks, 2);

    // Mutating the link target cannot change the snapshot: it was never read.
    await writeFile(outside, 'secret.txt', 'different content\n');
    const again = await scanner.scan(root);
    assert.equal(again.revision, scan.revision);
  });

  it('does not follow a symbolic link loop', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'content\n');
    await fs.symlink(root, path.join(root, 'loop'));

    const scanner = new LocalProjectScanner();
    const scan = await scanner.scan(root);

    assert.equal(scan.fileCount, 1);
    assert.equal(scan.skipped.symlinks, 1);
  });

  it('fails explicitly when a single file exceeds the per-file limit', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'big.txt', 'x'.repeat(32));
    const scanner = new LocalProjectScanner({ maxFileBytes: 16 });

    await assert.rejects(scanner.scan(root), isDomainError('file_too_large'));
  });

  it('fails explicitly when the file count limit is exceeded', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'a\n');
    await writeFile(root, 'b.txt', 'b\n');
    const scanner = new LocalProjectScanner({ maxFiles: 1 });

    await assert.rejects(scanner.scan(root), isDomainError('scan_limit_exceeded'));
  });

  it('fails explicitly when the total byte limit is exceeded', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'a.txt', 'aaaaaaaaaa');
    await writeFile(root, 'b.txt', 'bbbbbbbbbb');
    const scanner = new LocalProjectScanner({ maxTotalBytes: 12 });

    await assert.rejects(scanner.scan(root), isDomainError('scan_limit_exceeded'));
  });

  it(
    'reports an unreadable file instead of skipping it',
    { skip: process.getuid?.() === 0 ? 'permissions are not enforced for root' : false },
    async (t) => {
      const root = await makeTempDir(t);
      await writeFile(root, 'locked.txt', 'secret\n');
      await writeFile(root, 'ok.txt', 'fine\n');
      await fs.chmod(path.join(root, 'locked.txt'), 0o000);
      t.after(async () => {
        await fs.chmod(path.join(root, 'locked.txt'), 0o600).catch(() => undefined);
      });

      const scanner = new LocalProjectScanner();
      await assert.rejects(scanner.scan(root), isDomainError('path_unreadable'));
    },
  );
});
