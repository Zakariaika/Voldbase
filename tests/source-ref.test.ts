import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asProjectId,
  assertProjectSnapshotCompatible,
  createProject,
  type Project,
} from '../src/index.ts';

const LOCATION = 'https://github.com/example/example';

function projectWithRef(ref?: string): Project {
  return createProject({
    id: asProjectId('proj-1'),
    name: 'example',
    source:
      ref === undefined
        ? { kind: 'github', location: LOCATION }
        : { kind: 'github', location: LOCATION, ref },
    revision: 'a'.repeat(40),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

describe('project snapshot source ref immutability', () => {
  it('refuses to change the source ref of a recorded snapshot', () => {
    const original = projectWithRef('main');
    const repointed = createProject({
      ...original,
      source: { ...original.source, ref: 'v1.0.0' },
    });

    assert.throws(
      () => assertProjectSnapshotCompatible(original, repointed),
      /cannot be re-pointed to github:https:\/\/github\.com\/example\/example@v1\.0\.0/,
    );
  });

  it('refuses to add a source ref to an unpinned snapshot', () => {
    assert.throws(
      () => assertProjectSnapshotCompatible(projectWithRef(), projectWithRef('main')),
      /cannot be re-pointed to github:https:\/\/github\.com\/example\/example@main/,
    );
  });

  it('refuses to drop a recorded source ref', () => {
    assert.throws(
      () => assertProjectSnapshotCompatible(projectWithRef('main'), projectWithRef()),
      /cannot be re-pointed to github:https:\/\/github\.com\/example\/example$/,
    );
  });

  it('accepts an unchanged source ref', () => {
    assert.doesNotThrow(() =>
      assertProjectSnapshotCompatible(projectWithRef('main'), projectWithRef('main')),
    );
  });

  it('accepts two matching unpinned snapshots', () => {
    assert.doesNotThrow(() => assertProjectSnapshotCompatible(projectWithRef(), projectWithRef()));
  });
});
