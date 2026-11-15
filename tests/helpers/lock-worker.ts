/**
 * Child-process workers for the lock mutual-exclusion tests (ADR-0015).
 *
 * Each worker is a real OS process, so the lock is exercised across processes
 * rather than between two objects in one event loop.
 *
 * Modes:
 *   write <storePath> <id> <markerPath> <holdMs>
 *       Acquire the lock, enter a detector-guarded critical section, append the id
 *       to the JSON array in <storePath>, leave. Exit code 3 means another process
 *       was inside the critical section at the same time.
 *   hold <storePath> <readyPath> <releasePath>
 *       Acquire the lock, announce readiness, hold until <releasePath> exists,
 *       then release.
 *   deadlock <storePath>
 *       Acquire the lock and exit without releasing it, so its owner is provably
 *       dead afterwards.
 */

import { promises as fs } from 'node:fs';

import { acquireFileLock } from '../../src/infrastructure/fs/file-lock.ts';

const [mode, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function readArray(storePath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(storePath, 'utf8'));
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

async function appendToStore(storePath: string, id: string): Promise<void> {
  const current = await readArray(storePath);
  current.push(id);
  const temporary = `${storePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(current)}\n`, 'utf8');
  await fs.rename(temporary, storePath);
}

if (mode === 'write') {
  const [storePath, id, markerPath, holdText] = rest;
  if (storePath === undefined || id === undefined || markerPath === undefined || holdText === undefined) {
    fail('usage: write <storePath> <id> <markerPath> <holdMs>');
  }
  const holdMs = Number(holdText);
  const lock = await acquireFileLock(`${storePath}.lock`, { timeoutMs: 20_000, pollIntervalMs: 5 });

  try {
    // Atomic detector: if this cannot be created, two writers are inside.
    try {
      await fs.writeFile(markerPath, `${process.pid}\n`, { flag: 'wx' });
    } catch {
      process.stderr.write('CONCURRENT_ENTRY\n');
      process.exit(3);
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await appendToStore(storePath, id);
    } finally {
      await fs.rm(markerPath, { force: true });
    }
  } finally {
    await lock.release();
  }
  process.exit(0);
}

if (mode === 'hold') {
  const [storePath, readyPath, releasePath] = rest;
  if (storePath === undefined || readyPath === undefined || releasePath === undefined) {
    fail('usage: hold <storePath> <readyPath> <releasePath>');
  }
  const lock = await acquireFileLock(`${storePath}.lock`, { timeoutMs: 20_000, pollIntervalMs: 5 });
  await fs.writeFile(readyPath, `${process.pid}\n`, 'utf8');

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fs.stat(releasePath);
      break;
    } catch {
      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  await lock.release();
  process.exit(0);
}

if (mode === 'deadlock') {
  const [storePath] = rest;
  if (storePath === undefined) {
    fail('usage: deadlock <storePath>');
  }
  // Deliberately no release: the lock outlives this process.
  await acquireFileLock(`${storePath}.lock`, { timeoutMs: 20_000, pollIntervalMs: 5 });
  process.exit(0);
}

fail(`unknown mode: ${mode ?? '(none)'}`);
