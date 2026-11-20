/**
 * RunService cancellation with durable storage (Phase 2C.4).
 *
 * Cancellation is a domain transition (`cancelRun`) that the service did not
 * expose. These tests drive the new `RunService.cancelRun` against the real JSON
 * repositories on a temporary directory: queued and running runs must cancel,
 * the cancellation must survive a restart, a terminal or missing run must be
 * refused, and every refusal must leave the stored document untouched.
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
  asRunId,
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
  type Run,
} from '../src/index.ts';

const ENVIRONMENT: EnvironmentManifest = {
  os: 'linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: '22.18.0',
};

const LOCK_OPTIONS = { timeoutMs: 2_000, pollIntervalMs: 10, staleMs: 5_000 };

const START = new Date('2026-08-01T00:00:00Z');

interface DurableRuntime {
  readonly home: string;
  readonly project: Project;
  readonly experiment: Experiment;
  readonly projects: JsonProjectRepository;
  readonly experiments: JsonExperimentRepository;
  readonly runs: JsonRunRepository;
  readonly clock: FixedClock;
  readonly service: RunService;
}

async function makeHome(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2c4-'));
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

function buildService(runtime: {
  projects: JsonProjectRepository;
  experiments: JsonExperimentRepository;
  runs: JsonRunRepository;
  clock: FixedClock;
}): RunService {
  return new RunService({
    projects: runtime.projects,
    experiments: runtime.experiments,
    runs: runtime.runs,
    clock: runtime.clock,
    ids: new SequentialIdGenerator('run'),
  });
}

async function seed(t: TestContext): Promise<DurableRuntime> {
  const home = await makeHome(t);
  const repositories = openRepositories(home);
  const project = createProject({
    id: asProjectId('proj-cancel'),
    name: 'cancel-demo',
    source: { kind: 'github', location: 'https://github.com/example/cancel-demo' },
    revision: 'a'.repeat(40),
    createdAt: START,
  });
  const experiment = createExperiment({
    id: asExperimentId('exp-cancel'),
    projectId: project.id,
    name: 'suite passes',
    hypothesis: 'npm test exits 0',
    steps: [{ index: 0, description: 'run the test suite', command: 'npm test' }],
    determinism: 'deterministic',
    expectedObservations: ['exit code 0'],
    createdAt: START,
  });
  await repositories.projects.save(project);
  await repositories.experiments.save(experiment);

  const clock = new FixedClock(START);
  const service = buildService({ ...repositories, clock });

  return { home, project, experiment, ...repositories, clock, service };
}

function isDomainError(code: string) {
  return (error: unknown): boolean => error instanceof DomainError && error.code === code;
}

async function createRun(runtime: DurableRuntime): Promise<Run> {
  return await runtime.service.createRun({
    projectId: runtime.project.id,
    experimentId: runtime.experiment.id,
    environment: ENVIRONMENT,
  });
}

describe('RunService cancellation with durable storage', () => {
  it('cancels a queued run', async (t) => {
    const runtime = await seed(t);
    const queued = await createRun(runtime);
    assert.equal(queued.state, 'queued');

    runtime.clock.advance(5_000);
    const cancelled = await runtime.service.cancelRun(queued.id);

    assert.equal(cancelled.id, queued.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual(cancelled.finishedAt, new Date('2026-08-01T00:00:05Z'));
    assert.equal(cancelled.startedAt, undefined);
    assert.equal(cancelled.result, undefined);
    assert.deepEqual(cancelled.evidence, []);

    const stored = await runtime.runs.findById(queued.id);
    assert.equal(stored?.state, 'cancelled');
    assert.deepEqual(stored?.finishedAt, new Date('2026-08-01T00:00:05Z'));
    assert.equal(stored?.result, undefined);
  });

  it('cancels a running run without losing when it started', async (t) => {
    const runtime = await seed(t);
    const queued = await createRun(runtime);

    runtime.clock.advance(1_000);
    const started = await runtime.service.startRun(queued.id);
    assert.equal(started.state, 'running');

    runtime.clock.advance(2_000);
    const cancelled = await runtime.service.cancelRun(queued.id);

    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual(cancelled.startedAt, new Date('2026-08-01T00:00:01Z'));
    assert.deepEqual(cancelled.finishedAt, new Date('2026-08-01T00:00:03Z'));
    assert.equal(cancelled.result, undefined);
    assert.deepEqual(cancelled.evidence, []);

    const stored = await runtime.runs.findById(queued.id);
    assert.equal(stored?.state, 'cancelled');
    assert.deepEqual(stored?.startedAt, new Date('2026-08-01T00:00:01Z'));
    assert.deepEqual(stored?.finishedAt, new Date('2026-08-01T00:00:03Z'));
  });

  it('keeps the cancelled state after recreating the JSON repository', async (t) => {
    const runtime = await seed(t);
    const queued = await createRun(runtime);
    runtime.clock.advance(1_000);
    await runtime.service.startRun(queued.id);
    runtime.clock.advance(1_000);
    await runtime.service.cancelRun(queued.id);

    // A brand-new instance reads the same document, not the old cache.
    const reopened = openRepositories(runtime.home);
    const persisted = await reopened.runs.findById(queued.id);

    assert.ok(persisted !== undefined);
    assert.equal(persisted.state, 'cancelled');
    assert.equal(persisted.result, undefined);
    assert.deepEqual(persisted.startedAt, new Date('2026-08-01T00:00:01Z'));
    assert.deepEqual(persisted.finishedAt, new Date('2026-08-01T00:00:02Z'));
    assert.equal(persisted.experimentId, runtime.experiment.id);
    assert.equal(persisted.projectId, runtime.project.id);

    // It is listed as the experiment's history too.
    const history = await reopened.runs.listByExperiment(runtime.experiment.id);
    assert.deepEqual(
      history.map((run) => [run.id, run.state]),
      [[queued.id, 'cancelled']],
    );
  });

  it('rejects cancelling a run that does not exist', async (t) => {
    const runtime = await seed(t);

    await assert.rejects(
      () => runtime.service.cancelRun(asRunId('run-missing')),
      isDomainError('run_not_found'),
    );

    // Nothing was written: there is no run document at all.
    await assert.rejects(() => fs.readFile(runStorageFilePath(runtime.home), 'utf8'), /ENOENT/);
    assert.deepEqual((await fs.readdir(runtime.home)).sort(), [
      'experiments.json',
      'projects.json',
    ]);
  });

  it('rejects cancelling an already completed run and leaves it unchanged', async (t) => {
    const runtime = await seed(t);
    const queued = await createRun(runtime);
    runtime.clock.advance(1_000);
    await runtime.service.startRun(queued.id);
    runtime.clock.advance(1_000);
    const completed = await runtime.service.recordOutcome({
      runId: queued.id,
      result: 'NOT_TESTED',
      notes: 'no execution attempted',
    });
    assert.equal(completed.state, 'completed');

    const runsPath = runStorageFilePath(runtime.home);
    const before = await fs.readFile(runsPath, 'utf8');

    runtime.clock.advance(1_000);
    await assert.rejects(
      () => runtime.service.cancelRun(queued.id),
      isDomainError('invalid_run_transition'),
    );

    assert.equal(await fs.readFile(runsPath, 'utf8'), before);

    const reopened = openRepositories(runtime.home);
    const stored = await reopened.runs.findById(queued.id);
    assert.equal(stored?.state, 'completed');
    assert.equal(stored?.result, 'NOT_TESTED');
    assert.equal(stored?.notes, 'no execution attempted');
    assert.deepEqual(stored?.finishedAt, new Date('2026-08-01T00:00:02Z'));
  });

  it('rejects cancelling an already cancelled run and leaves it unchanged', async (t) => {
    const runtime = await seed(t);
    const queued = await createRun(runtime);
    runtime.clock.advance(1_000);
    await runtime.service.cancelRun(queued.id);

    const runsPath = runStorageFilePath(runtime.home);
    const before = await fs.readFile(runsPath, 'utf8');

    runtime.clock.advance(1_000);
    await assert.rejects(
      () => runtime.service.cancelRun(queued.id),
      isDomainError('invalid_run_transition'),
    );

    assert.equal(await fs.readFile(runsPath, 'utf8'), before);

    const reopened = openRepositories(runtime.home);
    const stored = await reopened.runs.findById(queued.id);
    assert.equal(stored?.state, 'cancelled');
    assert.equal(stored?.result, undefined);
    // The original cancellation timestamp survives the refused second attempt.
    assert.deepEqual(stored?.finishedAt, new Date('2026-08-01T00:00:01Z'));
  });
});
