/**
 * Domain errors.
 *
 * Domain code never throws bare strings or framework errors: every violation
 * carries a stable machine-readable `code` so that callers (CLI, API, tests)
 * can branch without parsing messages.
 */

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) {
    throw new DomainError(code, message);
  }
}
