/**
 * Plain-text rendering for the CLI.
 *
 * Deliberately dependency-free: fixed-width columns and ASCII separators. Output
 * is line-oriented so it stays readable when piped into a file or a log.
 */

/** Human-readable byte count with binary units. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return `${bytes} B`;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Describe a revision. Snapshot imports always produce a SHA-256 digest; a
 * 40-character value can only be a Git commit SHA.
 */
export function describeRevision(revision: string, length = 12): string {
  const algorithm = revision.length === 40 ? 'git' : 'sha256';
  const short = revision.slice(0, length);
  return `${algorithm}:${short}${revision.length > length ? '…' : ''}`;
}

export function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width, ' ');
}

/** `YYYY-MM-DD` in UTC, so output does not depend on the machine's timezone. */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A labelled line: `  name        value`. */
export function field(label: string, value: string, indent = '  ', width = 12): string {
  return `${indent}${pad(label, width)}${value}`;
}
