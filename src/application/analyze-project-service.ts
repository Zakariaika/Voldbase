/**
 * Analyze an imported project (Phase 2A).
 *
 * The use case owns the policy: which project may be analysed, which analyzer
 * version and settings were used, and that a snapshot is only stored when the
 * analysis actually describes the project's recorded revision. Reading, parsing
 * and persisting are done by adapters behind ports.
 *
 * It never touches a filesystem, a clock or the environment directly (ADR-0003),
 * so the CLI and future server share exactly one implementation of the rules.
 */

import { DomainError } from '../domain/errors.ts';
import { createAnalysisSnapshot, type AnalysisSnapshot } from '../domain/analysis.ts';
import { asProjectId, type AnalysisId } from '../domain/ids.ts';
import type { Project } from '../domain/project.ts';
import type {
  AnalysisLimits,
  AnalysisRepository,
  Clock,
  IdGenerator,
  ProjectAnalyzer,
  ProjectRepository,
} from './ports.ts';

export interface ProjectAnalysisDeps {
  readonly projects: ProjectRepository;
  readonly analyses: AnalysisRepository;
  readonly analyzer: ProjectAnalyzer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface AnalyzeProjectCommand {
  readonly projectId: string;
  /** Bounds for this run; the defaults are recorded in the snapshot either way. */
  readonly limits?: Partial<AnalysisLimits>;
}

export interface AnalyzeProjectResult {
  readonly project: Project;
  readonly analysis: AnalysisSnapshot;
}

export class ProjectAnalysisService {
  readonly #projects: ProjectRepository;
  readonly #analyses: AnalysisRepository;
  readonly #analyzer: ProjectAnalyzer;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(deps: ProjectAnalysisDeps) {
    this.#projects = deps.projects;
    this.#analyses = deps.analyses;
    this.#analyzer = deps.analyzer;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  async analyze(command: AnalyzeProjectCommand): Promise<AnalyzeProjectResult> {
    const projectId = asProjectId(command.projectId);
    const project = await this.#projects.findById(projectId);
    if (project === undefined) {
      throw new DomainError(
        'project_not_found',
        `No project with id '${command.projectId}'; run \`voldbase list\` to see imported projects`,
      );
    }

    // The analyzer verifies the directory against `project.revision` itself, both
    // before and after parsing, so the result can only be pinned to this revision.
    const result = await this.#analyzer.analyze(
      project,
      command.limits === undefined ? {} : command.limits,
    );

    const analysis = createAnalysisSnapshot({
      analysisId: this.#ids.next() as AnalysisId,
      projectId: project.id,
      projectRevision: project.revision,
      analyzerVersion: result.analyzerVersion,
      schemaVersion: 1,
      settings: result.settings,
      files: result.files,
      findings: result.findings,
      createdAt: this.#clock.now(),
    });

    // Persisted only after every integrity check passed: a snapshot stored against
    // a revision that was never verified would be evidence of nothing.
    await this.#analyses.save(analysis);

    return { project, analysis };
  }
}
