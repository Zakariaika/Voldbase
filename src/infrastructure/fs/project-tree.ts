/**
 * Deterministic, read-only walk of a project directory (ADR-0012, ADR-0014).
 *
 * Extracted from the Phase 1 scanner so the import scanner and the Phase 2A
 * analyzer traverse a project the same way. The rules are deliberate:
 *
 * - symbolic links are counted and skipped, never followed, so a link cannot
 *   point outside the project, loop, or resolve differently later;
 * - excluded directories are never traversed;
 * - only regular files are collected;
 * - the walk is iterative, so a deep tree cannot exhaust the call stack;
 * - any limit violation aborts the whole walk instead of returning a partial
 *   tree — a snapshot that silently omitted files would misrepresent the project;
 * - every file is read through {@link readVerifiedBytes}, so what is hashed is
 *   the file that was discovered, not whatever the path points at later.
 *
 * Nothing here executes, installs or writes anything.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { DomainError } from '../../domain/errors.ts';
import { sha256Hex } from '../../domain/integrity.ts';
import {
  readFailure,
  readVerifiedBytes,
  type ChangedCode,
  type ReadHooks,
} from './safe-read.ts';

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

export interface TreeLimits {
  /** Maximum number of regular files in one snapshot. */
  readonly maxFiles: number;
  /** Maximum total bytes of file contents in one snapshot. */
  readonly maxTotalBytes: number;
  /** Maximum size of a single file; larger files abort the walk. */
  readonly maxFileBytes: number;
}

export interface ScannedFile {
  readonly relPath: string;
  readonly size: number;
  readonly digest: string;
}

export interface CollectedTree {
  readonly files: readonly ScannedFile[];
  readonly symlinks: number;
  readonly excludedDirectories: number;
  readonly totalBytes: number;
}

/** Sort by UTF-16 code unit so ordering never depends on locale. */
function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Walk a project root.
 *
 * `root` must already be canonical (the caller resolves it with `realpath`), so
 * relative paths can never be built by traversing outside it.
 */
export async function collectProjectTree(
  root: string,
  limits: TreeLimits,
  hooks: ReadHooks = {},
  changedCode: ChangedCode = 'scan_entry_changed',
): Promise<CollectedTree> {
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
    // without closing it; file contents are protected by `readVerifiedBytes`.
    const directoryLabel = relativeDirectory === '' ? root : relativeDirectory;
    let directoryStats;
    try {
      directoryStats = await fs.lstat(absoluteDirectory);
    } catch (error) {
      throw readFailure(error, directoryLabel, changedCode);
    }
    if (!directoryStats.isDirectory()) {
      throw new DomainError(
        changedCode,
        `${directoryLabel} is no longer a directory; the project changed during the scan`,
      );
    }

    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      throw readFailure(error, directoryLabel, changedCode);
    }

    entries.sort((left, right) => compareNames(left.name, right.name));

    for (const entry of entries) {
      const relativePath =
        relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        // Never followed: a link could point outside the project, loop, or
        // change between the walk and any later read.
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
      const bytes = await readVerifiedBytes(absolutePath, relativePath, {
        allowance: limits.maxTotalBytes - totalBytes,
        limits,
        hooks,
        changedCode,
      });

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
  return { files, symlinks, excludedDirectories, totalBytes };
}
