/**
 * Static analysis of JavaScript and TypeScript (Phase 2A).
 *
 * The analyzer is a **reader**, never a runner. It walks the imported project
 * with the same verified, bounded reader the importer uses, parses the text with
 * the TypeScript Compiler API, and reports what the syntax says. There is no
 * module resolution, no type checking, no `tsconfig` loading, no package
 * installation and no evaluation of project code.
 *
 * Parsing uses `ts.createProgram` over an in-memory compiler host: every file the
 * compiler can see is one we read ourselves and nothing else. The host's
 * `readFile`/`fileExists` answer only from that map, `noResolve` is set and
 * `noLib` keeps the compiler from reaching for a default library, so no path
 * outside the project is ever touched even by the parser.
 *
 * Snapshot integrity is enforced twice: the tree digest must equal the project's
 * recorded revision *before* parsing, and again *after* parsing. A project that
 * changes mid-analysis aborts instead of producing results pinned to the wrong
 * revision.
 *
 * What this deliberately does not do: infer types, resolve packages, claim that
 * an import is valid at runtime, or call anything a "vulnerability". Findings are
 * syntax-level observations with an explicit certainty.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import ts from 'typescript';

import type {
  AnalysisLimits,
  AnalyzerResult,
  ProjectAnalyzer,
} from '../../application/ports.ts';
import {
  ANALYZER_VERSION,
  type AnalysisLanguage,
  type AnalyzedFile,
  type Declaration,
  type Finding,
  type ImportEdge,
  type ImportResolution,
  type SourceLocation,
} from '../../domain/analysis.ts';
import { DomainError } from '../../domain/errors.ts';
import { sha256Hex } from '../../domain/integrity.ts';
import type { Project } from '../../domain/project.ts';
import { collectProjectTree, type ScannedFile } from './project-tree.ts';
import { readVerifiedBytes, type ReadHooks } from './safe-read.ts';
import { snapshotDigest } from './scanner.ts';

/** Source extensions this analyzer understands, with the language it reports. */
const SOURCE_LANGUAGES: ReadonlyMap<string, AnalysisLanguage> = new Map([
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
]);

/** Extension candidates tried when resolving a relative specifier. */
const RESOLUTION_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxSourceFiles: 5_000,
};

/** Stable rule ids. Never renumber; retire a rule instead. */
export const ANALYSIS_RULES = {
  syntaxDiagnostic: 'VB001',
  unresolvedRelativeImport: 'VB002',
  computedDynamicImport: 'VB003',
  importOutsideRoot: 'VB004',
} as const;

export interface StaticAnalyzerOptions {
  readonly limits?: Partial<AnalysisLimits>;
  /** Test seam; never set in production. */
  readonly hooks?: ReadHooks;
}

function languageOf(relativePath: string): AnalysisLanguage | undefined {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return SOURCE_LANGUAGES.get(extension);
}

export function isSupportedSourcePath(relativePath: string): boolean {
  return languageOf(relativePath) !== undefined;
}

/**
 * Classify a specifier without touching the filesystem: only names that match an
 * analysed file are reported as resolved.
 */
export function resolveImportSpecifier(
  specifier: string,
  fromPath: string,
  filePaths: ReadonlySet<string>,
): { readonly resolution: ImportResolution; readonly resolvedPath?: string } {
  if (!specifier.startsWith('.')) {
    // A package, a builtin or a path alias: names nothing we can see without
    // module resolution, so it is never claimed as resolved.
    return { resolution: 'external' };
  }

  const joined = path.posix.join(path.posix.dirname(fromPath), specifier);
  const normalized = path.posix.normalize(joined);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return { resolution: 'outside-root' };
  }

  const candidates = [normalized];
  for (const extension of RESOLUTION_EXTENSIONS) {
    candidates.push(`${normalized}${extension}`);
  }
  for (const extension of RESOLUTION_EXTENSIONS) {
    candidates.push(path.posix.join(normalized, `index${extension}`));
  }
  for (const candidate of candidates) {
    if (filePaths.has(candidate)) {
      return { resolution: 'resolved-relative', resolvedPath: candidate };
    }
  }
  return { resolution: 'unresolved-relative' };
}

function locationOf(sourceFile: ts.SourceFile, position: number): SourceLocation {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: line + 1, column: character + 1 };
}

/** Quote the parsed source at a position, bounded so evidence stays readable. */
function evidenceAt(sourceFile: ts.SourceFile, start: number, end: number): string {
  const text = sourceFile.text.slice(start, Math.min(end, start + 160));
  return text.replaceAll(/\s+/g, ' ').trim();
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && ts.isStringLiteralLike(node)) {
    return node.text;
  }
  return undefined;
}

interface FileExtraction {
  readonly declarations: Declaration[];
  readonly imports: ImportEdge[];
  readonly findings: Finding[];
}

/**
 * Walk one parsed file.
 *
 * Everything recorded here comes from the AST: names, kinds, locations, and the
 * specifiers exactly as written. No type is inferred and no binding is resolved.
 */
function extractFromSourceFile(
  sourceFile: ts.SourceFile,
  relativePath: string,
  filePaths: ReadonlySet<string>,
): FileExtraction {
  const declarations: Declaration[] = [];
  const imports: ImportEdge[] = [];
  const findings: Finding[] = [];

  const addDeclaration = (
    kind: Declaration['kind'],
    name: string,
    exported: boolean,
    position: number,
  ): void => {
    declarations.push({ kind, name, exported, location: locationOf(sourceFile, position) });
  };

  const addImport = (
    specifier: string,
    kind: ImportEdge['kind'],
    typeOnly: boolean,
    position: number,
  ): void => {
    const resolved = resolveImportSpecifier(specifier, relativePath, filePaths);
    imports.push({
      specifier,
      kind,
      typeOnly,
      resolution: resolved.resolution,
      ...(resolved.resolvedPath === undefined ? {} : { resolvedPath: resolved.resolvedPath }),
      location: locationOf(sourceFile, position),
    });

    if (resolved.resolution === 'unresolved-relative') {
      findings.push({
        ruleId: ANALYSIS_RULES.unresolvedRelativeImport,
        severity: 'warning',
        certainty: 'certain',
        path: relativePath,
        location: locationOf(sourceFile, position),
        message:
          'This relative import does not match any analysed file. It may be a build-time ' +
          'alias, a generated file, or a broken path; VOLDBASE does not resolve aliases or ' +
          'generated outputs.',
        evidence: specifier,
      });
    } else if (resolved.resolution === 'outside-root') {
      findings.push({
        ruleId: ANALYSIS_RULES.importOutsideRoot,
        severity: 'warning',
        certainty: 'certain',
        path: relativePath,
        location: locationOf(sourceFile, position),
        message:
          'This import points above the project root. Nothing outside the imported snapshot ' +
          'is analysed, so that file is invisible to this analysis.',
        evidence: specifier,
      });
    }
  };

  const visit = (node: ts.Node, insideClass: boolean): void => {
    if (ts.isFunctionDeclaration(node)) {
      addDeclaration(
        'function',
        node.name?.text ?? (hasExportModifier(node) ? 'default' : '<anonymous>'),
        hasExportModifier(node),
        node.getStart(sourceFile),
      );
    } else if (ts.isClassDeclaration(node)) {
      addDeclaration(
        'class',
        node.name?.text ?? (hasExportModifier(node) ? 'default' : '<anonymous>'),
        hasExportModifier(node),
        node.getStart(sourceFile),
      );
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
          const name = ts.isConstructorDeclaration(member)
            ? 'constructor'
            : member.name !== undefined && ts.isIdentifier(member.name)
              ? member.name.text
              : member.name !== undefined && ts.isStringLiteralLike(member.name)
                ? member.name.text
                : '<computed>';
          addDeclaration('method', name, false, member.getStart(sourceFile));
        } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
          const name = ts.isIdentifier(member.name) ? member.name.text : '<computed>';
          addDeclaration('method', name, false, member.getStart(sourceFile));
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      addDeclaration('interface', node.name.text, hasExportModifier(node), node.getStart(sourceFile));
    } else if (ts.isEnumDeclaration(node)) {
      addDeclaration('enum', node.name.text, hasExportModifier(node), node.getStart(sourceFile));
    } else if (ts.isTypeAliasDeclaration(node)) {
      addDeclaration(
        'type-alias',
        node.name.text,
        hasExportModifier(node),
        node.getStart(sourceFile),
      );
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const declaration of node.declarationList.declarations) {
        addDeclaration(
          'variable',
          ts.isIdentifier(declaration.name) ? declaration.name.text : '<pattern>',
          exported,
          declaration.getStart(sourceFile),
        );
      }
    } else if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralValue(node.moduleSpecifier);
      if (specifier !== undefined) {
        addImport(
          specifier,
          'static',
          node.importClause?.isTypeOnly ?? false,
          node.moduleSpecifier.getStart(sourceFile),
        );
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = stringLiteralValue(node.moduleReference.expression);
        if (specifier !== undefined) {
          addImport(specifier, 'require', false, node.moduleReference.getStart(sourceFile));
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        const specifier = stringLiteralValue(node.moduleSpecifier);
        if (specifier !== undefined) {
          addImport(
            specifier,
            'export-from',
            node.isTypeOnly,
            node.moduleSpecifier.getStart(sourceFile),
          );
        }
      } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          addDeclaration('export', element.name.text, true, element.getStart(sourceFile));
        }
      }
    } else if (ts.isExportAssignment(node)) {
      addDeclaration('export', 'default', true, node.getStart(sourceFile));
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const argument = node.arguments[0];
        const specifier = stringLiteralValue(argument);
        if (specifier !== undefined) {
          addImport(specifier, isDynamicImport ? 'dynamic' : 'require', false, argument!.getStart(sourceFile));
        } else if (isDynamicImport) {
          findings.push({
            ruleId: ANALYSIS_RULES.computedDynamicImport,
            severity: 'info',
            certainty: 'conditional',
            path: relativePath,
            location: locationOf(sourceFile, node.getStart(sourceFile)),
            message:
              'This dynamic import computes its specifier at runtime, so its target cannot be ' +
              'determined statically. It is recorded as a limit of this analysis, not as a fault.',
            evidence: evidenceAt(sourceFile, node.getStart(sourceFile), node.getEnd()),
          });
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, insideClass || ts.isClassDeclaration(node)));
  };

  visit(sourceFile, false);
  return { declarations, imports, findings };
}

function syntaxFindings(
  sourceFile: ts.SourceFile,
  relativePath: string,
  diagnostics: readonly ts.Diagnostic[],
): Finding[] {
  return diagnostics.map((diagnostic) => {
    const start = diagnostic.start ?? 0;
    const end = start + (diagnostic.length ?? 0);
    return {
      ruleId: ANALYSIS_RULES.syntaxDiagnostic,
      // A parse error means the file could not be read as declared source. It is
      // reported as an error about our reading, never as a claim about behaviour.
      severity: 'error',
      certainty: 'certain',
      path: relativePath,
      location: locationOf(sourceFile, start),
      message: `The parser could not read this file: ${ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        ' ',
      )}`,
      evidence: evidenceAt(sourceFile, start, Math.max(end, start + 1)),
    };
  });
}

/** One in-memory compiler host: the parser sees only text we already read. */
function createInMemoryProgram(entries: readonly { path: string; text: string }[]): ts.Program {
  const texts = new Map(entries.map((entry) => [entry.path, entry.text]));
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    jsx: ts.JsxEmit.Preserve,
    types: [],
  };

  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersion) {
      const text = texts.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, false);
    },
    getDefaultLibFileName: () => '/__voldbase__/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/__voldbase__',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    // The parser may only see the files we parsed ourselves.
    fileExists: (fileName) => texts.has(fileName),
    readFile: (fileName) => texts.get(fileName),
    directoryExists: (directory) => directory === '/__voldbase__',
    getDirectories: () => [],
  };

  return ts.createProgram({ rootNames: entries.map((entry) => entry.path), options, host });
}

function decodeSource(relativePath: string, bytes: Buffer): string {
  // A NUL byte in a file that claims to be source is not source. Parsing it would
  // produce meaningless diagnostics, so the analysis refuses instead.
  if (bytes.includes(0)) {
    throw new DomainError(
      'analysis_unsupported_source',
      `${relativePath} contains binary data (NUL bytes) but has a source extension; ` +
        'VOLDBASE does not parse binary files',
    );
  }
  return bytes.toString('utf8');
}

/**
 * Static analyzer for JavaScript and TypeScript.
 *
 * @throws DomainError `analysis_revision_mismatch` when the project directory no
 * longer matches the imported revision (before or after parsing),
 * `analysis_source_changed` when a file changes while it is being read,
 * `analysis_unsupported_source` when a "source" file is binary or the project has
 * no supported source at all, `analysis_unsupported_project` for non-local
 * sources and `analysis_limit_exceeded` when a bound is hit.
 */
export class TypeScriptStaticAnalyzer implements ProjectAnalyzer {
  readonly version = ANALYZER_VERSION;
  readonly #limits: AnalysisLimits;
  readonly #hooks: ReadHooks;

  constructor(options: StaticAnalyzerOptions = {}) {
    this.#limits = { ...DEFAULT_ANALYSIS_LIMITS, ...options.limits };
    this.#hooks = options.hooks ?? {};
  }

  async analyze(project: Project, limits: Partial<AnalysisLimits> = {}): Promise<AnalyzerResult> {
    const bounds: AnalysisLimits = { ...this.#limits, ...limits };

    if (project.source.kind !== 'local') {
      throw new DomainError(
        'analysis_unsupported_project',
        `Project ${project.id} was imported from ${project.source.kind}:${project.source.location}. ` +
          'Phase 2A analyses local imports only; a remote source is never fetched.',
      );
    }

    // The imported location is the canonical path recorded at import time. If it
    // no longer resolves to itself, the directory was moved or replaced and the
    // revision cannot be verified against the snapshot.
    let root: string;
    try {
      root = await fs.realpath(project.source.location);
    } catch (error) {
      throw new DomainError(
        'analysis_revision_mismatch',
        `Cannot resolve ${project.source.location} for project ${project.id}: ` +
          `${error instanceof Error ? error.message : String(error)}. Import the project again.`,
      );
    }
    if (root !== project.source.location) {
      throw new DomainError(
        'analysis_revision_mismatch',
        `${project.source.location} now resolves to ${root}; the imported snapshot was taken ` +
          'from a different location. Import the project again.',
      );
    }

    const before = await this.#walk(root, bounds);

    // Snapshot integrity, before anything is parsed: the tree on disk must still
    // be the revision the project recorded. Otherwise the analysis would describe
    // code the project does not claim to be.
    if (snapshotDigest(before.files) !== project.revision) {
      throw new DomainError(
        'analysis_revision_mismatch',
        `${root} no longer matches revision ${project.revision} recorded for project ` +
          `${project.id}; the project changed after it was imported. Import it again ` +
          '(with --name if you want to keep both versions) and analyse the new snapshot.',
      );
    }

    const sourceFiles = before.files.filter((file) => isSupportedSourcePath(file.relPath));
    if (sourceFiles.length === 0) {
      throw new DomainError(
        'analysis_unsupported_source',
        `Project ${project.id} contains no JavaScript or TypeScript source ` +
          `(${[...SOURCE_LANGUAGES.keys()].join(', ')}); nothing to analyse.`,
      );
    }
    if (sourceFiles.length > bounds.maxSourceFiles) {
      throw new DomainError(
        'analysis_limit_exceeded',
        `Project ${project.id} has ${sourceFiles.length} source files, above the ` +
          `${bounds.maxSourceFiles}-file analysis limit`,
      );
    }

    const filePaths = new Set(before.files.map((file) => file.relPath));
    const parsed: { path: string; text: string; bytes: Buffer; scanned: ScannedFile }[] = [];

    for (const scanned of sourceFiles) {
      const absolutePath = path.join(root, ...scanned.relPath.split('/'));
      const bytes = await readVerifiedBytes(absolutePath, scanned.relPath, {
        // An empty file is valid source with size 0; the verified reader rejects
        // an allowance of 0, so ask for at least one byte of headroom.
        allowance: Math.min(bounds.maxFileBytes, Math.max(scanned.size, 1)),
        limits: bounds,
        hooks: this.#hooks,
        changedCode: 'analysis_source_changed',
      });
      // The bytes we parse must be exactly the bytes the tree digest covered.
      if (bytes.byteLength !== scanned.size || sha256Hex(bytes) !== scanned.digest) {
        throw new DomainError(
          'analysis_source_changed',
          `${scanned.relPath} changed between snapshot verification and parsing; ` +
            'aborting instead of analysing a different revision',
        );
      }
      parsed.push({
        path: scanned.relPath,
        text: decodeSource(scanned.relPath, bytes),
        bytes,
        scanned,
      });
    }

    const program = createInMemoryProgram(parsed);
    const files: AnalyzedFile[] = [];
    const findings: Finding[] = [];

    for (const entry of parsed) {
      const sourceFile = program.getSourceFile(entry.path);
      if (sourceFile === undefined) {
        throw new DomainError(
          'analysis_parser_failure',
          `The parser could not load ${entry.path} from the in-memory host`,
        );
      }
      const extraction = extractFromSourceFile(sourceFile, entry.path, filePaths);
      findings.push(
        ...extraction.findings,
        ...syntaxFindings(sourceFile, entry.path, program.getSyntacticDiagnostics(sourceFile)),
      );
      files.push({
        path: entry.path,
        language: languageOf(entry.path) as AnalysisLanguage,
        size: entry.bytes.byteLength,
        digest: entry.scanned.digest,
        declarations: extraction.declarations,
        imports: extraction.imports,
      });
    }

    // The snapshot must still be the same snapshot once parsing is done: results
    // derived from a tree that changed under us would be pinned to the wrong
    // revision.
    const after = await this.#walk(root, bounds);
    if (snapshotDigest(after.files) !== project.revision) {
      throw new DomainError(
        'analysis_revision_mismatch',
        `Project ${project.id} changed while it was being analysed; the results would not ` +
          `describe revision ${project.revision}. Import the project again and re-run the analysis.`,
      );
    }

    return {
      analyzerVersion: this.version,
      settings: {
        supportedExtensions: [...SOURCE_LANGUAGES.keys()].sort(),
        maxFiles: bounds.maxFiles,
        maxTotalBytes: bounds.maxTotalBytes,
        maxFileBytes: bounds.maxFileBytes,
        maxSourceFiles: bounds.maxSourceFiles,
      },
      files,
      findings,
    };
  }

  /**
   * Walk the project and require that the tree still matches the imported
   * revision. Reading happens through the shared verified reader.
   */
  async #walk(root: string, bounds: AnalysisLimits): Promise<{ files: readonly ScannedFile[] }> {
    const tree = await collectProjectTree(root, bounds, this.#hooks, 'analysis_source_changed');
    return { files: tree.files };
  }
}
