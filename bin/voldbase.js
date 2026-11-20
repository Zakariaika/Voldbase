#!/usr/bin/env node
/**
 * npm CLI entry point.
 *
 * Runs the compiled distribution (`npm run build`), never the TypeScript sources:
 * the published artifact must not depend on Node's type stripping.
 */
import { runCli } from '../dist/cli/main.js';

/**
 * Stream failures arrive asynchronously as `'error'` events, so a closed pipe
 * never reaches the `catch` below. EPIPE means the downstream reader went away
 * (for example `voldbase list | head -n 1`): that is normal termination, not a
 * CLI failure. Every other stream error is a real failure and must stay one.
 */
let streamFailed = false;

function onStreamError(error) {
  if (error?.code === 'EPIPE') {
    return;
  }
  streamFailed = true;
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`error: ${message}\n`);
  } catch {
    // stderr itself may be the failing stream; the exit code still reports it.
  }
}

process.stdout.on('error', onStreamError);
process.stderr.on('error', onStreamError);

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}

// The run may have succeeded while a stream failed alongside it.
if (streamFailed) {
  process.exitCode = 1;
}
