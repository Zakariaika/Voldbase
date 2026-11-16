/**
 * `voldbase architecture` (Phase 2B).
 *
 * The command reads a stored analysis through the repository port and prints a
 * derived report. Nothing is persisted, nothing is read from the project on disk,
 * and the output must be identical on every run.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { buildArchitecture, InMemoryAnalysisRepository } from '../src/index.ts';
import { main } from '../src/cli/main.ts';
import { analysisFromSpec, type GraphSpec } from './helpers/architecture-fixture.ts';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_SPEC: GraphSpec = {
  'src/a.ts': [{ to: 'src/b.ts' }],
  'src/b.ts': [{ to: 'src/a.ts' }],
  'src/solo.ts': [],
};

interface Harness {
  readonly run: (argv: readonly string[]) => Promise<CliResult>;
  readonly analysis: ReturnType<typeof analysisFromSpec>;
  readonly home: string;
}

async function makeHarness(t: TestContext, spec: GraphSpec = DEFAULT_SPEC): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voldbase-2b-cli-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const home = path.join(directory, 'home');
  const analyses = new InMemoryAnalysisRepository();
  const analysis = analysisFromSpec(spec, 'ana-7');
  await analyses.save(analysis);

  return {
    analysis,
    home,
    async run(argv) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await main(argv, {
        cwd: directory,
        env: { VOLDBASE_HOME: home },
        streams: {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        analyses,
      });
      return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    },
  };
}

describe('voldbase architecture', () => {
  it('prints a deterministic structural report', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['architecture', 'ana-7']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Architecture of analysis ana-7$/m);
    assert.match(result.stdout, /revision\s+sha256:/);
    assert.match(result.stdout, /analysis\s+sha256:/);
    assert.match(result.stdout, /files\s+3/);
    assert.match(result.stdout, /graph\s+2 edges, 2 imports merged/);
    assert.match(result.stdout, /^MODULES \(1\)$/m);
    assert.match(result.stdout, /^CYCLES \(1\)$/m);
    assert.match(result.stdout, /^FINDINGS \(2\)$/m);
    assert.match(result.stdout, /WARNING\s+VA001\s+certain/);
    assert.match(result.stdout, /evidence: src\/a\.ts -> src\/b\.ts/);
    assert.match(result.stdout, /INFO\s+VA005\s+certain/);
    assert.match(result.stdout, /does not verify runtime behaviour, correctness or security/);

    const again = await harness.run(['architecture', 'ana-7']);
    assert.equal(again.stdout, result.stdout);
  });

  it('emits canonical JSON that matches the derived digest', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['architecture', 'ana-7', '--format', 'json']);

    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      digest: string;
      analysisId: string;
      nodes: { path: string }[];
      findings: { ruleId: string }[];
    };

    assert.equal(parsed.digest, buildArchitecture(harness.analysis).digest);
    assert.equal(parsed.analysisId, 'ana-7');
    assert.deepEqual(
      parsed.nodes.map((node) => node.path),
      ['src/a.ts', 'src/b.ts', 'src/solo.ts'],
    );
    assert.deepEqual(
      parsed.findings.map((finding) => finding.ruleId),
      ['VA001', 'VA005'],
    );

    // Canonical JSON: keys sorted at every level, so two runs are byte-identical
    // and a diff of two reports shows only real changes.
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [...keys].sort());
    const again = await harness.run(['architecture', 'ana-7', '--format=json']);
    assert.equal(again.stdout, result.stdout);
  });

  it('exits 1 for an unknown analysis id', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['architecture', 'ana-404']);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /No analysis with id 'ana-404'/);
    assert.match(result.stderr, /code: analysis_not_found/);
  });

  it('exits 2 for a bad format or a missing id', async (t) => {
    const harness = await makeHarness(t);

    const badFormat = await harness.run(['architecture', 'ana-7', '--format', 'yaml']);
    assert.equal(badFormat.code, 2);
    assert.match(badFormat.stderr, /--format must be 'text' or 'json'/);

    assert.equal((await harness.run(['architecture'])).code, 2);
    assert.equal((await harness.run(['architecture', 'a', 'b'])).code, 2);
  });

  it('writes nothing to disk: the model is derived, not stored', async (t) => {
    const harness = await makeHarness(t);
    assert.equal((await harness.run(['architecture', 'ana-7'])).code, 0);
    await assert.rejects(fs.stat(harness.home), { code: 'ENOENT' });
  });

  it('works from the stored analysis even when the project files are gone', async (t) => {
    // The fixture analysis was never written anywhere: if the command needed the
    // project on disk, this would fail instead of reporting a graph.
    const harness = await makeHarness(t, {
      'src/only.ts': [{ specifier: './gone', resolution: 'unresolved-relative' }],
    });
    const result = await harness.run(['architecture', 'ana-7']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^FINDINGS \(1\)$/m);
    assert.match(result.stdout, /files\s+1/);
  });

  it('documents the command in the usage text', async (t) => {
    const harness = await makeHarness(t);
    const result = await harness.run(['help']);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /voldbase architecture <analysis-id>/);
    assert.match(result.stdout, /Derive file and module dependencies/);
  });
});
