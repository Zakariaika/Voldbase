/**
 * ArchitectureService — the architecture use case (Phase 2B).
 *
 * Loads one stored analysis through the repository port and derives its
 * architecture model. It depends only on `AnalysisRepository` and the digest
 * check: the builder does the graph work, and the domain decides what the model
 * may contain.
 *
 * **Nothing is persisted.** The analysis is the stored, immutable evidence; the
 * architecture model is a deterministic projection of it, so writing it back
 * would create a second artifact to keep consistent without adding information.
 * A durable architecture record would need its own ADR before it is added here.
 */

import type { AnalysisRepository } from './ports.ts';
import { buildArchitecture, type BuildArchitectureOptions } from './architecture-builder.ts';
import type { AnalysisSnapshot } from '../domain/analysis.ts';
import { assertAnalysisDigest } from '../domain/analysis.ts';
import type { ArchitectureSnapshot } from '../domain/architecture.ts';
import { DomainError, invariant } from '../domain/errors.ts';
import { asAnalysisId } from '../domain/ids.ts';

export interface BuildArchitectureCommand {
  readonly analysisId: string;
  readonly limits?: BuildArchitectureOptions['limits'];
  readonly thresholds?: BuildArchitectureOptions['thresholds'];
}

export interface BuildArchitectureResult {
  /** The analysis the model was derived from, so the CLI can cite it. */
  readonly analysis: AnalysisSnapshot;
  readonly architecture: ArchitectureSnapshot;
}

export class ArchitectureService {
  private readonly analyses: AnalysisRepository;

  constructor(analyses: AnalysisRepository) {
    this.analyses = analyses;
  }

  /**
   * Derive the architecture of a stored analysis.
   *
   * Fails with `analysis_not_found` when no analysis has that id, and with
   * `analysis_corrupted` when the stored snapshot no longer matches its digest —
   * an architecture report must never be built from evidence that changed.
   */
  async build(command: BuildArchitectureCommand): Promise<BuildArchitectureResult> {
    invariant(
      typeof command.analysisId === 'string' && command.analysisId.trim() !== '',
      'invalid_argument',
      'An analysis id is required to derive architecture',
    );
    const analysisId = asAnalysisId(command.analysisId);

    const analysis = await this.analyses.find(analysisId);
    if (analysis === null) {
      throw new DomainError(
        'analysis_not_found',
        `No analysis with id ${analysisId} is stored; run 'voldbase analyze <project-id>' first`,
      );
    }

    // Re-check the evidence before trusting it. The repository validates on read,
    // but architecture is a derived claim and should not depend on that subtlety.
    assertAnalysisDigest(analysis);

    const architecture = buildArchitecture(analysis, {
      ...(command.limits === undefined ? {} : { limits: command.limits }),
      ...(command.thresholds === undefined ? {} : { thresholds: command.thresholds }),
    });

    return { analysis, architecture };
  }
}
