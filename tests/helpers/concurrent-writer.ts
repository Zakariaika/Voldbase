/**
 * Child-process writer for the cross-process concurrency test.
 *
 * Spawned by `tests/storage-lock.test.ts`; never imported by product code. Each
 * process opens the same store, writes one project and exits, so the test exercises
 * real OS-level concurrency rather than two objects in one event loop.
 */

import { asProjectId } from '../../src/domain/ids.ts';
import { createProject } from '../../src/domain/project.ts';
import { JsonProjectRepository } from '../../src/infrastructure/fs/json-project-repository.ts';

const [storagePath, projectId, indexText] = process.argv.slice(2);

if (storagePath === undefined || projectId === undefined || indexText === undefined) {
  process.stderr.write('usage: concurrent-writer <storage-path> <project-id> <index>\n');
  process.exit(2);
}

const repository = new JsonProjectRepository({
  filePath: storagePath,
  lock: { timeoutMs: 20_000, pollIntervalMs: 10 },
});

const project = createProject({
  id: asProjectId(projectId),
  name: `project-${indexText}`,
  source: { kind: 'local', location: `/tmp/project-${indexText}` },
  // 64 lowercase hex characters: `1`.repeat(64) and so on.
  revision: indexText.padStart(2, '0').slice(0, 1).repeat(64),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  configuration: {},
  dependencies: [],
});

await repository.save(project);
process.exit(0);
