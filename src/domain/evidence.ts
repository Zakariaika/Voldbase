/**
 * Evidence references (ADR-0006).
 *
 * Evidence is content-addressed: the digest is the identity, so artifacts can
 * be deduplicated and corruption detected without trusting the store.
 */

import { DomainError, invariant } from './errors.ts';
import { isSha256Hex } from './integrity.ts';
import type { ArtifactId } from './ids.ts';

export interface EvidenceRef {
  readonly artifactId: ArtifactId;
  /** Lowercase hex SHA-256 of the artifact bytes. */
  readonly sha256: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly description?: string;
}

export interface EvidenceInput {
  artifactId: ArtifactId;
  sha256: string;
  mediaType: string;
  bytes: number;
  description?: string;
}

export function createEvidenceRef(input: EvidenceInput): EvidenceRef {
  if (!isSha256Hex(input.sha256)) {
    throw new DomainError(
      'invalid_evidence_digest',
      'Evidence digest must be 64 lowercase hex characters (SHA-256)',
    );
  }
  invariant(
    Number.isInteger(input.bytes) && input.bytes >= 0,
    'invalid_evidence_size',
    'Evidence size must be a non-negative integer',
  );
  invariant(
    input.mediaType.trim() !== '',
    'invalid_evidence_media_type',
    'Evidence media type must be a non-empty string',
  );

  return {
    artifactId: input.artifactId,
    sha256: input.sha256,
    mediaType: input.mediaType,
    bytes: input.bytes,
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}
