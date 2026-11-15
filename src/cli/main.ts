/**
 * VOLDBASE command-line interface (Phase 1).
 *
 * The CLI is a delivery adapter: it parses arguments, builds the adapters and
 * prints results. All policy lives in `ProjectImportService`, so the same use case
 * can be driven by a future HTTP server without changes.
 *
 * Exit codes: `0` success, `1` runtime failure (unreadable path, storage error),
 * `2` usage error (bad arguments). Scripts can therefore tell "you typed it
 * wrong" from "it did not work".
 */

import * as path from 'node:path';

import { ProjectImportService } from '../application/project-import-service.ts';
import type { Clock, IdGenerator, ProjectRepository, ProjectScanner } from '../application/ports.ts';
import { DomainError } from '../domain/errors.ts';
import { asProjectId } from '../domain/ids.ts';
import type { Project } from '../domain/project.ts';
import { JsonProjectRepository } from '../infrastructure/fs/json-project-repository.ts';
import { projectStorageFilePath, resolveVoldbaseHome } from '../infrastructure/fs/paths.ts';
import { LocalProjectScanner } from '../infrastructure/fs/scanner.ts';
import { RandomIdGenerator, SystemClock } from '../infrastructure/ids.ts';
import { describeRevision, field, formatBytes, formatDate, pad } from './render.ts';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** Line-oriented output sinks; the default runtime writes to the process streams. */
export interface CliStreams {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CliRuntime {
  /** Base directory for relative paths and for a relative `VOLDBASE_HOME`. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly streams: CliStreams;
  /** Overridable in tests for deterministic output. */
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
  readonly scanner?: ProjectScanner;
  readonly repository?: ProjectRepository;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = [
  'voldbase — local-first experiment & verification infrastructure',
  '',
  'Usage:',
  '  voldbase import <path> [--name "Project Name"]',
  '  voldbase list',
  '  voldbase show <project-id>',
  '  voldbase help',
  '',
  'Commands:',
  '  import   Scan a local project, record its snapshot and store it locally.',
  '  list     List imported projects.',
  '  show     Show one imported project in detail.',
  '',
  'Options:',
  '  --name <name>   Explicit project name (import only).',
  '',
  'Environment:',
  '  VOLDBASE_HOME   Storage root (default: ~/.voldbase).',
  '',
  'VOLDBASE never executes project code: importing reads and hashes files only.',
].join('\n');

interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string>;
}

function parseArguments(argv: readonly string[], allowedOptions: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (argument.startsWith('--')) {
      const separator = argument.indexOf('=');
      const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
      if (!allowedOptions.includes(name)) {
        throw new UsageError(`Unknown option '--${name}'`);
      }
      let value: string;
      if (separator !== -1) {
        value = argument.slice(separator + 1);
      } else {
        const next = argv[index + 1];
        if (next === undefined) {
          throw new UsageError(`Option '--${name}' needs a value`);
        }
        value = next;
        index += 1;
      }
      options.set(name, value);
      continue;
    }

    if (argument.startsWith('-') && argument !== '-') {
      throw new UsageError(`Unknown option '${argument}'`);
    }

    positionals.push(argument);
  }

  return { positionals, options };
}

interface Services {
  readonly importer: ProjectImportService;
  readonly projects: ProjectRepository;
  readonly home: string;
}

function buildServices(runtime: CliRuntime): Services {
  const home = resolveVoldbaseHome(runtime.env);
  const projects =
    runtime.repository ??
    new JsonProjectRepository({ filePath: projectStorageFilePath(home) });

  return {
    home,
    projects,
    importer: new ProjectImportService({
      projects,
      scanner: runtime.scanner ?? new LocalProjectScanner(),
      clock: runtime.clock ?? new SystemClock(),
      ids: runtime.ids ?? new RandomIdGenerator('proj'),
    }),
  };
}

function renderProject(project: Project, streams: CliStreams): void {
  streams.stdout(`Project ${project.id}`);
  streams.stdout(field('name', project.name));
  streams.stdout(field('source', `${project.source.kind} ${project.source.location}`));
  streams.stdout(field('revision', describeRevision(project.revision, 64)));
  streams.stdout(field('imported', project.createdAt.toISOString()));
  streams.stdout(field('manifests', String(project.dependencies.length)));
  for (const dependency of project.dependencies) {
    streams.stdout(
      `    ${pad(dependency.ecosystem, 10)}${pad(dependency.manifestPath, 28)}` +
        describeRevision(dependency.digest, 64),
    );
  }
}

async function runImport(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const { positionals, options } = parseArguments(argv, ['name']);
  if (positionals.length !== 1) {
    throw new UsageError('import needs exactly one directory path');
  }

  const requestedPath = positionals[0] as string;
  if (requestedPath.trim() === '') {
    throw new UsageError('import needs a non-empty directory path');
  }

  const explicitName = options.get('name');
  if (explicitName !== undefined && explicitName.trim() === '') {
    throw new UsageError('--name must not be empty');
  }

  const { importer } = buildServices(runtime);
  const result = await importer.import({
    path: path.resolve(runtime.cwd, requestedPath),
    ...(explicitName === undefined ? {} : { name: explicitName }),
  });

  const { project, scan } = result;
  if (!result.created) {
    runtime.streams.stdout(`Already imported: ${project.id} (snapshot unchanged)`);
    runtime.streams.stdout(field('name', project.name));
    runtime.streams.stdout(field('source', project.source.location));
    runtime.streams.stdout(field('revision', describeRevision(project.revision, 64)));
    return EXIT_OK;
  }

  runtime.streams.stdout(`Imported project ${project.id}`);
  runtime.streams.stdout(field('name', project.name));
  runtime.streams.stdout(field('source', project.source.location));
  runtime.streams.stdout(field('revision', describeRevision(project.revision, 64)));
  runtime.streams.stdout(field('files', `${scan.fileCount} (${formatBytes(scan.totalBytes)})`));
  runtime.streams.stdout(field('manifests', String(scan.manifests.length)));
  for (const manifest of scan.manifests) {
    runtime.streams.stdout(
      `    ${pad(manifest.ecosystem, 10)}${pad(manifest.manifestPath, 28)}` +
        describeRevision(manifest.digest),
    );
  }
  if (scan.skipped.symlinks > 0 || scan.skipped.excludedDirectories > 0) {
    runtime.streams.stdout(
      field(
        'skipped',
        `${scan.skipped.excludedDirectories} excluded directories, ` +
          `${scan.skipped.symlinks} symbolic links`,
      ),
    );
  }
  return EXIT_OK;
}

async function runList(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const { positionals } = parseArguments(argv, []);
  if (positionals.length !== 0) {
    throw new UsageError('list takes no arguments');
  }

  const { projects } = buildServices(runtime);
  const all = await projects.list();
  if (all.length === 0) {
    runtime.streams.stdout('No projects imported yet.');
    runtime.streams.stdout('  voldbase import <path>');
    return EXIT_OK;
  }

  const rows = all
    .slice()
    .sort((left, right) =>
      left.name === right.name
        ? left.id < right.id
          ? -1
          : 1
        : left.name < right.name
          ? -1
          : 1,
    );

  runtime.streams.stdout(
    `${pad('ID', 26)}${pad('NAME', 24)}${pad('REVISION', 22)}IMPORTED`,
  );
  for (const project of rows) {
    runtime.streams.stdout(
      `${pad(project.id, 26)}${pad(project.name, 24)}` +
        `${pad(describeRevision(project.revision), 22)}${formatDate(project.createdAt)}`,
    );
  }
  return EXIT_OK;
}

async function runShow(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const { positionals } = parseArguments(argv, []);
  if (positionals.length !== 1) {
    throw new UsageError('show needs exactly one project id');
  }

  const requestedId = positionals[0] as string;
  if (requestedId.trim() === '') {
    throw new UsageError('show needs a non-empty project id');
  }

  const { projects } = buildServices(runtime);
  const project = await projects.findById(asProjectId(requestedId));
  if (project === undefined) {
    runtime.streams.stderr(`error: no project with id '${requestedId}'`);
    runtime.streams.stderr('Run `voldbase list` to see imported projects.');
    return EXIT_FAILURE;
  }

  renderProject(project, runtime.streams);
  return EXIT_OK;
}

/**
 * Entry point. Returns the process exit code instead of calling `process.exit`,
 * so tests can exercise every command in-process.
 */
export async function main(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    runtime.streams.stdout(USAGE);
    return EXIT_OK;
  }

  try {
    switch (command) {
      case 'import': {
        return await runImport(rest, runtime);
      }
      case 'list': {
        return await runList(rest, runtime);
      }
      case 'show': {
        return await runShow(rest, runtime);
      }
      default: {
        throw new UsageError(`Unknown command '${command}'`);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      runtime.streams.stderr(`error: ${error.message}`);
      runtime.streams.stderr('Run `voldbase help` for usage.');
      return EXIT_USAGE;
    }
    if (error instanceof DomainError) {
      runtime.streams.stderr(`error: ${error.message}`);
      runtime.streams.stderr(`  code: ${error.code}`);
      return EXIT_FAILURE;
    }
    runtime.streams.stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
}

/** Build the real runtime (process cwd, environment and streams). */
export async function runCli(argv: readonly string[]): Promise<number> {
  return await main(argv, {
    cwd: process.cwd(),
    env: process.env,
    streams: {
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    },
  });
}
