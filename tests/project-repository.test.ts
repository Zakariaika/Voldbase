import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  asProjectId,
  createProject,
  InMemoryProjectRepository,
  type Project,
} from '../src/index.ts';

const PROJECT_ID = asProjectId('proj-1');

const DEPENDENCY = {
  ecosystem: 'npm',
  manifestPath: 'package.json',
  digest: '1'.repeat(64),
};

const CREATED_AT = '2026-01-01T00:00:00.000Z';

function storedProject(): Project {
  return createProject({
    id: PROJECT_ID,
    name: 'example',
    source: { kind: 'github', location: 'https://github.com/example/example', ref: 'main' },
    revision: 'a'.repeat(40),
    dependencies: [DEPENDENCY],
    configuration: { node: '22' },
    createdAt: new Date(CREATED_AT),
  });
}

/**
 * `readonly` is compile-time only, so this is exactly the mutation an ordinary
 * JavaScript caller can perform on any project object it holds.
 */
function corrupt(project: Project): void {
  const view = project as unknown as {
    name: string;
    source: { kind: string; location: string; ref?: string };
    dependencies: { ecosystem: string; manifestPath: string; digest: string }[];
    configuration: Record<string, string>;
    createdAt: Date;
  };

  view.name = 'hijacked';
  view.source.location = 'https://github.com/attacker/attacker';
  view.source.ref = 'attacker';
  view.dependencies[0]!.digest = 'f'.repeat(64);
  view.dependencies.push({ ecosystem: 'npm', manifestPath: 'extra.json', digest: 'e'.repeat(64) });
  view.configuration.node = 'attacker';
  view.createdAt.setTime(0);
}

async function saveFresh(repository: InMemoryProjectRepository): Promise<Project> {
  const project = storedProject();
  await repository.save(project);
  return project;
}

describe('in-memory project repository aliasing', () => {
  it('is unaffected by mutations to the object that was saved', async () => {
    const repository = new InMemoryProjectRepository();
    const saved = await saveFresh(repository);

    corrupt(saved);

    const stored = await repository.findById(PROJECT_ID);
    assert.ok(stored);
    assert.equal(stored.name, 'example');
    assert.equal(stored.source.location, 'https://github.com/example/example');
    assert.equal(stored.source.ref, 'main');
    assert.equal(stored.dependencies.length, 1);
    assert.equal(stored.dependencies[0]!.digest, DEPENDENCY.digest);
    assert.deepEqual(stored.configuration, { node: '22' });
    assert.equal(stored.createdAt.toISOString(), CREATED_AT);
  });

  it('is unaffected by mutations to an object returned by findById', async () => {
    const repository = new InMemoryProjectRepository();
    await saveFresh(repository);

    const first = await repository.findById(PROJECT_ID);
    assert.ok(first);
    corrupt(first);

    const second = await repository.findById(PROJECT_ID);
    assert.ok(second);
    assert.notEqual(first, second);
    assert.equal(second.name, 'example');
    assert.equal(second.dependencies[0]!.digest, DEPENDENCY.digest);
    assert.equal(second.createdAt.toISOString(), CREATED_AT);
  });

  it('does not expose the store through the array returned by list', async () => {
    const repository = new InMemoryProjectRepository();
    await saveFresh(repository);

    const listed = await repository.list();
    assert.equal(listed.length, 1);
    corrupt(listed[0]!);
    listed.push(createProject({ ...storedProject(), id: asProjectId('proj-2') }));

    const again = await repository.list();
    assert.equal(again.length, 1);
    assert.equal(again[0]!.name, 'example');
    assert.equal(again[0]!.source.ref, 'main');
  });

  it('rejects a mutated copy on re-save instead of laundering it into the store', async () => {
    const repository = new InMemoryProjectRepository();
    await saveFresh(repository);

    const leaked = await repository.findById(PROJECT_ID);
    assert.ok(leaked);
    corrupt(leaked);

    // The source is checked before the name, so that is the error reported here;
    // what matters is that the mutated copy never reaches the store.
    await assert.rejects(() => repository.save(leaked), /cannot be re-pointed/);

    const stored = await repository.findById(PROJECT_ID);
    assert.ok(stored);
    assert.equal(stored.name, 'example');
    assert.equal(stored.configuration.node, '22');
  });

  it('keeps the original createdAt across repeated identical saves', async () => {
    const repository = new InMemoryProjectRepository();
    await saveFresh(repository);

    await repository.save(storedProject());
    await repository.save(storedProject());

    const stored = await repository.findById(PROJECT_ID);
    assert.ok(stored);
    assert.equal(stored.createdAt.toISOString(), CREATED_AT);
  });
});
