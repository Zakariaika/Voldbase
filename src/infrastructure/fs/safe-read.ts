/**
 * Verified, bounded file reading (ADR-0014, extended in Phase 2A).
 *
 * Extracted from the Phase 1 scanner so the analyzer cannot accidentally
 * implement a weaker reader than the one that was reviewed. Both callers get:
 *
 * - `lstat` first, so a symbolic link is never opened;
 * - `O_NOFOLLOW` where the platform has it, so a swap to a link fails at the
 *   open instead of being followed;
 * - descriptor validation (`fstat`): still a regular file, same device + inode as
 *   what was discovered, within the allowance;
 * - a bounded streaming read, with limits enforced on bytes actually read, so a
 *   file that grows cannot be buffered in full;
 * - a post-read `lstat` proving the path still names the file whose bytes we hold
 *   (the protection that survives on Windows).
 *
 * Everything here is read-only. Nothing is executed, nothing is written, and no
 * path outside the caller-supplied absolute path is touched.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import { DomainError } from '../../domain/errors.ts';

/**
 * `O_NOFOLLOW` makes `open()` fail with `ELOOP` instead of following a symbolic
 * link. It exists on POSIX platforms; on Windows the constant is absent, so the
 * flag degrades to plain `O_RDONLY` and the post-read path check is what detects
 * the substitution (ADR-0014).
 */
const O_NOFOLLOW: number =
  typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/** Size of the buffer used to read a file in bounded chunks. */
export const READ_CHUNK_BYTES = 64 * 1024;

/** Test/instrumentation seam; never used by production code. */
export interface ReadHooks {
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

export interface ReadLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

/** Error code used when an entry changed *after* it was discovered. */
export type ChangedCode =
  | 'scan_entry_changed'
  | 'analysis_source_changed'
  | 'analysis_revision_mismatch';

export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Translate a filesystem error into a domain error.
 *
 * `changedCode` is used when the error happens *after* an entry was discovered:
 * a file that vanished mid-read is not a missing-path argument error, it is a
 * project that changed underneath us, and it must be reported as such.
 */
export function readFailure(
  error: unknown,
  subject: string,
  changedCode?: ChangedCode,
): DomainError {
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

/**
 * Turn an over-budget read into the right error: a single file over the per-file
 * limit is `file_too_large`; anything else that exhausts the total budget is
 * `scan_limit_exceeded`. Both abort the operation.
 */
export function limitFailure(
  relativePath: string,
  bytes: number,
  limits: ReadLimits,
): DomainError {
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

/**
 * Re-establish, after the read, that the path still names the file we read.
 *
 * A substituted symbolic link is visible here as a link, and a substituted file
 * as a different device/inode. Either aborts before the bytes are used.
 */
export async function assertEntryUnchanged(
  absolutePath: string,
  relativePath: string,
  device: number,
  inode: number,
  changedCode: ChangedCode = 'scan_entry_changed',
): Promise<void> {
  let current;
  try {
    current = await fs.lstat(absolutePath);
  } catch (error) {
    throw readFailure(error, relativePath, changedCode);
  }

  if (current.isSymbolicLink()) {
    throw new DomainError(
      changedCode,
      `${relativePath} is now a symbolic link; symbolic links are never followed, import the ` +
        'project again',
    );
  }
  if (!current.isFile()) {
    throw new DomainError(
      changedCode,
      `${relativePath} is no longer a regular file; the project changed during the scan`,
    );
  }

  const identityComparable = inode !== 0 && current.ino !== 0;
  if (identityComparable && (current.ino !== inode || current.dev !== device)) {
    throw new DomainError(
      changedCode,
      `${relativePath} was replaced while reading; the project changed, import it again`,
    );
  }
}

export interface ReadVerifiedOptions {
  /** Bytes this file may consume: `min(remaining total budget, per-file limit)`. */
  readonly allowance: number;
  readonly limits: ReadLimits;
  readonly hooks?: ReadHooks;
  readonly changedCode?: ChangedCode;
}

/**
 * Read one file, proving it is still the same regular file that was discovered.
 *
 * Returns the bytes read from the validated descriptor. Throws (never returns a
 * partial buffer) on any limit violation or identity change.
 */
export async function readVerifiedBytes(
  absolutePath: string,
  relativePath: string,
  options: ReadVerifiedOptions,
): Promise<Buffer> {
  const { limits, hooks } = options;
  const changedCode: ChangedCode = options.changedCode ?? 'scan_entry_changed';
  const allowance = options.allowance;

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
    throw readFailure(error, relativePath, changedCode);
  }
  if (!discovered.isFile()) {
    throw new DomainError(
      changedCode,
      `${relativePath} was a regular file when discovered and is no longer one; the ` +
        'project changed during the scan, import it again',
    );
  }
  if (discovered.size > allowance) {
    throw limitFailure(relativePath, discovered.size, limits);
  }

  if (hooks?.beforeRead !== undefined) {
    await hooks.beforeRead(absolutePath, relativePath);
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ELOOP') {
      throw new DomainError(
        changedCode,
        `${relativePath} became a symbolic link while scanning; symbolic links are never ` +
          'followed, import the project again',
      );
    }
    throw readFailure(error, relativePath, changedCode);
  }

  try {
    // Validate the descriptor, not the path: this object cannot be swapped out
    // from under us the way a path can.
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new DomainError(
        changedCode,
        `${relativePath} is no longer a regular file; the project changed during the scan`,
      );
    }
    // Inode identity is unavailable on some platforms (reported as 0). When it is
    // available, a mismatch means the path was re-pointed at another file.
    const identityComparable = discovered.ino !== 0 && opened.ino !== 0;
    if (identityComparable && (discovered.ino !== opened.ino || discovered.dev !== opened.dev)) {
      throw new DomainError(
        changedCode,
        `${relativePath} was replaced while scanning; import the project again`,
      );
    }
    if (opened.size > allowance) {
      throw limitFailure(relativePath, opened.size, limits);
    }

    if (hooks?.beforeReadBytes !== undefined) {
      await hooks.beforeReadBytes(absolutePath, relativePath);
    }

    // Bounded streaming read. The limits are enforced on bytes actually read,
    // not on the size observed earlier, so growth during the read aborts instead
    // of buffering an oversized file.
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

    // Last check before the caller uses the bytes: the path must still name the
    // very file whose descriptor produced them.
    await assertEntryUnchanged(absolutePath, relativePath, opened.dev, opened.ino, changedCode);

    return Buffer.concat(chunks, total);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
