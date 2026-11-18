/**
 * Local storage locations (ADR-0004, ADR-0009).
 *
 * All paths are resolved here, in infrastructure, so no other layer needs to know
 * where data lives. `VOLDBASE_HOME` exists mainly so tests (and users with a
 * different disk layout) can keep state out of the real home directory.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { DomainError } from '../../domain/errors.ts';
import { ANALYSES_FILE_NAME } from './analysis-storage-schema.ts';
import {
  EXPERIMENTS_FILE_NAME,
  RUNS_FILE_NAME,
} from './experiment-run-storage-schema.ts';
import { STORAGE_FILE_NAME } from './storage-schema.ts';

/** Environment variables this build reads. Nothing else is inspected. */
export const HOME_ENV_VAR = 'VOLDBASE_HOME';

/**
 * Resolve the VOLDBASE home directory.
 *
 * Precedence: `VOLDBASE_HOME` (absolute, relative to the process cwd, or `~/…`)
 * then `~/.voldbase`. The result is always absolute.
 */
export function resolveVoldbaseHome(
  env: Readonly<Record<string, string | undefined>>,
  homedir: string = os.homedir(),
): string {
  const configured = env[HOME_ENV_VAR]?.trim();

  if (configured === undefined || configured === '') {
    return path.join(homedir, '.voldbase');
  }
  if (configured === '~') {
    return path.resolve(homedir);
  }
  if (configured.startsWith('~/')) {
    return path.resolve(homedir, configured.slice(2));
  }
  if (configured.startsWith('~')) {
    throw new DomainError(
      'invalid_home',
      `VOLDBASE_HOME must be an absolute path or start with '~/', received '${configured}'`,
    );
  }
  return path.resolve(configured);
}

/** Path of the project store inside a VOLDBASE home directory. */
export function projectStorageFilePath(home: string): string {
  return path.join(home, STORAGE_FILE_NAME);
}

/**
 * Path of the analysis store inside a VOLDBASE home directory.
 *
 * Analyses live in their own document: they are derived records that can be
 * regenerated, and a corrupted analysis file must never affect project data.
 */
export function analysisStorageFilePath(home: string): string {
  return path.join(home, ANALYSES_FILE_NAME);
}

/**
 * Path of the experiment store inside a VOLDBASE home directory.
 *
 * Experiments live in their own document: an editable definition must never be
 * able to damage project, analysis or run data.
 */
export function experimentStorageFilePath(home: string): string {
  return path.join(home, EXPERIMENTS_FILE_NAME);
}

/**
 * Path of the run store inside a VOLDBASE home directory.
 *
 * Run history is append-only and terminal records are immutable, so it is kept
 * apart from the editable experiment definitions it refers to.
 */
export function runStorageFilePath(home: string): string {
  return path.join(home, RUNS_FILE_NAME);
}
