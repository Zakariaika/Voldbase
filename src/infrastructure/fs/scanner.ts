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

import { promises as fs } from 'node:fs';
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

function readFailure(error: unknown, subject: string): DomainError {
  const code = errorCode(error);
  if (code === 'ENOENT') {
    return new DomainError('path_not_found', `${subject} does not exist`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new DomainError('path_unreadable', `${subject} is not readable (permission denied)`);
  }
  if (code === 'ENOTDIR') {
    return new DomainError('not_a_directory', `${subject} is not a directory`);
  }
  return new DomainError('path_unreadable', `Cannot read ${subject}: ${describeFailure(error)}`);
}

/** Sort by UTF-16 code unit so ordering never depends on locale. */
function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

  constructor(limits: Partial<ScannerLimits> = {}) {
    this.#limits = { ...DEFAULT_SCANNER_LIMITS, ...limits };
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

      let entries;
      try {
        entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        throw readFailure(error, relativeDirectory === '' ? root : relativeDirectory);
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

        let size: number;
        try {
          size = (await fs.lstat(absolutePath)).size;
        } catch (error) {
          throw readFailure(error, relativePath);
        }
        if (size > limits.maxFileBytes) {
          throw new DomainError(
            'file_too_large',
            `${relativePath} is ${size} bytes, above the ${limits.maxFileBytes}-byte ` +
              'per-file limit',
          );
        }
        if (files.length >= limits.maxFiles) {
          throw new DomainError(
            'scan_limit_exceeded',
            `Project has more than the ${limits.maxFiles} files this import supports`,
          );
        }
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) {
          throw new DomainError(
            'scan_limit_exceeded',
            `Project exceeds the ${limits.maxTotalBytes}-byte total scan limit`,
          );
        }

        let bytes: Buffer;
        try {
          bytes = await fs.readFile(absolutePath);
        } catch (error) {
          throw readFailure(error, relativePath);
        }

        files.push({ relPath: relativePath, size: bytes.byteLength, digest: sha256Hex(bytes) });
      }
    }

    files.sort((left, right) => compareNames(left.relPath, right.relPath));
    return { files, symlinks, excludedDirectories };
  }
}
