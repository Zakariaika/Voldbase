/**
 * Shared fixtures for the Phase 2A analysis tests.
 *
 * Tests build a real temporary project, import it with the Phase 1 scanner (so
 * the revision is the genuine snapshot digest), then analyse it. Nothing is
 * stubbed: the analyzer reads real files through the real reader.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';

import {
  asProjectId,
  createProject,
  LocalProjectScanner,
  TypeScriptStaticAnalyzer,
  type AnalyzerResult,
  type Project,
  type StaticAnalyzerOptions,
} from '../../src/index.ts';

export async function makeTempDir(t: TestContext, prefix = 'voldbase-2a-'): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

export async function writeFiles(
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

/** Import a directory the way the CLI does, producing a real project snapshot. */
export async function importProject(root: string, name = 'demo'): Promise<Project> {
  const scan = await new LocalProjectScanner().scan(root);
  return createProject({
    id: asProjectId(`proj_${name}`),
    name,
    source: { kind: 'local', location: scan.root },
    revision: scan.revision,
    dependencies: scan.manifests,
    createdAt: new Date('2026-04-01T00:00:00Z'),
  });
}

export async function analyzeProject(
  project: Project,
  options: StaticAnalyzerOptions = {},
): Promise<AnalyzerResult> {
  return await new TypeScriptStaticAnalyzer(options).analyze(project);
}

/** Convenience: write files, import and analyse in one call. */
export async function analyzeFiles(
  t: TestContext,
  files: Readonly<Record<string, string | Uint8Array>>,
  options: StaticAnalyzerOptions = {},
): Promise<{ root: string; project: Project; result: AnalyzerResult }> {
  const root = await makeTempDir(t);
  await writeFiles(root, files);
  const project = await importProject(root);
  const result = await analyzeProject(project, options);
  return { root, project, result };
}

export function fileByPath(result: AnalyzerResult, relativePath: string) {
  const file = result.files.find((candidate) => candidate.path === relativePath);
  if (file === undefined) {
    throw new Error(`no analysed file ${relativePath}; saw ${result.files.map((f) => f.path).join(', ')}`);
  }
  return file;
}

export function findingsFor(result: AnalyzerResult, ruleId: string) {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}
