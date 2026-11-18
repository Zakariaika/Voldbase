/**
 * RunService rejection paths with durable storage (Phase 2C.3).
 *
 * `RunService` refuses to create a run when the referenced project or experiment
 * is missing, or when the experiment belongs to a different project. Those
 * guards were only tested against the in-memory adapters. Here they run against
 * the real JSON repositories on a temporary directory, and every refusal is
 * checked for its second obligation: a rejected command must not write anything.
 *
 * Nothing is stubbed, no executor runs and no project code is executed.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  asExperimentId,
  asProjectId,
  createExperiment,
  createProject,
  DomainError,
  experimentStorageFilePath,
  FixedClock,
  JsonExperimentRepository,
  JsonProjectRepository,
  JsonRunRepository,
  projectStorageFilePath,
  RunService,
  runStorageFilePath,
  SequentialIdGenerator,
  type EnvironmentManifest,
  type Experiment,
  type Project,
} from '../src/index.ts';

const ENVIRONMENT: EnvironmentManifest = {
  os: 'linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: '22.18.0',
};

const LOCK_OPTIONS = { timeoutMs: 2_000, pollIntervalMs: 10, staleMs: 5_000 };

interface DurableRuntime {
  readonly home: string;
  readonly project: Project;
  readonly experiment: Experiment;
  readonly projects: JsonProjectRepository;
  readonly experiments: JsonExperimentRepository;
  readonly runs: JsonRunRepository;
  readonly service: RunService;
}

async function makeHome(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2c3-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function openRepositories(home: string): {
  projects: JsonProjectRepository;
  experiments: JsonExperimentRepository;
  runs: JsonRunRepository;
} {
  return {
    projects: new JsonProjectRepository({
      filePath: projectStorageFilePath(home),
      lock: LOCK_OPTIONS,
    }),
    experiments: new JsonExperimentRepository({
      filePath: experimentStorageFilePath(home),
      lock: LOCK_OPTIONS,
    }),
    runs: new JsonRunRepository({
      filePath: runStorageFilePath(home),
      lock: LOCK_OPTIONS,
    }),
  };
}

function buildProject(id: string, name: string): Project {
  return createProject({
    id: asProjectId(id),
    name,
    source: { kind: 'github', location: `https://github.com/example/${name}` },
    revision: 'a'.repeat(40),
    createdAt: new Date('2026-07-01T00:00:00Z'),
  });
}

function buildExperiment(id: string, projectId: string): Experiment {
  return createExperiment({
    id: asExperimentId(id),
    projectId: asProjectId(projectId),
    name: 'suite passes',
    hypothesis: 'npm test exits 0',
    steps: [{ index: 0, description: 'run the test suite', command: 'npm test' }],
    determinism: 'deterministic',
    expectedObservations: ['exit code 0'],
    createdAt: new Date('2026-07-01T00:00:00Z'),
  });
}

/** A durable runtime seeded with one project and one experiment owned by it. */
async function seed(t: TestContext): Promise<DurableRuntime> {
  const home = await makeHome(t);
  const repositories = openRepositories(home);
  const project = buildProject('proj-a', 'project-a');
  const experiment = buildExperiment('exp-a', project.id);
  await repositories.projects.save(project);
  await repositories.experiments.save(experiment);

  const service = new RunService({
    projects: repositories.projects,
    experiments: repositories.experiments,
    runs: repositories.runs,
    clock: new FixedClock(new Date('2026-07-01T00:00:00Z')),
    ids: new SequentialIdGenerator('run'),
  });

  return { home, project, experiment, ...repositories, service };
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

/** Bytes of both record documents, for an before/after comparison. */
async function storedDocuments(home: string): Promise<{
  projects: string;
  experiments: string;
}> {
  return {
    projects: await fs.readFile(projectStorageFilePath(home), 'utf8'),
    experiments: await fs.readFile(experimentStorageFilePath(home), 'utf8'),
  };
}

/** No run document exists, so no rejected command leaked a record into storage. */
async function assertNoRunDocument(home: string): Promise<void> {
  await assert.rejects(() => fs.readFile(runStorageFilePath(home), 'utf8'), /ENOENT/);
  assert.deepEqual((await fs.readdir(home)).sort(), ['experiments.json', 'projects.json']);
}

describe('RunService rejections with durable storage', () => {
  it('rejects a run for a project that does not exist without writing a run', async (t) => {
    const runtime = await seed(t);
    const before = await storedDocuments(runtime.home);

    await assert.rejects(
      () =>
        runtime.service.createRun({
          projectId: asProjectId('proj-missing'),
          experimentId: runtime.experiment.id,
          environment: ENVIRONMENT,
        }),
      isDomainError('project_not_found'),
    );

    await assertNoRunDocument(runtime.home);
    assert.deepEqual(await storedDocuments(runtime.home), before);

    // The seeded records are still intact and readable through a new instance.
    const reopened = openRepositories(runtime.home);
    assert.equal((await reopened.projects.findById(asProjectId('proj-a')))?.name, 'project-a');
    assert.equal(
      (await reopened.experiments.findById(asExperimentId('exp-a')))?.name,
      'suite passes',
    );
  });

  it('rejects a run for an experiment that does not exist without writing a run', async (t) => {
    const runtime = await seed(t);
    const before = await storedDocuments(runtime.home);

    await assert.rejects(
      () =>
        runtime.service.createRun({
          projectId: runtime.project.id,
          experimentId: 'exp-missing',
          environment: ENVIRONMENT,
        }),
      isDomainError('experiment_not_found'),
    );

    await assertNoRunDocument(runtime.home);
    assert.deepEqual(await storedDocuments(runtime.home), before);

    const reopened = openRepositories(runtime.home);
    assert.equal((await reopened.projects.findById(asProjectId('proj-a')))?.name, 'project-a');
    assert.equal(
      (await reopened.experiments.findById(asExperimentId('exp-a')))?.name,
      'suite passes',
    );
  });

  it('rejects a run whose experiment belongs to another project', async (t) => {
    const runtime = await seed(t);

    // Both records are valid; only their relationship is wrong.
    const otherProject = buildProject('proj-b', 'project-b');
    const foreignExperiment = buildExperiment('exp-b', otherProject.id);
    await runtime.projects.save(otherProject);
    await runtime.experiments.save(foreignExperiment);

    const before = await storedDocuments(runtime.home);

    await assert.rejects(
      () =>
        runtime.service.createRun({
          projectId: runtime.project.id,
          experimentId: foreignExperiment.id,
          environment: ENVIRONMENT,
        }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === 'experiment_project_mismatch' &&
        /does not belong to project/.test(error.message),
    );

    await assertNoRunDocument(runtime.home);
    assert.deepEqual(await storedDocuments(runtime.home), before);

    const reopened = openRepositories(runtime.home);
    assert.equal(
      (await reopened.experiments.findById(asExperimentId('exp-b')))?.projectId,
      otherProject.id,
    );
    assert.equal(
      (await reopened.experiments.findById(asExperimentId('exp-a')))?.projectId,
      runtime.project.id,
    );
  });

  it('leaves an existing run record untouched when a creation is rejected', async (t) => {
    const runtime = await seed(t);

    // A legitimate run already exists in the same document.
    const existing = await runtime.service.createRun({
      projectId: runtime.project.id,
      experimentId: runtime.experiment.id,
      environment: ENVIRONMENT,
    });
    const runsPath = runStorageFilePath(runtime.home);
    const before = await fs.readFile(runsPath, 'utf8');

    await assert.rejects(
      () =>
        runtime.service.createRun({
          projectId: asProjectId('proj-missing'),
          experimentId: runtime.experiment.id,
          environment: ENVIRONMENT,
        }),
      isDomainError('project_not_found'),
    );

    // Byte-identical: no rewrite, no truncation and no second record.
    assert.equal(await fs.readFile(runsPath, 'utf8'), before);

    const reopened = openRepositories(runtime.home);
    const history = await reopened.runs.listByExperiment(asExperimentId('exp-a'));
    assert.deepEqual(
      history.map((run) => run.id),
      [existing.id],
    );
    assert.equal(history[0]?.state, 'queued');
    assert.equal(history[0]?.experimentDefinitionHash, existing.experimentDefinitionHash);
    assert.deepEqual((await fs.readdir(runtime.home)).sort(), [
      'experiments.json',
      'projects.json',
      'runs.json',
    ]);
  });
});
