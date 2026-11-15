/**
 * Canonical serialization and hashing (ADR-0006).
 *
 * The same logical value must hash identically on every machine, so objects are
 * serialized with sorted keys and without `undefined` entries.
 */

import { createHash } from 'node:crypto';

import { DomainError } from './errors.ts';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, arrays
 * kept in order. Non-JSON values (functions, symbols, bigint) are rejected
 * rather than silently coerced.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DomainError('non_canonical_value', 'Cannot canonicalize non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const member = source[key];
      if (member === undefined) {
        continue;
      }
      result[key] = toJsonValue(member);
    }
    return result;
  }
  throw new DomainError(
    'non_canonical_value',
    `Cannot canonicalize value of type ${typeof value}`,
  );
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/** Hash of any value's canonical serialization. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
