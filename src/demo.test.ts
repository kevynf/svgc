import { afterAll, beforeAll, expect, it } from 'vitest';
import { demoSketch } from './demo';
import { createSolver } from './solver/solver';
import type { Solver } from './solver/solver';

let solver: Solver;

beforeAll(async () => {
  solver = await createSolver();
});

afterAll(() => {
  solver.dispose();
});

it('demo sketch solves cleanly with width and height left free', () => {
  const result = solver.solve(demoSketch());
  expect(result).toMatchObject({ outcome: 'solved', dof: 2, conflicting: [], redundant: [] });
});

it('demo sketch stays solvable while a corner is dragged', () => {
  const sketch = demoSketch();
  const corner = sketch.entities.find((e) => e.kind === 'point' && e.x === 480 && e.y === 330);
  if (corner === undefined) throw new Error('corner not found');
  const result = solver.solve(sketch, { point: corner.id, x: 560, y: 400 });
  expect(result.outcome).toBe('solved');
  expect(result.conflicting).toEqual([]);
});
