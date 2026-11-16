/**
 * Read-only local project scanner (Phase 1).
 *
 * The snapshot digest covers the *contents* of the imported tree, not the Git
 * HEAD: a project imported from a dirty working tree is described by what is on
 * disk. The scan is deterministic — same bytes, same ordering, same digest —
 * because the canonical manifest sorts every entry.
 *
 * It performs no execution and installs nothing: files are opened for reading,
 * hashed, and closed. Traversal and verified reads live in `project-tree.ts` and
 * `safe-read.ts` (shared with the Phase 2A analyzer), so both agree on exactly
 * what "the project" is and how it may be read.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { DetectedManifest, ProjectScan, ProjectScanner } from '../../application/ports.ts';
import { DomainError } from '../../domain/errors.ts';
import { sha256Hex } from '../../domain/integrity.ts';
import { asRevision } from '../../domain/revision.ts';
import {
  collectProjectTree,
  EXCLUDED_DIRECTORY_NAMES,
  type ScannedFile,
  type TreeLimits,
} from './project-tree.ts';
import { readFailure, type ReadHooks } from './safe-read.ts';

export { EXCLUDED_DIRECTORY_NAMES };

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

/** Test/instrumentation seam; never used by production code. */
export type ScannerHooks = ReadHooks;

export type ScannerLimits = TreeLimits;

export const DEFAULT_SCANNER_LIMITS: ScannerLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
};

export type { ScannedFile };

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

    const tree = await collectProjectTree(root, this.#limits, this.#hooks);
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
}
