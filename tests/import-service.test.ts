import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  DomainError,
  FixedClock,
  InMemoryProjectRepository,
  LocalProjectScanner,
  ProjectImportService,
  SequentialIdGenerator,
} from '../src/index.ts';

async function makeTempDir(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-import-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeFile(root: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, 'utf8');
}

function buildService(projects = new InMemoryProjectRepository()): {
  service: ProjectImportService;
  projects: InMemoryProjectRepository;
} {
  return {
    projects,
    service: new ProjectImportService({
      projects,
      scanner: new LocalProjectScanner(),
      clock: new FixedClock(new Date('2026-02-02T00:00:00Z')),
      ids: new SequentialIdGenerator('proj'),
    }),
  };
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

describe('project import service', () => {
  it('imports a local project with its snapshot revision and manifests', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'package.json', '{"name":"demo"}\n');
    await writeFile(root, 'src/index.js', 'export const a = 1;\n');

    const { service, projects } = buildService();
    const result = await service.import({ path: root });

    assert.equal(result.created, true);
    assert.equal(result.project.id, 'proj-1');
    assert.equal(result.project.name, path.basename(root));
    assert.equal(result.project.source.kind, 'local');
    assert.equal(result.project.source.location, await fs.realpath(root));
    assert.equal(result.project.revision, result.scan.revision);
    assert.equal(result.project.dependencies.length, 1);
    assert.equal(result.project.dependencies[0]?.ecosystem, 'npm');
    assert.equal(result.project.createdAt.toISOString(), '2026-02-02T00:00:00.000Z');

    const stored = await projects.list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, 'proj-1');
  });

  it('treats an identical re-import as a no-op', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'readme.md', 'hello\n');

    const { service, projects } = buildService();
    const first = await service.import({ path: root });
    const second = await service.import({ path: root });

    assert.equal(second.created, false);
    assert.equal(second.project.id, first.project.id);
    assert.equal((await projects.list()).length, 1);
  });

  it('refuses to re-point a project whose contents changed', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'readme.md', 'hello\n');

    const { service } = buildService();
    await service.import({ path: root });
    await writeFile(root, 'readme.md', 'changed\n');

    await assert.rejects(service.import({ path: root }), isDomainError('project_changed'));
  });

  it('records a changed directory as a separate project when named explicitly', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'readme.md', 'hello\n');

    const { service, projects } = buildService();
    const first = await service.import({ path: root });
    await writeFile(root, 'readme.md', 'changed\n');
    const second = await service.import({ path: root, name: 'example-v2' });

    assert.equal(second.created, true);
    assert.notEqual(second.project.id, first.project.id);
    assert.notEqual(second.project.revision, first.project.revision);
    assert.equal((await projects.list()).length, 2);
  });

  it('uses an explicit name and keeps the directory path as the source', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'readme.md', 'hello\n');

    const { service } = buildService();
    const result = await service.import({ path: root, name: 'My Project' });

    assert.equal(result.project.name, 'My Project');
    assert.equal(result.project.source.location, await fs.realpath(root));
  });

  it('rejects renaming an existing identical snapshot', async (t) => {
    const root = await makeTempDir(t);
    await writeFile(root, 'readme.md', 'hello\n');

    const { service } = buildService();
    await service.import({ path: root });

    await assert.rejects(
      service.import({ path: root, name: 'another name' }),
      isDomainError('project_name_conflict'),
    );
  });

  it('creates independent projects for two directories with identical contents', async (t) => {
    const firstRoot = await makeTempDir(t);
    const secondRoot = await makeTempDir(t);
    await writeFile(firstRoot, 'readme.md', 'same\n');
    await writeFile(secondRoot, 'readme.md', 'same\n');

    const { service, projects } = buildService();
    const first = await service.import({ path: firstRoot });
    const second = await service.import({ path: secondRoot });

    assert.notEqual(first.project.id, second.project.id);
    assert.equal(first.project.revision, second.project.revision);
    assert.equal((await projects.list()).length, 2);
  });

  it('propagates scanner failures unchanged', async (t) => {
    const root = await makeTempDir(t);
    const { service } = buildService();

    await assert.rejects(
      service.import({ path: path.join(root, 'missing') }),
      isDomainError('path_not_found'),
    );
    await assert.rejects(service.import({ path: root }), isDomainError('empty_project'));
  });
});
