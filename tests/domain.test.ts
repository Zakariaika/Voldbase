import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asArtifactId,
  asExperimentId,
  asProjectId,
  asRevision,
  asRunId,
  assertProjectSnapshotCompatible,
  canonicalize,
  completeRun,
  createEvidenceRef,
  createExperiment,
  createProject,
  createRun,
  experimentDefinitionHash,
  isResultStatus,
  isRevision,
  requiresEvidence,
  revisionKind,
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
    projectRevision: 'a'.repeat(40),
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
    for (const revision of ['main', 'HEAD', 'latest', 'refs/heads/main', 'refs/tags/v1']) {
      assert.throws(
        () =>
          createProject({
            id: asProjectId('proj-2'),
            name: 'example',
            source: { kind: 'local', location: '/tmp/example' },
            revision,
          }),
        /pinned to an immutable identifier/,
      );
    }
  });

  it('rejects a revision that is only hash-shaped', () => {
    assert.throws(
      () =>
        createProject({
          id: asProjectId('proj-4'),
          name: 'example',
          source: { kind: 'local', location: '/tmp/example' },
          revision: 'deadbeef',
        }),
      /full 40-character Git commit SHA/,
    );
  });

  it('rejects an empty name', () => {
    assert.throws(
      () =>
        createProject({
          id: asProjectId('proj-3'),
          name: ' ',
          source: { kind: 'local', location: '/tmp/example' },
          revision: 'a'.repeat(40),
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

describe('revision identifiers', () => {
  it('accepts a full git commit SHA and a SHA-256 digest', () => {
    const sha1 = 'a'.repeat(40);
    const sha256 = 'b'.repeat(64);

    assert.equal(asRevision(sha1), sha1);
    assert.equal(asRevision(sha256), sha256);
    assert.equal(revisionKind(sha1), 'git-sha1');
    assert.equal(revisionKind(sha256), 'sha256');
    assert.equal(isRevision(sha1), true);
    assert.equal(isRevision(sha256), true);
  });

  it('rejects hash-shaped strings that are not immutable identifiers', () => {
    const invalid = [
      'deadbeef',
      '9a3f1c2',
      'a'.repeat(39),
      'a'.repeat(41),
      'g'.repeat(40),
      'A'.repeat(40),
    ];

    for (const revision of invalid) {
      assert.throws(() => asRevision(revision), /full 40-character Git commit SHA/);
      assert.equal(isRevision(revision), false);
      assert.equal(revisionKind(revision), undefined);
    }
  });

  it('distinguishes a floating ref from missing input', () => {
    for (const revision of ['main', 'HEAD', 'latest', 'refs/heads/main']) {
      assert.throws(() => asRevision(revision), /pinned to an immutable identifier/);
    }
    for (const revision of ['', '   ']) {
      assert.throws(() => asRevision(revision), /non-empty/);
    }
  });
});

const DEPENDENCY_A = {
  ecosystem: 'npm',
  manifestPath: 'package.json',
  digest: '1'.repeat(64),
};

const DEPENDENCY_B = {
  ecosystem: 'pypi',
  manifestPath: 'requirements.txt',
  digest: '2'.repeat(64),
};

describe('project snapshot immutability', () => {
  it('refuses to re-point an existing snapshot at a different revision', () => {
    const original = sampleProject();
    const repointed = createProject({ ...original, revision: 'c'.repeat(40) });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, repointed),
      /cannot be re-pointed/,
    );
  });

  it('refuses to move a snapshot to a different source', () => {
    const original = sampleProject();
    const moved = createProject({
      ...original,
      source: { kind: 'local', location: '/tmp/elsewhere' },
    });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, moved),
      /cannot be re-pointed to local:/,
    );
  });

  it('refuses to change the project name', () => {
    const original = sampleProject();
    const renamed = createProject({ ...original, name: 'renamed' });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, renamed),
      /cannot change to 'renamed'/,
    );
  });

  it('refuses to add a dependency to a recorded snapshot', () => {
    const original = sampleProject();
    const withDependency = createProject({ ...original, dependencies: [DEPENDENCY_A] });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, withDependency),
      /dependency snapshot that cannot be replaced/,
    );
  });

  it('refuses to change a recorded dependency digest', () => {
    const original = createProject({ ...sampleProject(), dependencies: [DEPENDENCY_A] });
    const changed = createProject({
      ...original,
      dependencies: [{ ...DEPENDENCY_A, digest: '9'.repeat(64) }],
    });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, changed),
      /dependency snapshot that cannot be replaced/,
    );
  });

  it('refuses to remove a recorded dependency', () => {
    const original = createProject({ ...sampleProject(), dependencies: [DEPENDENCY_A] });
    const emptied = createProject({ ...original, dependencies: [] });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, emptied),
      /dependency snapshot that cannot be replaced/,
    );
  });

  it('refuses to change recorded configuration', () => {
    const original = createProject({ ...sampleProject(), configuration: { node: '22' } });
    const changed = createProject({ ...original, configuration: { node: '24' } });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, changed),
      /configuration that cannot change/,
    );
  });

  it('refuses to drop recorded configuration', () => {
    const original = createProject({ ...sampleProject(), configuration: { node: '22' } });
    const emptied = createProject({ ...original, configuration: {} });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, emptied),
      /configuration that cannot change/,
    );
  });

  it('treats reordered dependencies as the same snapshot', () => {
    const first = createProject({
      ...sampleProject(),
      dependencies: [DEPENDENCY_A, DEPENDENCY_B],
    });
    const reordered = createProject({
      ...first,
      dependencies: [DEPENDENCY_B, DEPENDENCY_A],
    });

    assert.doesNotThrow(() => assertProjectSnapshotCompatible(first, reordered));
  });

  it('accepts an unchanged snapshot', () => {
    const original = createProject({
      ...sampleProject(),
      dependencies: [DEPENDENCY_A],
      configuration: { node: '22' },
    });
    const same = createProject({ ...original });

    assert.doesNotThrow(() => assertProjectSnapshotCompatible(original, same));
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
