import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asArtifactId,
  asExperimentId,
  asProjectId,
  asRunId,
  completeRun,
  createEvidenceRef,
  createExperiment,
  createProject,
  createRun,
  startRun,
  FixedClock,
  InMemoryExperimentRepository,
  InMemoryProjectRepository,
  InMemoryRunRepository,
  RunService,
  SequentialIdGenerator,
  type EnvironmentManifest,
} from '../src/index.ts';

const ENVIRONMENT: EnvironmentManifest = {
  os: 'linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: '22.18.0',
};

const EVIDENCE = createEvidenceRef({
  artifactId: asArtifactId('art-1'),
  sha256: 'd'.repeat(64),
  mediaType: 'application/json',
  bytes: 42,
});

function buildService() {
  const projects = new InMemoryProjectRepository();
  const experiments = new InMemoryExperimentRepository();
  const runs = new InMemoryRunRepository();
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const service = new RunService({
    projects,
    experiments,
    runs,
    clock,
    ids: new SequentialIdGenerator('run'),
  });
  return { service, projects, experiments, runs, clock };
}

async function seed() {
  const context = buildService();
  await context.projects.save(
    createProject({
      id: asProjectId('proj-1'),
      name: 'example',
      source: { kind: 'github', location: 'https://github.com/example/example' },
      revision: 'a'.repeat(40),
    }),
  );
  await context.experiments.save(
    createExperiment({
      id: asExperimentId('exp-1'),
      projectId: asProjectId('proj-1'),
      name: 'suite passes',
      hypothesis: 'npm test exits 0',
      steps: [{ index: 0, description: 'run tests', command: 'npm test' }],
      expectedObservations: ['exit code 0'],
    }),
  );
  return context;
}

describe('RunService', () => {
  it('creates a run pinned to the experiment definition', async () => {
    const { service } = await seed();

    const run = await service.createRun({
      projectId: asProjectId('proj-1'),
      experimentId: 'exp-1',
      environment: ENVIRONMENT,
    });

    assert.equal(run.state, 'queued');
    assert.equal(run.experimentId, 'exp-1');
    assert.equal(run.experimentDefinitionHash.length, 64);
  });

  it('rejects an unknown project or experiment', async () => {
    const { service } = await seed();

    await assert.rejects(
      () =>
        service.createRun({
          projectId: asProjectId('missing'),
          experimentId: 'exp-1',
          environment: ENVIRONMENT,
        }),
      /does not exist/,
    );

    await assert.rejects(
      () =>
        service.createRun({
          projectId: asProjectId('proj-1'),
          experimentId: 'missing',
          environment: ENVIRONMENT,
        }),
      /does not exist/,
    );
  });

  it('rejects an experiment that belongs to another project', async () => {
    const { service, experiments } = await seed();
    await experiments.save(
      createExperiment({
        id: asExperimentId('exp-other'),
        projectId: asProjectId('proj-other'),
        name: 'other',
        hypothesis: 'other',
        steps: [{ index: 0, description: 'step' }],
        expectedObservations: ['something'],
      }),
    );

    await assert.rejects(
      () =>
        service.createRun({
          projectId: asProjectId('proj-1'),
          experimentId: 'exp-other',
          environment: ENVIRONMENT,
        }),
      /does not belong to project/,
    );
  });

  it('records an outcome end to end', async () => {
    const { service, clock } = await seed();
    const run = await service.createRun({
      projectId: asProjectId('proj-1'),
      experimentId: 'exp-1',
      environment: ENVIRONMENT,
    });

    clock.advance(1_000);
    await service.startRun(run.id);

    clock.advance(1_000);
    const completed = await service.recordOutcome({
      runId: run.id,
      result: 'FAIL',
      evidence: [EVIDENCE],
      notes: 'one assertion failed',
    });

    assert.equal(completed.state, 'completed');
    assert.equal(completed.result, 'FAIL');
    assert.equal(completed.evidence.length, 1);
    assert.equal(completed.notes, 'one assertion failed');
  });

  it('rejects an unknown result status', async () => {
    const { service } = await seed();
    const run = await service.createRun({
      projectId: asProjectId('proj-1'),
      experimentId: 'exp-1',
      environment: ENVIRONMENT,
    });
    await service.startRun(run.id);

    await assert.rejects(
      () => service.recordOutcome({ runId: run.id, result: 'MAYBE' }),
      /not a valid result status/,
    );
  });

  it('refuses a second verdict on a finished run', async () => {
    const { service } = await seed();
    const run = await service.createRun({
      projectId: asProjectId('proj-1'),
      experimentId: 'exp-1',
      environment: ENVIRONMENT,
    });
    await service.startRun(run.id);
    await service.recordOutcome({ runId: run.id, result: 'NOT_TESTED' });

    await assert.rejects(
      () => service.recordOutcome({ runId: run.id, result: 'PASS', evidence: [EVIDENCE] }),
      /Only a running run can be completed/,
    );
  });

  it('keeps terminal runs immutable at the storage boundary', async () => {
    const { runs } = await seed();

    const created = createRun({
      id: asRunId('run-1'),
      projectId: asProjectId('proj-1'),
      experimentId: asExperimentId('exp-1'),
      experimentDefinitionHash: 'e'.repeat(64),
      environment: ENVIRONMENT,
    });
    await runs.save(created);

    const finished = completeRun(
      startRun(created, new Date('2026-01-01T00:01:00Z')),
      { result: 'NOT_TESTED', finishedAt: new Date('2026-01-01T00:02:00Z') },
    );
    await runs.save(finished);

    await assert.rejects(
      () => runs.save({ ...finished, notes: 'rewritten' }),
      /cannot be modified/,
    );
  });

  it('lists runs per experiment without leaking other histories', async () => {
    const { service, runs } = await seed();
    await service.createRun({
      projectId: asProjectId('proj-1'),
      experimentId: 'exp-1',
      environment: ENVIRONMENT,
    });

    const history = await runs.listByExperiment(asExperimentId('exp-1'));
    assert.equal(history.length, 1);

    const empty = await runs.listByExperiment(asExperimentId('exp-absent'));
    assert.equal(empty.length, 0);
  });
});
