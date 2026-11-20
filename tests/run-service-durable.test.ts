/**
 * RunService with durable storage (Phase 2C.2).
 *
 * This is the integration point Phase 2C left untested: `RunService` was only
 * ever exercised with the in-memory adapters, and the durable repositories were
 * only ever exercised directly. Here the service runs against
 * `JsonProjectRepository`, `JsonExperimentRepository` and `JsonRunRepository`
 * on a real temporary directory, so the full path — domain transition, validated
 * serialization, atomic write, and deserialization through fresh instances — is
 * covered end to end.
 *
 * Nothing is stubbed: no executor runs, no project code is executed, and the
 * "restart" is simulated by discarding the repository instances and opening the
 * same files again.
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
  experimentDefinitionHash,
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

const PROJECT_REVISION = 'a'.repeat(40);

const LOCK_OPTIONS = { timeoutMs: 2_000, pollIntervalMs: 10, staleMs: 5_000 };

async function makeHome(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2c2-'));
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

function buildProject(): Project {
  return createProject({
    id: asProjectId('proj-durable'),
    name: 'durable-demo',
    source: { kind: 'github', location: 'https://github.com/example/durable-demo' },
    revision: PROJECT_REVISION,
    createdAt: new Date('2026-06-01T00:00:00Z'),
  });
}

function buildExperiment(): Experiment {
  return createExperiment({
    id: asExperimentId('exp-durable'),
    projectId: asProjectId('proj-durable'),
    name: 'suite passes',
    hypothesis: 'npm test exits 0',
    steps: [
      { index: 0, description: 'run the test suite', command: 'npm test' },
      { index: 1, description: 'read the exit code' },
    ],
    determinism: 'deterministic',
    expectedObservations: ['exit code 0'],
    createdAt: new Date('2026-06-01T00:00:00Z'),
  });
}

describe('RunService with durable storage', () => {
  it('runs an experiment end to end and reads the run back after a restart', async (t) => {
    const home = await makeHome(t);
    const runtime = openRepositories(home);

    // 1–2. Persist a valid project and a valid experiment through the durable
    // repositories, exactly as the CLI/application layer would.
    const project = buildProject();
    const experiment = buildExperiment();
    await runtime.projects.save(project);
    await runtime.experiments.save(experiment);

    const clock = new FixedClock(new Date('2026-06-01T00:00:00Z'));

    // 3. RunService over the durable adapters, not the in-memory ones.
    const service = new RunService({
      projects: runtime.projects,
      experiments: runtime.experiments,
      runs: runtime.runs,
      clock,
      ids: new SequentialIdGenerator('run'),
    });

    // 4. Create the run through the service.
    const created = await service.createRun({
      projectId: project.id,
      experimentId: experiment.id,
      environment: ENVIRONMENT,
    });

    // 5–6. Relationships and the pinned definition hash.
    assert.equal(created.state, 'queued');
    assert.equal(created.projectId, project.id);
    assert.equal(created.projectRevision, project.revision);
    assert.equal(created.experimentId, experiment.id);
    assert.equal(created.experimentDefinitionHash, experimentDefinitionHash(experiment));
    assert.match(created.experimentDefinitionHash, /^[0-9a-f]{64}$/);

    // 7. Start, then finish with NOT_TESTED — no execution is claimed.
    clock.advance(1_000);
    const started = await service.startRun(created.id);
    assert.equal(started.state, 'running');

    clock.advance(1_000);
    const completed = await service.recordOutcome({
      runId: created.id,
      result: 'NOT_TESTED',
      notes: 'no execution was attempted',
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.result, 'NOT_TESTED');

    const expectedStartedAt = new Date('2026-06-01T00:00:01Z');
    const expectedFinishedAt = new Date('2026-06-01T00:00:02Z');

    // The document really holds the record, rather than only this instance's cache.
    const document = JSON.parse(await fs.readFile(runStorageFilePath(home), 'utf8')) as {
      runs: { id: string; state: string; experimentDefinitionHash: string }[];
    };
    assert.equal(document.runs.length, 1);
    assert.equal(document.runs[0]?.id, created.id);
    assert.equal(document.runs[0]?.state, 'completed');
    assert.equal(
      document.runs[0]?.experimentDefinitionHash,
      experimentDefinitionHash(experiment),
    );

    // 8. Simulate a restart: brand-new instances over the same storage paths.
    const restarted = openRepositories(home);

    // The project and experiment are still readable through the new instances,
    // so the run's references point at durable records rather than this process.
    const reloadedProject = await restarted.projects.findById(project.id);
    const reloadedExperiment = await restarted.experiments.findById(experiment.id);
    assert.ok(reloadedProject !== undefined);
    assert.ok(reloadedExperiment !== undefined);

    // 9. Read the run back and verify the persisted lifecycle, outcome,
    // timestamps, relationships and definition hash.
    const persisted = await restarted.runs.findById(created.id);
    assert.ok(persisted !== undefined);
    assert.equal(persisted.state, 'completed');
    assert.equal(persisted.result, 'NOT_TESTED');
    assert.equal(persisted.projectId, reloadedProject.id);
    assert.equal(persisted.projectRevision, reloadedProject.revision);
    assert.equal(persisted.experimentId, reloadedExperiment.id);
    assert.equal(
      persisted.experimentDefinitionHash,
      experimentDefinitionHash(reloadedExperiment),
    );
    assert.deepEqual(persisted.environment, ENVIRONMENT);
    assert.deepEqual(persisted.evidence, []);
    assert.equal(persisted.notes, 'no execution was attempted');
    assert.deepEqual(persisted.startedAt, expectedStartedAt);
    assert.deepEqual(persisted.finishedAt, expectedFinishedAt);

    const history = await restarted.runs.listByExperiment(reloadedExperiment.id);
    assert.deepEqual(
      history.map((run) => run.id),
      [created.id],
    );

    // 10. The terminal run cannot be modified: the repository refuses the write,
    // and the refusal leaves the stored document untouched.
    const beforeRefusal = await fs.readFile(runStorageFilePath(home), 'utf8');
    await assert.rejects(
      () => restarted.runs.save({ ...persisted, notes: 'rewritten after the fact' }),
      (error: unknown) => error instanceof DomainError && error.code === 'immutable_run',
    );

    // The service cannot bypass that rule either: a finished run is no longer
    // running, so recording a second verdict is rejected by the lifecycle guard.
    const restartedService = new RunService({
      projects: restarted.projects,
      experiments: restarted.experiments,
      runs: restarted.runs,
      clock,
      ids: new SequentialIdGenerator('run'),
    });
    await assert.rejects(
      () => restartedService.recordOutcome({ runId: created.id, result: 'NOT_TESTED' }),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'invalid_run_transition',
    );

    assert.equal(await fs.readFile(runStorageFilePath(home), 'utf8'), beforeRefusal);
    const unchanged = await openRepositories(home).runs.findById(created.id);
    assert.equal(unchanged?.state, 'completed');
    assert.equal(unchanged?.result, 'NOT_TESTED');
    assert.equal(unchanged?.notes, 'no execution was attempted');
    assert.deepEqual(unchanged?.finishedAt, expectedFinishedAt);
  });
});
