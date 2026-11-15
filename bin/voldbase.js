#!/usr/bin/env node
/**
 * npm CLI entry point.
 *
 * Runs the compiled distribution (`npm run build`), never the TypeScript sources:
 * the published artifact must not depend on Node's type stripping.
 */
import { runCli } from '../dist/cli/main.js';

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
