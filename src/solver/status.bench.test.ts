import { describe, expect, it } from 'vitest';
import { analyzeStatus } from './status';
import { benchmark, format } from './status.bench';
import { createSolver } from './solver';
import type { Solver } from './solver';

/**
 * Performance measurement for `analyzeStatus`. Skipped by default so the normal
 * test run stays fast. Run it with:
 *
 *   $env:SVGC_BENCH = '1'
 *   npm.cmd exec -- vitest run src/solver/status.bench.test.ts --disableConsoleIntercept
 *
 * The environment is read through a global rather than `process` so the file
 * type-checks without @types/node.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const BENCH = env?.['SVGC_BENCH'] === '1';

describe.skipIf(!BENCH)('analyzeStatus performance', () => {
  let solver: Solver;

  it('measures generated sketches', async () => {
    solver = await createSolver();
    const timings = benchmark((sketch) => analyzeStatus(solver, sketch), (line) => console.log(line));
    console.log(`\n${format(timings)}\n`);
    expect(timings.length).toBeGreaterThan(0);
  }, 600_000);
});
