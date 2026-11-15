/**
 * The result taxonomy (ADR-0001).
 *
 * This is a closed set. It is a const tuple rather than an enum so that the
 * values survive JSON round-trips unchanged and the source stays erasable.
 */

export const RESULT_STATUSES = [
  'PASS',
  'FAIL',
  'INCONCLUSIVE',
  'NOT_TESTED',
  'BLOCKED',
] as const;

export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** Human-readable intent, used by reports and documentation. */
export const RESULT_STATUS_DESCRIPTIONS: Readonly<Record<ResultStatus, string>> = {
  PASS: 'Ran under the recorded conditions; every stated expectation was met.',
  FAIL: 'Ran; at least one stated expectation was not met.',
  INCONCLUSIVE: 'Ran; the observations do not support a definitive verdict.',
  NOT_TESTED: 'No execution was attempted.',
  BLOCKED: 'Execution was attempted but could not proceed.',
};

/** Statuses that assert something happened and must be backed by evidence. */
export const EVIDENCE_REQUIRED_STATUSES: readonly ResultStatus[] = ['PASS', 'FAIL'];

export function isResultStatus(value: unknown): value is ResultStatus {
  return (
    typeof value === 'string' && (RESULT_STATUSES as readonly string[]).includes(value)
  );
}

export function requiresEvidence(status: ResultStatus): boolean {
  return EVIDENCE_REQUIRED_STATUSES.includes(status);
}
