import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import type { Entity, Id, Point } from '../core/model';
import type { Sketch } from '../core/sketch';
import { analyzeStatus } from './status';
import type { EntityStatus } from './status';
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

/** Statuses as a compact `id:F`/`id:u` string for readable assertions. */
function summary(sketch: Sketch, report: { entities: ReadonlyMap<Id, EntityStatus> }): string {
  return sketch.entities
    .map((e) => `${e.id}:${report.entities.get(e.id) === 'fully' ? 'F' : 'u'}`)
    .join(' ');
}

function statuses(sketch: Sketch, report: { entities: ReadonlyMap<Id, EntityStatus> }): Record<string, EntityStatus> {
  const out: Record<string, EntityStatus> = {};
  for (const e of sketch.entities) out[e.id] = report.entities.get(e.id) ?? 'under';
  return out;
}

/** A grid of partly constrained rectangles with a mix of fixed and free parts. */
function grid(columns: number, rows: number): { sketch: Sketch; cell: (c: number, r: number) => Id[] } {
  const b = new SketchBuilder();
  const cells: Id[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const p = [
        b.point(c * 120, r * 100),
        b.point(c * 120 + 60, r * 100),
        b.point(c * 120 + 60, r * 100 + 60),
        b.point(c * 120, r * 100 + 60),
      ] as const;
      const [top, right, bottom, left] = [
        b.line(p[0], p[1]),
        b.line(p[1], p[2]),
        b.line(p[2], p[3]),
        b.line(p[3], p[0]),
      ];
      b.constrain({ kind: 'horizontal', a: top });
      b.constrain({ kind: 'horizontal', a: bottom });
      b.constrain({ kind: 'vertical', a: right });
      b.constrain({ kind: 'vertical', a: left });
      b.constrain({ kind: 'distance', a: p[0], b: p[1], value: 60 });
      if ((c + r) % 3 === 0) {
        // Fully constrained: width and height both dimensioned and anchored.
        b.constrain({ kind: 'distance', a: p[1], b: p[2], value: 60 });
        b.fix(p[0]);
      } else if ((c + r) % 3 === 1) {
        // Under-constrained: height missing.
        b.fix(p[0]);
      }
      // (c + r) % 3 === 2 cells are completely free.
      cells.push([...p]);
    }
  }
  return { sketch: b.build(), cell: (c, r) => cells[r * columns + c]! };
}

describe('analyzeStatus', () => {
  it('reports a free line as under-constrained', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 1);
    const line = b.line(p1, p2);
    const sketch = b.build();

    const report = analyzeStatus(solver, sketch);
    expect(statuses(sketch, report)).toEqual({ [p1]: 'under', [p2]: 'under', [line]: 'under' });
    expect(report.entities.size).toBe(sketch.entities.length);
  });

  it('reports a fully dimensioned and fixed rectangle as fully constrained', () => {
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
    const sketch = b.build();

    const report = analyzeStatus(solver, sketch);
    expect(summary(sketch, report)).toBe('e1:F e2:F e3:F e4:F e5:F e6:F e7:F e8:F');
  });

  it('splits a horizontal line with one fixed endpoint', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    const line = b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: p1, b: p2 });
    b.fix(p1);
    const sketch = b.build();

    // p1 is pinned; p2 shares its y but slides along the line.
    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [p1]: 'fully',
      [p2]: 'under',
      [line]: 'under',
    });
  });

  it('needs a fixed radius before a circle counts as constrained', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 18);
    const onCircle = b.point(68, 60);
    b.fix(center);
    b.constrain({ kind: 'pointOnCurve', point: onCircle, curve: circle });
    const sketch = b.build();

    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [center]: 'fully',
      [circle]: 'under',
      [onCircle]: 'under',
    });
  });

  it('counts a circle with a fixed radius as fully constrained', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 18);
    b.fix(center);
    b.constrain({ kind: 'radius', curve: circle, value: 20 });
    const sketch = b.build();

    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({ [center]: 'fully', [circle]: 'fully' });
  });

  it('treats y as determined but x as free on a fixed horizontal line', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(10, 0);
    const line = b.line(a, c);
    b.constrain({ kind: 'horizontal', a: a, b: c });
    b.fix(a);
    const p = b.point(5, 0);
    b.constrain({ kind: 'pointOnLine', point: p, line });
    const sketch = b.build();

    // The point sits on a line that is pinned in y but free in x.
    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [a]: 'fully',
      [c]: 'under',
      [line]: 'under',
      [p]: 'under',
    });
  });

  it('reports both points of a fixed-distance pair as under-constrained', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 10 });
    const sketch = b.build();

    // Nothing grounds the pair, so the whole shape can still drift.
    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({ [p1]: 'under', [p2]: 'under' });
  });

  it('handles a free arc', () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.point(10, 0);
    const e = b.point(0, 12);
    const arc = b.arc(c, s, e);
    const sketch = b.build();

    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [c]: 'under',
      [s]: 'under',
      [e]: 'under',
      [arc]: 'under',
    });
  });

  it('reports a fully constrained arc', () => {
    const b = new SketchBuilder();
    const c = b.point(0, 0);
    const s = b.point(10, 0);
    const e = b.point(0, 12);
    const arc = b.arc(c, s, e);
    b.fix(c);
    b.fix(s);
    b.constrain({ kind: 'radius', curve: arc, value: 10 });
    b.constrain({ kind: 'distance', a: s, b: e, value: Math.hypot(10, 12) });
    const sketch = b.build();

    // Center and start are pinned, the radius and the chord are dimensioned,
    // which leaves the end point on the arc's circle nowhere to go.
    expect(solver.solve(sketch).dof).toBe(0);
    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [c]: 'fully',
      [s]: 'fully',
      [e]: 'fully',
      [arc]: 'fully',
    });
  });

  it('takes the zero-DOF shortcut', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 1);
    const line = b.line(p1, p2);
    b.fix(p1);
    b.fix(p2);
    const sketch = b.build();

    // The sketch is fully constrained, so everything is 'fully' without probing.
    expect(solver.solve(sketch).dof).toBe(0);
    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [p1]: 'fully',
      [p2]: 'fully',
      [line]: 'fully',
    });
  });

  it('reports everything as under-constrained when constraints conflict', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 1);
    const line = b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: line });
    b.constrain({ kind: 'vertical', a: line });
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 50 });
    const sketch = b.build();

    expect(solver.solve(sketch).outcome).toBe('failed');
    const report = analyzeStatus(solver, sketch);
    expect([...report.entities.values()].every((s) => s === 'under')).toBe(true);
  });

  it('does not mutate the sketch and leaves the solver usable', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    const line = b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: p1, b: p2 });
    b.fix(p1);
    const sketch = b.build();
    const frozen = JSON.stringify(sketch);

    const before = solver.solve(sketch);
    analyzeStatus(solver, sketch);
    const after = solver.solve(sketch);

    expect(JSON.stringify(sketch)).toBe(frozen);
    expect(after.outcome).toBe(before.outcome);
    expect(after.dof).toBe(before.dof);
    expect(point(after.sketch, p2).x).toBeCloseTo(point(before.sketch, p2).x, 12);
    expect(point(after.sketch, p2).y).toBeCloseTo(point(before.sketch, p2).y, 12);
    expect(entity(after.sketch, line)).toEqual(entity(before.sketch, line));
  });

  it('leaves the solver usable after probing a solved sketch', () => {
    // The solved sketch is what the UI hands over, and probing it must not
    // disturb later solves at all.
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: p1, b: p2 });
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 10 });
    b.fix(p1);
    const solved = solver.solve(b.build()).sketch;
    const before = solver.solve(solved);
    analyzeStatus(solver, solved);
    const after = solver.solve(solved);

    expect(after.outcome).toBe(before.outcome);
    expect(after.dof).toBe(before.dof);
    expect(after.sketch.constraints).toEqual(before.sketch.constraints);
    expect(after.sketch.params).toEqual(before.sketch.params);
    expect(after.sketch.entities).toHaveLength(before.sketch.entities.length);
    for (const [i, e] of after.sketch.entities.entries()) {
      const other = before.sketch.entities[i]!;
      expect(e.kind).toBe(other.kind);
      expect(e.id).toBe(other.id);
      if (e.kind === 'point' && other.kind === 'point') {
        expect(e.x).toBeCloseTo(other.x, 10);
        expect(e.y).toBeCloseTo(other.y, 10);
      } else {
        expect(e).toEqual(other);
      }
    }
  });

  it('leaves the solver usable after probing an unsolved sketch', () => {
    // A sketch that is still under-constrained: probing it must not disturb
    // later solves either.
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 1);
    b.line(p1, p2);
    b.constrain({ kind: 'horizontal', a: p1, b: p2 });
    b.fix(p1);
    const sketch = b.build();
    const before = solver.solve(sketch);
    const report = analyzeStatus(solver, sketch);
    const after = solver.solve(sketch);

    expect(after.outcome).toBe(before.outcome);
    expect(after.dof).toBe(before.dof);
    expect(report.entities.size).toBe(sketch.entities.length);
    for (const e of sketch.entities) {
      if (e.kind !== 'point') continue;
      expect(Math.abs(point(after.sketch, e.id).x - point(before.sketch, e.id).x)).toBeLessThan(1);
      expect(Math.abs(point(after.sketch, e.id).y - point(before.sketch, e.id).y)).toBeLessThan(1);
    }
  });

  it('keeps independent components independent', () => {
    const { sketch, cell } = grid(3, 3);
    const report = analyzeStatus(solver, sketch);
    const s = statuses(sketch, report);
    // Cell (0,0): (c+r)%3 === 0 → fully constrained.
    expect(cell(0, 0).every((id) => s[id] === 'fully')).toBe(true);
    // Cell (1,0): (c+r)%3 === 1 → height missing, so the far corners slide.
    expect(s[cell(1, 0)[0]!]).toBe('fully');
    expect(s[cell(1, 0)[2]!]).toBe('under');
    // Cell (2,0): (c+r)%3 === 2 → completely free.
    expect(cell(2, 0).every((id) => s[id] === 'under')).toBe(true);
    expect(report.entities.size).toBe(sketch.entities.length);
    expect([...report.entities.values()].some((v) => v === 'fully')).toBe(true);
  });

  it('derives unconstrained geometry from its points', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(10, 0);
    const line = b.line(p1, p2);
    b.fix(p1);
    b.fix(p2);
    const sketch = b.build();

    // No constraint mentions the line, yet both its endpoints are pinned.
    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [p1]: 'fully',
      [p2]: 'fully',
      [line]: 'fully',
    });
  });

  it('treats a circle with no constraints on it as under-constrained', () => {
    const b = new SketchBuilder();
    const center = b.point(10, 10);
    const circle = b.circle(center, 5);
    b.fix(center);
    const sketch = b.build();

    // The centre is pinned but nothing pins the radius.
    expect(statuses(sketch, analyzeStatus(solver, sketch))).toEqual({
      [center]: 'fully',
      [circle]: 'under',
    });
  });

  it('splits a polyline grid into its constrained rows', () => {
    const b = new SketchBuilder();
    const rows = 4;
    const columns = 5;
    const node: Id[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) node.push(b.point(c * 30 + r * 2, r * 30));
    }
    const at = (r: number, c: number): Id => node[r * columns + c]!;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        if (c + 1 < columns) b.constrain({ kind: 'horizontal', a: b.line(at(r, c), at(r, c + 1)) });
        // Unconstrained segment down to the next row: it must not glue the
        // rows into one system.
        if (r + 1 < rows) b.line(at(r, c), at(r + 1, c));
      }
    }
    b.fix(at(0, 0));
    b.fix(at(0, columns - 1));
    const sketch = b.build();
    const s = statuses(sketch, analyzeStatus(solver, sketch));

    // The first row is pinned at both ends, so every point on it has a fixed y
    // and its two ends are fixed outright.
    expect(s[at(0, 0)]).toBe('fully');
    expect(s[at(0, columns - 1)]).toBe('fully');
    for (let c = 1; c < columns - 1; c++) expect(s[at(0, c)]).toBe('under');
    // Later rows slide freely in both directions.
    for (let r = 1; r < rows; r++) {
      for (let c = 0; c < columns; c++) expect(s[at(r, c)]).toBe('under');
    }
  });
});
