/**
 * Import a local project into VOLDBASE.
 *
 * The use case owns the policy; the scanner and the repository own the I/O. It
 * never touches a filesystem, a clock or an environment variable directly
 * (ADR-0003), which is what lets the CLI tests run against temporary data and a
 * fixed clock.
 *
 * A project is a snapshot (domain model §1), so the same directory imported twice
 * is a no-op only while its contents are identical. Once the contents change, the
 * old snapshot must not be silently re-pointed: re-importing the path without a
 * new name is refused, and `--name` records the new revision as a separate
 * project. Naming is not a rename operation: an identical snapshot may not be
 * re-recorded under a second name.
 *
 * The revision is compared only against a project at the same source location, so
 * two directories with identical contents are still two projects.
 */

import { DomainError } from '../domain/errors.ts';
import { asProjectId } from '../domain/ids.ts';
import { createProject, type Project } from '../domain/project.ts';
import type {
  Clock,
  IdGenerator,
  ProjectRepository,
  ProjectScan,
  ProjectScanner,
} from './ports.ts';

export interface ProjectImportDeps {
  readonly projects: ProjectRepository;
  readonly scanner: ProjectScanner;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface ImportProjectCommand {
  /** Directory to import. Relative paths are resolved against the process cwd. */
  readonly path: string;
  /** Explicit project name; defaults to the directory name. */
  readonly name?: string;
}

export interface ImportProjectResult {
  readonly project: Project;
  /** `false` when an identical snapshot was already imported. */
  readonly created: boolean;
  readonly scan: ProjectScan;
}

export class ProjectImportService {
  readonly #projects: ProjectRepository;
  readonly #scanner: ProjectScanner;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(deps: ProjectImportDeps) {
    this.#projects = deps.projects;
    this.#scanner = deps.scanner;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  async import(command: ImportProjectCommand): Promise<ImportProjectResult> {
    const scan = await this.#scanner.scan(command.path);
    const name = command.name ?? scan.suggestedName;

    const existing = (await this.#projects.list()).find(
      (project) =>
        project.source.kind === 'local' && project.source.location === scan.root,
    );

    if (existing !== undefined) {
      const explicitName = command.name !== undefined;

      if (existing.revision === scan.revision) {
        if (explicitName && existing.name !== name) {
          throw new DomainError(
            'project_name_conflict',
            `${scan.root} is already imported as '${existing.name}' (${existing.id}); ` +
              `the identical snapshot cannot be recorded again as '${name}'.`,
          );
        }
        return { project: existing, created: false, scan };
      }

      // The contents changed. An explicit different name records the new snapshot
      // as its own project; otherwise re-pointing an existing id is refused.
      const recordsNewSnapshot = explicitName && existing.name !== name;
      if (!recordsNewSnapshot) {
        throw new DomainError(
          'project_changed',
          `'${existing.name}' (${existing.id}) was already imported from ${scan.root} at ` +
            `revision ${existing.revision}, but the directory has changed since ` +
            `(now ${scan.revision}). A snapshot is immutable: import it with ` +
            '--name to record this version as a separate project.',
        );
      }
    }

    const project = createProject({
      id: asProjectId(this.#ids.next()),
      name,
      source: { kind: 'local', location: scan.root },
      revision: scan.revision,
      dependencies: scan.manifests,
      // Phase 1 records manifests only; no configuration values are collected.
      configuration: {},
      createdAt: this.#clock.now(),
    });

    await this.#projects.save(project);
    return { project, created: true, scan };
  }
}
