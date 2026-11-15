import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asArtifactId,
  asExperimentId,
  asProjectId,
  asRunId,
  canonicalize,
  completeRun,
  createEvidenceRef,
  createExperiment,
  createProject,
  createRun,
  experimentDefinitionHash,
  isResultStatus,
  requiresEvidence,
  startRun,
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

function sampleProject(): Project {
  return createProject({
    id: asProjectId('proj-1'),
    name: 'example',
    source: { kind: 'github', location: 'https://github.com/example/example' },
    revision: 'a'.repeat(40),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function sampleExperiment(): Experiment {
  return createExperiment({
    id: asExperimentId('exp-1'),
    projectId: asProjectId('proj-1'),
    name: 'unit tests pass',
    hypothesis: 'The test suite exits 0 on a clean checkout',
    steps: [{ index: 0, description: 'run the suite', command: 'npm test' }],
    determinism: 'deterministic',
    expectedObservations: ['exit code 0'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function sampleRun(): Run {
  return createRun({
    id: asRunId('run-1'),
    projectId: asProjectId('proj-1'),
    experimentId: asExperimentId('exp-1'),
    experimentDefinitionHash: experimentDefinitionHash(sampleExperiment()),
    environment: ENVIRONMENT,
  });
}

const EVIDENCE = createEvidenceRef({
  artifactId: asArtifactId('art-1'),
  sha256: 'b'.repeat(64),
  mediaType: 'text/plain',
  bytes: 12,
});

describe('result taxonomy', () => {
  it('accepts only the five documented statuses', () => {
    for (const status of ['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_TESTED', 'BLOCKED']) {
      assert.equal(isResultStatus(status), true);
    }
    assert.equal(isResultStatus('UNKNOWN'), false);
    assert.equal(isResultStatus('pass'), false);
    assert.equal(isResultStatus(undefined), false);
  });

  it('requires evidence for the statuses that assert an observation', () => {
    assert.equal(requiresEvidence('PASS'), true);
    assert.equal(requiresEvidence('FAIL'), true);
    assert.equal(requiresEvidence('INCONCLUSIVE'), false);
    assert.equal(requiresEvidence('NOT_TESTED'), false);
    assert.equal(requiresEvidence('BLOCKED'), false);
  });
});

describe('project', () => {
  it('is created as a pinned snapshot', () => {
    const project = sampleProject();
    assert.equal(project.revision, 'a'.repeat(40));
    assert.deepEqual(project.dependencies, []);
    assert.deepEqual(project.configuration, {});
  });

  it('rejects floating revisions', () => {
    for (const revision of ['main', 'HEAD', 'latest', 'refs/heads/main', '  ']) {
      assert.throws(
        () =>
          createProject({
            id: asProjectId('proj-2'),
            name: 'example',
            source: { kind: 'local', location: '/tmp/example' },
            revision,
          }),
        /pinned/,
      );
    }
  });

  it('rejects an empty name', () => {
    assert.throws(
      () =>
        createProject({
          id: asProjectId('proj-3'),
          name: ' ',
          source: { kind: 'local', location: '/tmp/example' },
          revision: 'deadbeef',
        }),
      /name/,
    );
  });
});

describe('experiment', () => {
  it('requires contiguous steps and at least one expectation', () => {
    assert.throws(
      () =>
        createExperiment({
          id: asExperimentId('exp-bad'),
          projectId: asProjectId('proj-1'),
          name: 'bad',
          hypothesis: 'something',
          steps: [{ index: 1, description: 'out of order' }],
          expectedObservations: ['x'],
        }),
      /index 0/,
    );

    assert.throws(
      () =>
        createExperiment({
          id: asExperimentId('exp-bad-2'),
          projectId: asProjectId('proj-1'),
          name: 'bad',
          hypothesis: 'something',
          steps: [{ index: 0, description: 'a step' }],
          expectedObservations: [],
        }),
      /expected observation/,
    );
  });

  it('hashes the definition, not the metadata', () => {
    const first = sampleExperiment();
    const second = createExperiment({
      id: asExperimentId('exp-2'),
      projectId: asProjectId('proj-1'),
      name: first.name,
      hypothesis: first.hypothesis,
      steps: first.steps,
      determinism: first.determinism,
      expectedObservations: first.expectedObservations,
      createdAt: new Date('2030-01-01T00:00:00Z'),
    });
    assert.equal(experimentDefinitionHash(first), experimentDefinitionHash(second));

    const changed = createExperiment({
      id: asExperimentId('exp-3'),
      projectId: asProjectId('proj-1'),
      name: first.name,
      hypothesis: first.hypothesis,
      steps: [{ index: 0, description: 'run the suite', command: 'npm run test:all' }],
      determinism: first.determinism,
      expectedObservations: first.expectedObservations,
    });
    assert.notEqual(experimentDefinitionHash(first), experimentDefinitionHash(changed));
  });
});

describe('run lifecycle', () => {
  it('starts queued and transitions to running', () => {
    const run = sampleRun();
    assert.equal(run.state, 'queued');

    const started = startRun(run, new Date('2026-01-01T00:01:00Z'));
    assert.equal(started.state, 'running');
    assert.deepEqual(started.startedAt, new Date('2026-01-01T00:01:00Z'));
  });

  it('refuses to start twice', () => {
    const started = startRun(sampleRun(), new Date('2026-01-01T00:01:00Z'));
    assert.throws(() => startRun(started, new Date()), /Only a queued run/);
  });

  it('refuses PASS or FAIL without evidence', () => {
    const started = startRun(sampleRun(), new Date('2026-01-01T00:01:00Z'));
    assert.throws(
      () => completeRun(started, { result: 'PASS', finishedAt: new Date('2026-01-01T00:02:00Z') }),
      /requires at least one evidence/,
    );
  });

  it('records a verdict with evidence', () => {
    const started = startRun(sampleRun(), new Date('2026-01-01T00:01:00Z'));
    const completed = completeRun(started, {
      result: 'PASS',
      finishedAt: new Date('2026-01-01T00:02:00Z'),
      evidence: [EVIDENCE],
    });

    assert.equal(completed.state, 'completed');
    assert.equal(completed.result, 'PASS');
    assert.equal(completed.evidence.length, 1);
  });

  it('maps BLOCKED to a failed run', () => {
    const started = startRun(sampleRun(), new Date('2026-01-01T00:01:00Z'));
    const completed = completeRun(started, {
      result: 'BLOCKED',
      finishedAt: new Date('2026-01-01T00:02:00Z'),
      notes: 'toolchain unavailable',
    });

    assert.equal(completed.state, 'failed');
    assert.equal(completed.result, 'BLOCKED');
  });

  it('rejects a finish time before the start time', () => {
    const started = startRun(sampleRun(), new Date('2026-01-01T00:05:00Z'));
    assert.throws(
      () =>
        completeRun(started, {
          result: 'NOT_TESTED',
          finishedAt: new Date('2026-01-01T00:01:00Z'),
        }),
      /finish before it started/,
    );
  });
});

describe('evidence', () => {
  it('rejects malformed digests', () => {
    assert.throws(
      () =>
        createEvidenceRef({
          artifactId: asArtifactId('art-2'),
          sha256: 'not-a-digest',
          mediaType: 'text/plain',
          bytes: 1,
        }),
      /SHA-256/,
    );
  });

  it('rejects negative sizes', () => {
    assert.throws(
      () =>
        createEvidenceRef({
          artifactId: asArtifactId('art-3'),
          sha256: 'c'.repeat(64),
          mediaType: 'text/plain',
          bytes: -1,
        }),
      /non-negative/,
    );
  });
});

describe('canonical serialization', () => {
  it('is key-order independent', () => {
    assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  });

  it('drops undefined members but preserves empty containers', () => {
    assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalize({ a: [] }), '{"a":[]}');
  });

  it('rejects values that cannot be canonicalized deterministically', () => {
    assert.throws(() => canonicalize({ a: () => 1 }), /Cannot canonicalize/);
    assert.throws(() => canonicalize({ a: Number.NaN }), /non-finite/);
  });
});
