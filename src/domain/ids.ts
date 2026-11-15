/**
 * Stable, typed identifiers.
 *
 * Branded string types keep `ProjectId` from being passed where a `RunId` is
 * expected. The brand exists only at the type level and disappears at runtime,
 * which keeps the sources erasable (see ADR-0002).
 */

import { DomainError } from './errors.ts';

declare const brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type ExperimentId = Brand<string, 'ExperimentId'>;
export type RunId = Brand<string, 'RunId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('invalid_identifier', `${field} must be a non-empty string`);
  }
  return value;
}

export function asProjectId(value: string): ProjectId {
  return requireNonEmpty(value, 'ProjectId') as ProjectId;
}

export function asExperimentId(value: string): ExperimentId {
  return requireNonEmpty(value, 'ExperimentId') as ExperimentId;
}

export function asRunId(value: string): RunId {
  return requireNonEmpty(value, 'RunId') as RunId;
}

export function asArtifactId(value: string): ArtifactId {
  return requireNonEmpty(value, 'ArtifactId') as ArtifactId;
}
