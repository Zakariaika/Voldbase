/**
 * Derive an architecture model from a stored analysis (Phase 2B).
 *
 * The use case owns the policy: which analysis may be read, that the stored
 * snapshot still matches the digest it was saved with, and that the derivation
 * uses the recorded analysis exactly as it is. It reads through the existing
 * `AnalysisRepository` port and calls a pure builder, so it needs no filesystem,
 * no clock and no id generator — an architecture model is a function of its input.
 *
 * **Nothing is persisted.** Phase 2A already stores the immutable analysis, and
 * the architecture model is a deterministic projection of it: storing the
 * projection would add a second thing to keep consistent without adding
 * information. Re-running the command reproduces it byte for byte. If a durable
 * architecture record is ever needed (e.g. to attach review decisions to it), that
 * needs its own ADR first.
 */

import { buildArchitecture, type BuildArchitectureOptions } from './architecture-builder.ts';
import { assertAnalysisDigest, type AnalysisSnapshot } from '../domain/analysis.ts';
import { DomainError } from '../domain/errors.ts';
import type { ArchitectureSnapshot } from '../domain/architecture.ts';
import { asAnalysisId } from '../domain/ids.ts';
import type { AnalysisRepository } from './ports.ts';

export interface ArchitectureServiceDeps {
  readonly analyses: AnalysisRepository;
}

export interface BuildArchitectureCommand {
  readonly analysisId: string;
  /** Resource bounds for this derivation; the defaults are recorded in the model. */
  readonly limits?: BuildArchitectureOptions['limits'];
  /** Heuristic thresholds for this derivation; recorded in the model. */
  readonly thresholds?: BuildArchitectureOptions['thresholds'];
}

export interface BuildArchitectureResult {
  readonly analysis: AnalysisSnapshot;
  readonly architecture: ArchitectureSnapshot;
}

export class ArchitectureService {
  readonly #analyses: AnalysisRepository;

  constructor(deps: ArchitectureServiceDeps) {
    this.#analyses = deps.analyses;
  }

  async build(command: BuildArchitectureCommand): Promise<BuildArchitectureResult> {
    const analysisId = asAnalysisId(command.analysisId);
    const analysis = await this.#analyses.findById(analysisId);
    if (analysis === undefined) {
      throw new DomainError(
        'analysis_not_found',
        `No analysis with id '${command.analysisId}'; run \`voldbase analyze <project-id>\` first`,
      );
    }

    // The repository already validates what it loads, and this is the layer that
    // promises the derivation was made from the recorded analysis. Check again:
    // anything derived from a snapshot whose digest no longer matches would be
    // architecture for code nobody has evidence of.
    assertAnalysisDigest(analysis);

    const architecture = buildArchitecture(analysis, {
      ...(command.limits === undefined ? {} : { limits: command.limits }),
      ...(command.thresholds === undefined ? {} : { thresholds: command.thresholds }),
    });

    return { analysis, architecture };
  }
}
