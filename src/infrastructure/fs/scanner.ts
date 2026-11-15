/**
 * Read-only local project scanner (Phase 1).
 *
 * The snapshot digest covers the *contents* of the imported tree, not the Git
 * HEAD: a project imported from a dirty working tree is described by what is on
 * disk. The scan is deterministic — same bytes, same ordering, same digest —
 * because the canonical manifest sorts every entry.
 *
 * It performs no execution and installs nothing: files are opened for reading,
 * hashed, and closed.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';

import { DomainError } from '../../domain/errors.ts';
import { sha256Hex } from '../../domain/integrity.ts';
import { asRevision } from '../../domain/revision.ts';
import type { DetectedManifest, ProjectScan, ProjectScanner } from '../../application/ports.ts';

/**
 * Directory names never traversed, matched on the entry name at any depth.
 *
 * These are build output, dependency caches and VCS internals: their contents are
 * either reproducible from the source or irrelevant to what the project *is*.
 */
export const EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  'target',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  '.terraform',
]);

/** Recognized dependency manifest file names and the ecosystem they imply. */
export const MANIFEST_ECOSYSTEMS: ReadonlyMap<string, string> = new Map([
  ['package.json', 'npm'],
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'npm'],
  ['yarn.lock', 'npm'],
  ['requirements.txt', 'pypi'],
  ['pyproject.toml', 'pypi'],
  ['poetry.lock', 'pypi'],
  ['Cargo.toml', 'cargo'],
  ['Cargo.lock', 'cargo'],
  ['go.mod', 'gomod'],
  ['go.sum', 'gomod'],
  ['composer.json', 'composer'],
  ['composer.lock', 'composer'],
]);

/**
 * `O_NOFOLLOW` makes `open()` fail with `ELOOP` instead of following a symbolic
 * link. It exists on POSIX platforms; on Windows the constant is absent, so the
 * flag degrades to plain `O_RDONLY` and the post-read path check is what detects
 * the substitution (see ADR-0014).
 */
const O_NOFOLLOW: number =
  typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/** Test/instrumentation seam; never used by production code. */
export interface ScannerHooks {
  /**
   * Called right before a discovered file is opened. Used by tests to reproduce
   * a filesystem change between discovery and read. Must not read or modify
   * anything in production use.
   */
  beforeRead?(absolutePath: string, relativePath: string): void | Promise<void>;
  /**
   * Called after the descriptor was validated and before the first chunk is
   * read, so tests can make a file grow after the size check. Never used by
   * production code.
   */
  beforeReadBytes?(absolutePath: string, relativePath: string): void | Promise<void>;
}

/** Size of the buffer used to read a file in bounded chunks. */
const READ_CHUNK_BYTES = 64 * 1024;

export interface ScannerLimits {
  /** Maximum number of regular files in one snapshot. */
  readonly maxFiles: number;
  /** Maximum total bytes of file contents in one snapshot. */
  readonly maxTotalBytes: number;
  /** Maximum size of a single file; larger files abort the scan. */
  readonly maxFileBytes: number;
}

export const DEFAULT_SCANNER_LIMITS: ScannerLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
};

export interface ScannedFile {
  readonly relPath: string;
  readonly size: number;
  readonly digest: string;
}

interface CollectedTree {
  readonly files: readonly ScannedFile[];
  readonly symlinks: number;
  readonly excludedDirectories: number;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Translate a filesystem error into a domain error.
 *
 * `changedCode` is used when the error happens *after* an entry was discovered:
 * a file that vanished mid-scan is not a missing-path argument error, it is a
 * project that changed underneath us, and it must be reported as such.
 */
function readFailure(error: unknown, subject: string, changedCode?: string): DomainError {
  const code = errorCode(error);
  if (code === 'ENOENT') {
    return changedCode === undefined
      ? new DomainError('path_not_found', `${subject} does not exist`)
      : new DomainError(
          changedCode,
          `${subject} disappeared while scanning; the project changed, import it again`,
        );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new DomainError('path_unreadable', `${subject} is not readable (permission denied)`);
  }
  if (code === 'ENOTDIR') {
    return changedCode === undefined
      ? new DomainError('not_a_directory', `${subject} is not a directory`)
      : new DomainError(changedCode, `${subject} is no longer a directory`);
  }
  return new DomainError('path_unreadable', `Cannot read ${subject}: ${describeFailure(error)}`);
}

/** Sort by UTF-16 code unit so ordering never depends on locale. */
function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Turn an over-budget read into the right error: a single file over the per-file
 * limit is `file_too_large`; anything else that exhausts the total budget is
 * `scan_limit_exceeded`. Both abort the import.
 */
function limitFailure(relativePath: string, bytes: number, limits: ScannerLimits): DomainError {
  if (bytes > limits.maxFileBytes) {
    return new DomainError(
      'file_too_large',
      `${relativePath} is ${bytes} bytes, above the ${limits.maxFileBytes}-byte per-file limit`,
    );
  }
  return new DomainError(
    'scan_limit_exceeded',
    `Project exceeds the ${limits.maxTotalBytes}-byte total scan limit at ${relativePath}`,
  );
}

function manifestFor(file: ScannedFile): DetectedManifest | undefined {
  const name = file.relPath.slice(file.relPath.lastIndexOf('/') + 1);
  const ecosystem = MANIFEST_ECOSYSTEMS.get(name);
  if (ecosystem === undefined) {
    return undefined;
  }
  return { ecosystem, manifestPath: file.relPath, digest: file.digest };
}

/**
 * Canonical digest of a scanned tree.
 *
 * One line per file — `contentDigest`, size, relative path — sorted by path.
 * The newline terminator keeps the encoding unambiguous.
 */
export function snapshotDigest(files: readonly ScannedFile[]): string {
  const canonical = files.map((file) => `${file.digest}  ${file.size}  ${file.relPath}`);
  return sha256Hex(`${canonical.join('\n')}\n`);
}

export class LocalProjectScanner implements ProjectScanner {
  readonly #limits: ScannerLimits;
  readonly #hooks: ScannerHooks;

  constructor(limits: Partial<ScannerLimits> = {}, hooks: ScannerHooks = {}) {
    this.#limits = { ...DEFAULT_SCANNER_LIMITS, ...limits };
    this.#hooks = hooks;
  }

  /**
   * Open a file for reading and prove it is still the same regular file that was
   * discovered, then read it from that handle.
   *
   * Checking a path and then reading the path is a time-of-check/time-of-use
   * window: the entry can be replaced by a symbolic link (pointing anywhere) or by
   * a different file. Reading from a validated handle closes that window for file
   * content: the identity (device + inode) and type are checked on the open
   * descriptor, not on the path, and the bytes come from the same descriptor.
   *
   * Reading is bounded: bytes are pulled in fixed chunks and the limits are
   * enforced on what was actually read, so a file that grows after the size check
   * cannot be read in full. The path is re-validated once more after the read, so
   * an entry swapped for a symbolic link (including on platforms without
   * `O_NOFOLLOW`) is caught before its bytes are ever hashed.
   */
  async #readVerifiedFile(
    absolutePath: string,
    relativePath: string,
    remainingBytes: number,
  ): Promise<Buffer> {
    const limits = this.#limits;
    // A file may not consume more than the per-file limit or what is left of the
    // total budget, whichever is smaller.
    const allowance = Math.min(limits.maxFileBytes, remainingBytes);

    if (allowance <= 0) {
      throw new DomainError(
        'scan_limit_exceeded',
        `Project exceeds the ${limits.maxTotalBytes}-byte total scan limit at ${relativePath}`,
      );
    }

    let discovered;
    try {
      discovered = await fs.lstat(absolutePath);
    } catch (error) {
      throw readFailure(error, relativePath, 'scan_entry_changed');
    }
    if (!discovered.isFile()) {
      throw new DomainError(
        'scan_entry_changed',
        `${relativePath} was a regular file when discovered and is no longer one; the ` +
          'project changed during the scan, import it again',
      );
    }
    if (discovered.size > allowance) {
      throw limitFailure(relativePath, discovered.size, limits);
    }

    if (this.#hooks.beforeRead !== undefined) {
      await this.#hooks.beforeRead(absolutePath, relativePath);
    }

    let handle: FileHandle;
    try {
      handle = await fs.open(absolutePath, fsConstants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ELOOP') {
        throw new DomainError(
          'scan_entry_changed',
          `${relativePath} became a symbolic link while scanning; symbolic links are never ` +
            'followed, import the project again',
        );
      }
      throw readFailure(error, relativePath, 'scan_entry_changed');
    }

    try {
      // Validate the descriptor, not the path: this object cannot be swapped out
      // from under us the way a path can.
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new DomainError(
          'scan_entry_changed',
          `${relativePath} is no longer a regular file; the project changed during the scan`,
        );
      }
      // Inode identity is unavailable on some platforms (reported as 0). When it
      // is available, a mismatch means the path was re-pointed at another file.
      const identityComparable = discovered.ino !== 0 && opened.ino !== 0;
      if (identityComparable && (discovered.ino !== opened.ino || discovered.dev !== opened.dev)) {
        throw new DomainError(
          'scan_entry_changed',
          `${relativePath} was replaced while scanning; import the project again`,
        );
      }
      if (opened.size > allowance) {
        throw limitFailure(relativePath, opened.size, limits);
      }

      if (this.#hooks.beforeReadBytes !== undefined) {
        await this.#hooks.beforeReadBytes(absolutePath, relativePath);
      }

      // Bounded streaming read. The limits are enforced on bytes actually read,
      // not on the size observed earlier, so growth during the read aborts the
      // scan instead of buffering an oversized file.
      const chunkSize = Math.min(READ_CHUNK_BYTES, allowance + 1);
      const chunk = Buffer.allocUnsafe(chunkSize);
      const chunks: Buffer[] = [];
      let total = 0;

      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) {
          break;
        }
        total += bytesRead;
        if (total > allowance) {
          throw limitFailure(relativePath, total, limits);
        }
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }

      if (total > limits.maxFileBytes) {
        throw limitFailure(relativePath, total, limits);
      }

      // Last check before hashing: the path must still name the very file whose
      // descriptor produced these bytes.
      await this.#assertEntryUnchanged(absolutePath, relativePath, opened.dev, opened.ino);

      return Buffer.concat(chunks, total);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Re-establish, after the read, that the path still names the file we read.
   *
   * This is the protection that survives where `O_NOFOLLOW` does not exist
   * (Windows): a substituted symbolic link is visible here as a link, and a
   * substituted file as a different device/inode. Either aborts the scan before
   * the bytes are hashed.
   */
  async #assertEntryUnchanged(
    absolutePath: string,
    relativePath: string,
    device: number,
    inode: number,
  ): Promise<void> {
    let current;
    try {
      current = await fs.lstat(absolutePath);
    } catch (error) {
      throw readFailure(error, relativePath, 'scan_entry_changed');
    }

    if (current.isSymbolicLink()) {
      throw new DomainError(
        'scan_entry_changed',
        `${relativePath} is now a symbolic link; symbolic links are never followed, ` +
          'import the project again',
      );
    }
    if (!current.isFile()) {
      throw new DomainError(
        'scan_entry_changed',
        `${relativePath} is no longer a regular file; the project changed during the scan`,
      );
    }

    const identityComparable = inode !== 0 && current.ino !== 0;
    if (identityComparable && (current.ino !== inode || current.dev !== device)) {
      throw new DomainError(
        'scan_entry_changed',
        `${relativePath} was replaced while scanning; import the project again`,
      );
    }
  }

  async scan(directoryPath: string): Promise<ProjectScan> {
    if (typeof directoryPath !== 'string' || directoryPath.trim() === '') {
      throw new DomainError('invalid_path', 'A project path is required');
    }

    // Resolve first (relative paths, `~` is the shell's job, not ours) and then
    // canonicalize the root, so two spellings of one directory share a location.
    const requested = path.resolve(directoryPath);
    let root: string;
    try {
      root = await fs.realpath(requested);
    } catch (error) {
      throw readFailure(error, requested);
    }

    let stats;
    try {
      stats = await fs.stat(root);
    } catch (error) {
      throw readFailure(error, root);
    }
    if (!stats.isDirectory()) {
      throw new DomainError('not_a_directory', `${root} is not a directory`);
    }

    const tree = await this.#collect(root);
    if (tree.files.length === 0) {
      throw new DomainError(
        'empty_project',
        `No files to import in ${root}: the directory is empty or contains only excluded entries`,
      );
    }

    const revision = asRevision(snapshotDigest(tree.files));
    const manifests = tree.files
      .map(manifestFor)
      .filter((manifest): manifest is DetectedManifest => manifest !== undefined);

    return {
      root,
      suggestedName: path.basename(root) || root,
      revision,
      fileCount: tree.files.length,
      totalBytes: tree.files.reduce((sum, file) => sum + file.size, 0),
      manifests,
      skipped: {
        symlinks: tree.symlinks,
        excludedDirectories: tree.excludedDirectories,
      },
    };
  }

  /**
   * Walk the tree without following symbolic links and without recursion, so a
   * deep tree cannot exhaust the call stack. Limits are checked before a file is
   * read, and any violation aborts the whole scan: a snapshot that silently
   * omits files would misrepresent the project.
   */
  async #collect(root: string): Promise<CollectedTree> {
    const limits = this.#limits;
    const files: ScannedFile[] = [];
    let symlinks = 0;
    let excludedDirectories = 0;
    let totalBytes = 0;

    const pendingDirectories: string[] = [''];

    while (pendingDirectories.length > 0) {
      const relativeDirectory = pendingDirectories.pop() as string;
      const absoluteDirectory =
        relativeDirectory === '' ? root : path.join(root, ...relativeDirectory.split('/'));

      // Confirm the directory is still a real directory immediately before
      // reading it. Node has no `openat`/`fdopendir`, so this narrows the window
      // without closing it; file contents are protected by `#readVerifiedFile`.
      const directoryLabel = relativeDirectory === '' ? root : relativeDirectory;
      let directoryStats;
      try {
        directoryStats = await fs.lstat(absoluteDirectory);
      } catch (error) {
        throw readFailure(error, directoryLabel, 'scan_entry_changed');
      }
      if (!directoryStats.isDirectory()) {
        throw new DomainError(
          'scan_entry_changed',
          `${directoryLabel} is no longer a directory; the project changed during the scan`,
        );
      }

      let entries;
      try {
        entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        throw readFailure(error, directoryLabel, 'scan_entry_changed');
      }

      entries.sort((left, right) => compareNames(left.name, right.name));

      for (const entry of entries) {
        const relativePath =
          relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;

        if (entry.isSymbolicLink()) {
          // Never followed: a link could point outside the project, loop, or
          // change between the scan and any later read.
          symlinks += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
            excludedDirectories += 1;
            continue;
          }
          pendingDirectories.push(relativePath);
          continue;
        }
        if (!entry.isFile()) {
          // Sockets, FIFOs and devices are not project content.
          continue;
        }

        const absolutePath = path.join(absoluteDirectory, entry.name);

        if (files.length >= limits.maxFiles) {
          throw new DomainError(
            'scan_limit_exceeded',
            `Project has more than the ${limits.maxFiles} files this import supports`,
          );
        }

        // Sizes and bytes come from an opened, validated descriptor, and the read
        // itself is capped by what is left of the total budget.
        const bytes = await this.#readVerifiedFile(
          absolutePath,
          relativePath,
          limits.maxTotalBytes - totalBytes,
        );

        totalBytes += bytes.byteLength;
        if (totalBytes > limits.maxTotalBytes) {
          throw new DomainError(
            'scan_limit_exceeded',
            `Project exceeds the ${limits.maxTotalBytes}-byte total scan limit`,
          );
        }

        files.push({ relPath: relativePath, size: bytes.byteLength, digest: sha256Hex(bytes) });
      }
    }

    files.sort((left, right) => compareNames(left.relPath, right.relPath));
    return { files, symlinks, excludedDirectories };
  }
}
