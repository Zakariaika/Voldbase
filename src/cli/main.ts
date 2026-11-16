/**
 * VOLDBASE command-line interface (Phase 1, extended in Phases 2A and 2B).
 *
 * The CLI is a delivery adapter: it parses arguments, builds the adapters and
 * prints results. All policy lives in the services, so the same use cases can be
 * driven by a future HTTP server without changes.
 *
 * Exit codes: `0` success, `1` runtime failure (unreadable path, storage error),
 * `2` usage error (bad arguments). Scripts can therefore tell "you typed it
 * wrong" from "it did not work".
 */

import * as path from 'node:path';

import { ArchitectureService } from '../application/architecture-service.ts';
import type { BuildArchitectureOptions } from '../application/architecture-builder.ts';
import { ProjectAnalysisService } from '../application/analyze-project-service.ts';
import { ProjectImportService } from '../application/project-import-service.ts';
import type {
  AnalysisRepository,
  Clock,
  IdGenerator,
  ProjectAnalyzer,
  ProjectRepository,
  ProjectScanner,
} from '../application/ports.ts';
import type { AnalysisSnapshot } from '../domain/analysis.ts';
import type { ArchitectureFinding, ArchitectureSnapshot } from '../domain/architecture.ts';
import { DomainError } from '../domain/errors.ts';
import { canonicalize } from '../domain/integrity.ts';
import { asAnalysisId, asProjectId } from '../domain/ids.ts';
import type { Project } from '../domain/project.ts';
import { JsonAnalysisRepository } from '../infrastructure/fs/json-analysis-repository.ts';
import { JsonProjectRepository } from '../infrastructure/fs/json-project-repository.ts';
import {
  analysisStorageFilePath,
  projectStorageFilePath,
  resolveVoldbaseHome,
} from '../infrastructure/fs/paths.ts';
import { LocalProjectScanner } from '../infrastructure/fs/scanner.ts';
import { TypeScriptStaticAnalyzer } from '../infrastructure/fs/typescript-analyzer.ts';
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
  readonly analyses?: AnalysisRepository;
  readonly analyzer?: ProjectAnalyzer;
  /** Separate from `ids` so analysis ids cannot collide with project ids. */
  readonly analysisIds?: IdGenerator;
  /** Bounds and heuristic thresholds for the architecture derivation. */
  readonly architecture?: BuildArchitectureOptions;
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
  '  voldbase analyze <project-id>',
  '  voldbase analysis <analysis-id>',
  '  voldbase architecture <analysis-id> [--format text|json]',
  '  voldbase help',
  '',
  'Commands:',
  '  import     Scan a local project, record its snapshot and store it locally.',
  '  list       List imported projects.',
  '  show       Show one imported project in detail.',
  '  analyze    Statically analyse an imported project snapshot (no execution).',
  '  analysis   Show a stored analysis: summary, files and findings.',
  '  architecture  Derive file and module dependencies from a stored analysis.',
  '',
  'Options:',
  '  --name <name>       Explicit project name (import only).',
  '  --format <format>   Output format for architecture: text (default) or json.',
  '',
  'Environment:',
  '  VOLDBASE_HOME   Storage root (default: ~/.voldbase).',
  '',
  'VOLDBASE never executes project code: importing reads and hashes files, and',
  'analysis parses them. Neither installs, builds nor runs anything.',
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
  readonly analysisService: ProjectAnalysisService;
  readonly architectureService: ArchitectureService;
  readonly projects: ProjectRepository;
  readonly analyses: AnalysisRepository;
  readonly home: string;
}

function buildServices(runtime: CliRuntime): Services {
  const home = resolveVoldbaseHome(runtime.env);
  const clock = runtime.clock ?? new SystemClock();
  const projects =
    runtime.repository ??
    new JsonProjectRepository({ filePath: projectStorageFilePath(home) });
  const analyses =
    runtime.analyses ??
    new JsonAnalysisRepository({ filePath: analysisStorageFilePath(home) });

  return {
    home,
    projects,
    analyses,
    importer: new ProjectImportService({
      projects,
      scanner: runtime.scanner ?? new LocalProjectScanner(),
      clock,
      ids: runtime.ids ?? new RandomIdGenerator('proj'),
    }),
    analysisService: new ProjectAnalysisService({
      projects,
      analyses,
      analyzer: runtime.analyzer ?? new TypeScriptStaticAnalyzer(),
      clock,
      ids: runtime.analysisIds ?? new RandomIdGenerator('ana'),
    }),
    architectureService: new ArchitectureService({ analyses }),
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

function renderAnalysisSummary(snapshot: AnalysisSnapshot, streams: CliStreams): void {
  const { summary } = snapshot;
  streams.stdout(field('project', String(snapshot.projectId)));
  streams.stdout(field('revision', describeRevision(snapshot.projectRevision, 64)));
  streams.stdout(field('analyzer', snapshot.analyzerVersion));
  streams.stdout(field('analysed', snapshot.createdAt.toISOString()));
  streams.stdout(
    field(
      'source',
      `${summary.sourceFileCount} files` +
        (summary.languages.length === 0 ? '' : ` (${summary.languages.join(', ')})`),
    ),
  );
  streams.stdout(field('declarations', String(summary.declarationCount)));
  streams.stdout(
    field('imports', `${summary.importCount} (${summary.resolvedImportCount} resolved)`),
  );
  streams.stdout(
    field(
      'findings',
      `${summary.findingCount} (` +
        `${summary.findingsBySeverity.error} error, ` +
        `${summary.findingsBySeverity.warning} warning, ` +
        `${summary.findingsBySeverity.info} info)`,
    ),
  );
  streams.stdout(field('digest', describeRevision(snapshot.digest, 64)));
}

async function runAnalyze(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const { positionals } = parseArguments(argv, []);
  if (positionals.length !== 1) {
    throw new UsageError('analyze needs exactly one project id');
  }
  const requestedId = positionals[0] as string;
  if (requestedId.trim() === '') {
    throw new UsageError('analyze needs a non-empty project id');
  }

  const { analysisService } = buildServices(runtime);
  const { project, analysis } = await analysisService.analyze({ projectId: requestedId });

  runtime.streams.stdout(`Analysed project ${project.id} (${project.name})`);
  renderAnalysisSummary(analysis, runtime.streams);
  // A quiet result is a reading, not a clearance: say so every time.
  runtime.streams.stdout(
    '  Note: syntax-level analysis only. No findings does not mean the code is safe.',
  );
  runtime.streams.stdout(`  voldbase analysis ${analysis.analysisId}   # findings in detail`);
  return EXIT_OK;
}

async function runAnalysis(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const { positionals } = parseArguments(argv, []);
  if (positionals.length !== 1) {
    throw new UsageError('analysis needs exactly one analysis id');
  }
  const requestedId = positionals[0] as string;
  if (requestedId.trim() === '') {
    throw new UsageError('analysis needs a non-empty analysis id');
  }

  const { analyses } = buildServices(runtime);
  const snapshot = await analyses.findById(asAnalysisId(requestedId));
  if (snapshot === undefined) {
    runtime.streams.stderr(`error: no analysis with id '${requestedId}'`);
    runtime.streams.stderr('Run `voldbase analyze <project-id>` to create one.');
    return EXIT_FAILURE;
  }

  runtime.streams.stdout(`Analysis ${snapshot.analysisId}`);
  renderAnalysisSummary(snapshot, runtime.streams);

  if (snapshot.findings.length === 0) {
    runtime.streams.stdout('');
    runtime.streams.stdout('No syntax-level findings.');
    runtime.streams.stdout(
      '  This is not a statement that the project is correct, safe or secure.',
    );
    return EXIT_OK;
  }

  runtime.streams.stdout('');
  runtime.streams.stdout(
    `${pad('SEVERITY', 10)}${pad('RULE', 8)}${pad('LOCATION', 44)}EXPLANATION`,
  );
  for (const finding of snapshot.findings) {
    const location =
      finding.location === undefined
        ? finding.path
        : `${finding.path}:${finding.location.line}:${finding.location.column}`;
    runtime.streams.stdout(
      `${pad(finding.severity.toUpperCase(), 10)}${pad(finding.ruleId, 8)}${pad(location, 44)}` +
        finding.message,
    );
    if (finding.evidence !== '') {
      runtime.streams.stdout(`          evidence: ${finding.evidence}`);
    }
  }
  runtime.streams.stdout('');
  runtime.streams.stdout(
    'Syntax-level observations only: they describe what the parser saw, not runtime behaviour.',
  );
  return EXIT_OK;
}

/** Rows the text report shows per section before pointing at `--format json`. */
const REPORT_ROW_LIMIT = 20;
const REPORT_FINDING_LIMIT = 30;
const REPORT_EVIDENCE_LIMIT = 5;

function describeSubject(finding: ArchitectureFinding): string {
  const firstNode = finding.nodes[0];
  if (firstNode !== undefined) {
    return finding.nodes.length > 1 ? `${firstNode} (+${finding.nodes.length - 1})` : firstNode;
  }
  const [firstModule, secondModule] = finding.modules;
  if (firstModule === undefined) {
    return '-';
  }
  return secondModule === undefined ? `module ${firstModule}` : `${firstModule} -> ${secondModule}`;
}

function renderArchitectureReport(
  analysis: AnalysisSnapshot,
  snapshot: ArchitectureSnapshot,
  streams: CliStreams,
): void {
  const { metrics, summary } = snapshot;
  streams.stdout(`Architecture of analysis ${snapshot.analysisId}`);
  streams.stdout(field('project', String(snapshot.projectId)));
  streams.stdout(field('revision', describeRevision(snapshot.projectRevision, 64)));
  streams.stdout(field('analysis', describeRevision(snapshot.analysisDigest, 64)));
  streams.stdout(field('engine', `${snapshot.engineVersion} (schema ${snapshot.schemaVersion})`));
  streams.stdout(field('files', String(metrics.nodeCount)));
  streams.stdout(
    field('graph', `${metrics.edgeCount} edges, ${metrics.internalImportCount} imports merged`),
  );
  streams.stdout(field('modules', String(metrics.moduleCount)));
  streams.stdout(
    field('cycles', `${metrics.cycleCount} (largest ${metrics.largestCycleSize})`),
  );
  streams.stdout(
    field(
      'isolated',
      `${metrics.isolatedFileCount} files, ${metrics.isolatedModuleCount} modules`,
    ),
  );
  streams.stdout(field('fan-in/out', `max ${metrics.maxFanIn} / ${metrics.maxFanOut}`));
  streams.stdout(
    field(
      'findings',
      `${summary.findingCount} (` +
        `${summary.findingsBySeverity.error} error, ` +
        `${summary.findingsBySeverity.warning} warning, ` +
        `${summary.findingsBySeverity.info} info)`,
    ),
  );
  streams.stdout(field('digest', describeRevision(snapshot.digest, 64)));

  // Modules: most connected first, so a reader sees the shape of the project.
  streams.stdout('');
  streams.stdout(`MODULES (${snapshot.modules.length})`);
  if (snapshot.modules.length > 0) {
    streams.stdout(
      `${pad('ID', 34)}${pad('FILES', 7)}${pad('FAN-IN', 8)}${pad('FAN-OUT', 9)}ISOLATED`,
    );
  }
  const modules = [...snapshot.modules]
    .sort(
      (left, right) =>
        right.fanIn + right.fanOut - (left.fanIn + left.fanOut) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .slice(0, REPORT_ROW_LIMIT);
  for (const module of modules) {
    streams.stdout(
      `${pad(module.id, 34)}${pad(String(module.files.length), 7)}` +
        `${pad(String(module.fanIn), 8)}${pad(String(module.fanOut), 9)}` +
        `${module.isolated ? 'yes' : 'no'}`,
    );
  }
  if (snapshot.modules.length > modules.length) {
    streams.stdout(`  … ${snapshot.modules.length - modules.length} more modules (--format json)`);
  }

  streams.stdout('');
  streams.stdout(`CYCLES (${snapshot.cycles.length})`);
  if (snapshot.cycles.length === 0) {
    streams.stdout('  No circular dependencies between analysed files.');
  }
  for (const cycle of snapshot.cycles.slice(0, REPORT_ROW_LIMIT)) {
    const label = cycle.selfLoop ? 'self' : `${cycle.nodes.length} files`;
    streams.stdout(`  ${pad(label, 10)}${cycle.nodes.join(' -> ')}`);
  }
  if (snapshot.cycles.length > REPORT_ROW_LIMIT) {
    streams.stdout(`  … ${snapshot.cycles.length - REPORT_ROW_LIMIT} more cycles (--format json)`);
  }

  streams.stdout('');
  streams.stdout(`FINDINGS (${snapshot.findings.length})`);
  if (snapshot.findings.length === 0) {
    streams.stdout('  No structural observations.');
  } else {
    streams.stdout(
      `${pad('SEVERITY', 10)}${pad('RULE', 7)}${pad('CERTAINTY', 13)}` +
        `${pad('SUBJECT', 34)}EXPLANATION`,
    );
  }
  for (const finding of snapshot.findings.slice(0, REPORT_FINDING_LIMIT)) {
    streams.stdout(
      `${pad(finding.severity.toUpperCase(), 10)}${pad(finding.ruleId, 7)}` +
        `${pad(finding.certainty, 13)}${pad(describeSubject(finding), 34)}${finding.message}`,
    );
    for (const ref of finding.evidence.slice(0, REPORT_EVIDENCE_LIMIT)) {
      streams.stdout(`          evidence: ${ref.from} -> ${ref.to}`);
    }
    if (finding.evidence.length > REPORT_EVIDENCE_LIMIT) {
      streams.stdout(
        `          … ${finding.evidence.length - REPORT_EVIDENCE_LIMIT} more edges of evidence`,
      );
    }
  }
  if (snapshot.findings.length > REPORT_FINDING_LIMIT) {
    streams.stdout(
      `  … ${snapshot.findings.length - REPORT_FINDING_LIMIT} more findings (--format json)`,
    );
  }

  streams.stdout('');
  streams.stdout(
    'Static structural intelligence only: derived from syntax-level imports in analysis ' +
      `${analysis.analysisId}.`,
  );
  streams.stdout(
    'It describes the dependency graph; it does not verify runtime behaviour, correctness or security.',
  );
}

async function runArchitecture(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const { positionals, options } = parseArguments(argv, ['format']);
  if (positionals.length !== 1) {
    throw new UsageError('architecture needs exactly one analysis id');
  }
  const requestedId = positionals[0] as string;
  if (requestedId.trim() === '') {
    throw new UsageError('architecture needs a non-empty analysis id');
  }

  const format = options.get('format') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    throw new UsageError(`--format must be 'text' or 'json', received '${format}'`);
  }

  const { architectureService } = buildServices(runtime);
  const { analysis, architecture } = await architectureService.build({
    analysisId: requestedId,
    ...(runtime.architecture === undefined ? {} : { limits: runtime.architecture.limits }),
    ...(runtime.architecture === undefined ? {} : { thresholds: runtime.architecture.thresholds }),
  });

  if (format === 'json') {
    // Canonical JSON: keys sorted, no timestamps, no ids invented here, so two
    // runs over the same analysis produce byte-identical output.
    runtime.streams.stdout(JSON.stringify(JSON.parse(canonicalize(architecture)), null, 2));
    return EXIT_OK;
  }

  renderArchitectureReport(analysis, architecture, runtime.streams);
  return EXIT_OK;
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
      case 'analyze': {
        return await runAnalyze(rest, runtime);
      }
      case 'analysis': {
        return await runAnalysis(rest, runtime);
      }
      case 'architecture': {
        return await runArchitecture(rest, runtime);
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
