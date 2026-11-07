import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { arcParams, distance } from '../core/geometry';
import type { Entity, Id, Point } from '../core/model';
import type { Sketch } from '../core/sketch';
import { createSolver } from './solver';
import type { Solver } from './solver';

let solver: Solver;

beforeAll(async () => {
  solver = await createSolver();
});

afterAll(() => {
  solver.dispose();
});

function entity(sketch: Sketch, id: Id): Entity {
  const found = sketch.entities.find((e) => e.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

function point(sketch: Sketch, id: Id): Point {
  const e = entity(sketch, id);
  if (e.kind !== 'point') throw new Error(`${id} is not a point`);
  return e;
}

const PRECISION = 6;

describe('Solver', () => {
  it('reports 4 DOF for a free line', () => {
    const b = new SketchBuilder();
    b.line(b.point(0, 0), b.point(10, 1));
    const result = solver.solve(b.build());
    expect(result).toMatchObject({ outcome: 'solved', dof: 4, conflicting: [], redundant: [] });
  });

  it('fully constrains a rectangle', () => {
    const b = new SketchBuilder();
    const [p1, p2, p3, p4] = [b.point(0, 0), b.point(90, 5), b.point(95, 60), b.point(-3, 55)];
    const top = b.line(p1, p2);
    const right = b.line(p2, p3);
    const bottom = b.line(p3, p4);
    const left = b.line(p4, p1);
    b.fix(p1);
    b.constrain({ kind: 'horizontal', a: top });
    b.constrain({ kind: 'horizontal', a: bottom });
    b.constrain({ kind: 'vertical', a: right });
    b.constrain({ kind: 'vertical', a: left });
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 100 });
    b.constrain({ kind: 'distance', a: p2, b: p3, value: 50 });

    const result = solver.solve(b.build());
    expect(result.outcome).toBe('solved');
    expect(result.dof).toBe(0);
    const s = result.sketch;
    expect(point(s, p1)).toMatchObject({ x: 0, y: 0 });
    expect(point(s, p2).x).toBeCloseTo(100, PRECISION);
    expect(point(s, p2).y).toBeCloseTo(0, PRECISION);
    expect(point(s, p3).x).toBeCloseTo(100, PRECISION);
    expect(point(s, p3).y).toBeCloseTo(50, PRECISION);
    expect(point(s, p4).x).toBeCloseTo(0, PRECISION);
    expect(point(s, p4).y).toBeCloseTo(50, PRECISION);
  });

  it('reports conflicting constraints by sketch id and leaves the sketch unchanged', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 1);
    const line = b.line(p1, p2);
    const h = b.constrain({ kind: 'horizontal', a: line });
    const v = b.constrain({ kind: 'vertical', a: line });
    const d = b.constrain({ kind: 'distance', a: p1, b: p2, value: 50 });
    const sketch = b.build();

    const result = solver.solve(sketch);
    expect(result.outcome).toBe('failed');
    expect(result.sketch).toBe(sketch);
    expect([...result.conflicting].sort()).toEqual([h, v, d].sort());
  });

  it('reports redundant constraints', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 1);
    const line = b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: line });
    const dup = b.constrain({ kind: 'horizontal', a: p1, b: p2 });

    const result = solver.solve(b.build());
    expect(result.redundant).toEqual([dup]);
    expect(result.outcome).not.toBe('failed');
  });

  it('drags a point while keeping constraints', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    b.constrain({ kind: 'horizontal', a: b.line(p1, p2) });

    const result = solver.solve(b.build(), { point: p2, x: 30, y: 20 });
    expect(result.outcome).toBe('solved');
    expect(result.dof).toBe(3);
    expect(point(result.sketch, p2).x).toBeCloseTo(30, PRECISION);
    expect(point(result.sketch, p2).y).toBeCloseTo(20, PRECISION);
    expect(point(result.sketch, p1).y).toBeCloseTo(20, PRECISION);
  });

  it('drag yields to permanent constraints', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    b.fix(p1);
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 10 });

    const result = solver.solve(b.build(), { point: p2, x: 0, y: 40 });
    expect(result.outcome).toBe('solved');
    const moved = point(result.sketch, p2);
    expect(distance(point(result.sketch, p1), moved)).toBeCloseTo(10, PRECISION);
    expect(moved.x).toBeCloseTo(0, 3);
    expect(moved.y).toBeCloseTo(10, 3);
  });

  it('keeps arc endpoints on the arc', () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.point(10, 0);
    const e = b.point(0, 12);
    b.arc(c, s, e);

    const result = solver.solve(b.build());
    expect(result.outcome).toBe('solved');
    expect(result.dof).toBe(5);
    const sk = result.sketch;
    expect(distance(point(sk, c), point(sk, s))).toBeCloseTo(
      distance(point(sk, c), point(sk, e)),
      PRECISION,
    );
  });

  it('solves radius, tangent and point-on-curve constraints', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 18);
    const l1 = b.point(0, 0);
    const l2 = b.point(100, 3);
    const line = b.line(l1, l2);
    const onCircle = b.point(70, 60);
    b.fix(center);
    b.constrain({ kind: 'radius', curve: circle, value: 20 });
    b.constrain({ kind: 'horizontal', a: line });
    b.constrain({ kind: 'tangent', a: line, b: circle });
    b.constrain({ kind: 'pointOnCurve', point: onCircle, curve: circle });

    const result = solver.solve(b.build());
    expect(result.outcome).toBe('solved');
    const sk = result.sketch;
    const solvedCircle = entity(sk, circle);
    expect(solvedCircle.kind === 'circle' && solvedCircle.radius).toBeCloseTo(20, PRECISION);
    expect(Math.abs(point(sk, l1).y - 50)).toBeCloseTo(20, PRECISION);
    expect(distance(point(sk, center), point(sk, onCircle))).toBeCloseTo(20, PRECISION);
  });

  it('measures angles counterclockwise on screen', () => {
    const b = new SketchBuilder();
    const o = b.point(0, 0);
    const base = b.line(o, b.point(100, 0));
    const tip = b.point(80, -10);
    const arm = b.line(o, tip);
    b.fix(o);
    b.constrain({ kind: 'horizontal', a: base });
    b.constrain({ kind: 'distance', a: o, b: tip, value: 100 });
    b.constrain({ kind: 'angle', a: base, b: arm, value: 30 });

    const result = solver.solve(b.build());
    expect(result.outcome).toBe('solved');
    const t = point(result.sketch, tip);
    expect(t.x).toBeCloseTo(100 * Math.cos(Math.PI / 6), 4);
    expect(t.y).toBeCloseTo(-100 * Math.sin(Math.PI / 6), 4);
  });

  it('solves a tangent arc joining two lines (rounded corner)', () => {
    const b = new SketchBuilder();
    const a1 = b.point(0, 0);
    const a2 = b.point(80, 0);
    const c = b.point(80, 20);
    const b1 = b.point(100, 20);
    const b2 = b.point(100, 100);
    const top = b.line(a1, a2);
    const right = b.line(b1, b2);
    const arc = b.arc(c, a2, b1);
    b.constrain({ kind: 'horizontal', a: top });
    b.constrain({ kind: 'vertical', a: right });
    b.constrain({ kind: 'tangent', a: top, b: arc });
    b.constrain({ kind: 'tangent', a: right, b: arc });
    b.constrain({ kind: 'radius', curve: arc, value: 25 });

    const result = solver.solve(b.build());
    expect(result.outcome).toBe('solved');
    const sk = result.sketch;
    const { radius } = arcParams(point(sk, c), point(sk, a2), point(sk, b1));
    expect(radius).toBeCloseTo(25, 4);
    expect(point(sk, c).y - point(sk, a2).y).toBeCloseTo(25, 4);
    expect(point(sk, b1).x - point(sk, c).x).toBeCloseTo(25, 4);
  });

  it('uses named parameters', () => {
    const b = new SketchBuilder().param('gap', 16);
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    b.fix(p1);
    b.constrain({ kind: 'horizontal', a: p1, b: p2 });
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 'gap' });

    const result = solver.solve(b.build());
    expect(point(result.sketch, p2).x).toBeCloseTo(16, PRECISION);
    expect(result.dof).toBe(0);
  });

  it('solves equal, parallel, perpendicular, midpoint and point-on-line', () => {
    const b = new SketchBuilder();
    const p = [
      b.point(0, 0),
      b.point(50, 2),
      b.point(0, 30),
      b.point(40, 33),
      b.point(5, 70),
      b.point(3, 0),
    ];
    const [p0, p1, p2, p3, p4, p5] = p as [Id, Id, Id, Id, Id, Id];
    const l1 = b.line(p0, p1);
    const l2 = b.line(p2, p3);
    const l3 = b.line(p2, p4);
    const mid = b.point(20, 1);
    b.fix(p0);
    b.constrain({ kind: 'horizontal', a: l1 });
    b.constrain({ kind: 'parallel', a: l1, b: l2 });
    b.constrain({ kind: 'equal', a: l1, b: l2 });
    b.constrain({ kind: 'perpendicular', a: l2, b: l3 });
    b.constrain({ kind: 'midpoint', point: mid, line: l1 });
    b.constrain({ kind: 'pointOnLine', point: p5, line: l1 });

    const result = solver.solve(b.build());
    expect(result.outcome).toBe('solved');
    const sk = result.sketch;
    const [q0, q1, q2, q3, q4, q5] = p.map((id) => point(sk, id)) as [
      Point,
      Point,
      Point,
      Point,
      Point,
      Point,
    ];
    expect(q1.y).toBeCloseTo(q0.y, PRECISION);
    expect(q3.y).toBeCloseTo(q2.y, PRECISION);
    expect(distance(q2, q3)).toBeCloseTo(distance(q0, q1), PRECISION);
    expect(q4.x).toBeCloseTo(q2.x, PRECISION);
    expect(point(sk, mid).x).toBeCloseTo((q0.x + q1.x) / 2, PRECISION);
    expect(point(sk, mid).y).toBeCloseTo((q0.y + q1.y) / 2, PRECISION);
    expect(q5.y).toBeCloseTo(q0.y, PRECISION);
  });
});
