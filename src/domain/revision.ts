/**
 * Revision identifiers.
 *
 * A revision is the exact thing a verification result is about, so it must be
 * an immutable identifier — never a ref that can move, and never an
 * arbitrary string that merely looks hash-like.
 *
 * Accepted forms:
 * - `git-sha1`: a full 40-character lowercase hexadecimal Git commit SHA.
 * - `sha256`:   a 64-character lowercase hexadecimal content digest.
 *
 * Abbreviated SHAs are rejected on purpose: `9a3f1c2` is ambiguous, and an
 * ambiguous revision cannot anchor evidence. Uppercase hex is rejected rather
 * than normalized, so two spellings can never compare unequal.
 */

import { DomainError } from './errors.ts';

declare const revisionBrand: unique symbol;

/** A validated, immutable revision identifier. */
export type RevisionId = string & { readonly [revisionBrand]: 'RevisionId' };

export type RevisionKind = 'git-sha1' | 'sha256';

const GIT_SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Refs that can move. A snapshot must never be pinned to one of these. */
const FLOATING_REFS = new Set(['head', 'main', 'master', 'latest', 'trunk', 'develop']);

export function isFloatingRevision(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    FLOATING_REFS.has(normalized) ||
    normalized.startsWith('refs/heads/') ||
    normalized.startsWith('refs/tags/') ||
    normalized === ''
  );
}

/** Classify a revision by the identifier format it uses, if it is valid. */
export function revisionKind(value: string): RevisionKind | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (GIT_SHA1_PATTERN.test(value)) {
    return 'git-sha1';
  }
  if (SHA256_PATTERN.test(value)) {
    return 'sha256';
  }
  return undefined;
}

export function isRevision(value: unknown): value is RevisionId {
  return typeof value === 'string' && revisionKind(value) !== undefined;
}

/**
 * Validate and brand a revision.
 *
 * Distinguishes three failure modes because callers act on them differently:
 * a floating ref is a usage mistake, an empty value is missing input, and a
 * malformed identifier is a bad import.
 */
export function asRevision(value: string): RevisionId {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('invalid_revision', 'Revision must be a non-empty string');
  }
  if (isFloatingRevision(value)) {
    throw new DomainError(
      'unpinned_revision',
      `Revision must be pinned to an immutable identifier, received '${value}'`,
    );
  }
  if (revisionKind(value) === undefined) {
    throw new DomainError(
      'invalid_revision',
      'Revision must be a full 40-character Git commit SHA or a 64-character ' +
        `SHA-256 digest (lowercase hex), received '${value}'`,
    );
  }
  return value as RevisionId;
}
