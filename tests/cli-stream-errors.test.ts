/**
 * Regression tests for stdout/stderr stream failures in the *built* CLI.
 *
 * A downstream reader that stops early (`voldbase list | head`) closes the pipe;
 * Node reports the next write as EPIPE asynchronously, so it never reaches the
 * bin's `catch`. EPIPE is normal termination and must not abort the run or print
 * a stack trace, while every other stream error must still fail the process.
 *
 * The pipe is created, emptied of readers and handed to the child *before* it
 * starts, so the EPIPE path is guaranteed rather than raced against startup.
 *
 * Requires `npm run build` first; without `dist/` the tests are skipped rather
 * than silently passing.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, constants, existsSync, openSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const binPath = path.join(projectRoot, 'bin', 'voldbase.js');
const distAvailable = existsSync(path.join(projectRoot, 'dist', 'cli', 'main.js'));
const skip = distAvailable ? false : 'dist/ is missing; run `npm run build` first';
// Creates a FIFO to get a pipe whose read end can be closed before the child runs.
const posix = process.platform !== 'win32';

interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** Run the CLI with `stdout` connected to an already-open file descriptor. */
function runWithStdoutFd(args: readonly string[], stdoutFd: number): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: projectRoot,
      stdio: ['ignore', stdoutFd, 'pipe'],
    });
    // The child owns its copy; keeping ours open would keep the pipe alive.
    closeSync(stdoutFd);

    let stderr = '';
    const stderrStream = child.stderr;
    assert.ok(stderrStream, 'stderr must be a pipe');
    stderrStream.setEncoding('utf8');
    stderrStream.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

describe('built CLI stream handling', () => {
  it(
    'exits successfully when the downstream reader closes the pipe',
    { skip: skip || (posix ? false : 'closing a pipe before the child writes needs mkfifo') },
    async (t: TestContext) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-epipe-'));
      const fifo = path.join(directory, 'closed.pipe');
      t.after(async () => {
        await fs.rm(directory, { recursive: true, force: true });
      });

      execFileSync('mkfifo', [fifo], { stdio: 'ignore' });

      const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const writeFd = openSync(fifo, 'w');
      // With the read end closed, the first write in the child fails with EPIPE.
      closeSync(readFd);

      const result = await runWithStdoutFd(['help'], writeFd);

      assert.equal(result.signal, null);
      assert.equal(result.code, 0, `expected success, stderr was: ${result.stderr}`);
      assert.equal(result.stderr, '', 'a closed downstream consumer must not print anything');
    },
  );

  it(
    'still fails on an unrelated stream error',
    { skip: skip || (posix ? false : 'a read-only stdout descriptor is POSIX-only') },
    async () => {
      // stdout is a read-only descriptor: writes fail with EBADF, not EPIPE.
      const stdoutFd = openSync('/dev/null', 'r');
      const result = await runWithStdoutFd(['help'], stdoutFd);

      assert.equal(result.signal, null);
      assert.equal(result.code, 1, `expected failure, stderr was: ${result.stderr}`);
      assert.match(result.stderr, /^error: /m);
    },
  );
});
