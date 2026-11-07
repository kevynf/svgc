import { describe, expect, it } from 'vitest';
import { SketchBuilder } from './builder';
import { arcParams } from './geometry';
import type { Vec2 } from './geometry';
import { curveOf, extendTarget, intersections, trimTarget } from './intersect';
import type { Intersectable } from './intersect';
import type { Arc, Entity, Id, Line } from './model';
import { indexEntities } from './sketch';
import type { EntityIndex } from './sketch';

const at = (x: number, y: number): Vec2 => ({ x, y });
const line = (a: Vec2, b: Vec2): Intersectable => ({ kind: 'line', a, b });
const circle = (center: Vec2, radius: number): Intersectable => ({
  kind: 'circle',
  center,
  radius,
});
const vertical = (x: number): Intersectable => line(at(x, -50), at(x, 50));
const horizontal = (y: number): Intersectable => line(at(-50, y), at(50, y));

/** An arc the way `curveOf` builds one, with the sweep `arcParams` measures. */
const arcThrough = (center: Vec2, start: Vec2, end: Vec2): Intersectable => {
  const { radius, startAngle, endAngle } = arcParams(center, start, end);
  return { kind: 'arc', center, radius, startAngle, endAngle };
};

/** A quarter turn from +x round to +y, and a half turn from +x round to -x. */
const quarter = arcThrough(at(0, 0), at(10, 0), at(0, 10));
const half = arcThrough(at(0, 0), at(10, 0), at(-10, 0));

function expectPoints(found: readonly Vec2[], expected: readonly Vec2[]): void {
  expect(found).toHaveLength(expected.length);
  for (const [i, want] of expected.entries()) {
    expect(found[i]?.x).toBeCloseTo(want.x, 12);
    expect(found[i]?.y).toBeCloseTo(want.y, 12);
  }
}

function expectAt(found: Vec2 | undefined, expected: Vec2): void {
  expect(found).toBeDefined();
  if (found === undefined) return;
  expect(found.x).toBeCloseTo(expected.x, 12);
  expect(found.y).toBeCloseTo(expected.y, 12);
}

function entityAt(index: EntityIndex, id: Id): Entity {
  const found = index.get(id);
  if (found === undefined) throw new Error(`No entity "${id}" in the sketch`);
  return found;
}

describe('curveOf', () => {
  const b = new SketchBuilder();
  const a = b.point(0, 0);
  const c = b.point(10, 0);
  const lineId = b.line(a, c);
  const center = b.point(50, 0);
  const circleId = b.circle(center, 8);
  const arcCenter = b.point(0, 50);
  const arcStart = b.point(10, 50);
  const arcEnd = b.point(0, 60);
  const arcId = b.arc(arcCenter, arcStart, arcEnd);
  const pointId = b.point(3, 3);
  const sketch = b.build();
  const index = indexEntities(sketch);

  it('reads a line as its two endpoints', () => {
    expect(curveOf(entityAt(index, lineId), index)).toEqual({
      kind: 'line',
      a: at(0, 0),
      b: at(10, 0),
    });
  });

  it('reads a circle as its centre and radius', () => {
    expect(curveOf(entityAt(index, circleId), index)).toEqual({
      kind: 'circle',
      center: at(50, 0),
      radius: 8,
    });
  });

  it('reads an arc with the angles arcParams gives it', () => {
    expect(curveOf(entityAt(index, arcId), index)).toEqual({
      kind: 'arc',
      center: at(0, 50),
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
  });

  it('has no curve for a point', () => {
    expect(curveOf(entityAt(index, pointId), index)).toBeUndefined();
  });

  it('is undefined for a curve missing one of its points', () => {
    const orphanLine: Line = { kind: 'line', id: 'orphan-line', p1: 'gone', p2: 'gone' };
    const orphanArc: Arc = {
      kind: 'arc',
      id: 'orphan-arc',
      center: arcCenter,
      start: 'gone',
      end: 'gone',
    };
    const orphanIndex = indexEntities({
      ...sketch,
      entities: [...sketch.entities, orphanLine, orphanArc],
    });
    expect(curveOf(orphanLine, orphanIndex)).toBeUndefined();
    expect(curveOf(orphanArc, orphanIndex)).toBeUndefined();
  });

  it('is undefined for degenerate geometry', () => {
    const d = new SketchBuilder();
    const p = d.point(1, 1);
    const zeroLine = d.line(p, p);
    const zeroCircle = d.circle(p, 0);
    const zeroArc = d.arc(p, p, p);
    const degenerateIndex = indexEntities(d.build());
    expect(curveOf(entityAt(degenerateIndex, zeroLine), degenerateIndex)).toBeUndefined();
    expect(curveOf(entityAt(degenerateIndex, zeroCircle), degenerateIndex)).toBeUndefined();
    expect(curveOf(entityAt(degenerateIndex, zeroArc), degenerateIndex)).toBeUndefined();
  });

  it('gives an arc whose ends coincide a full turn', () => {
    const f = new SketchBuilder();
    const center = f.point(0, 0);
    const start = f.point(10, 0);
    const back = f.point(10, 0);
    const id = f.arc(center, start, back);
    const fullIndex = indexEntities(f.build());
    expect(curveOf(entityAt(fullIndex, id), fullIndex)).toMatchObject({
      kind: 'arc',
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI * 2,
    });
  });

  it('drives the crossing search straight off a sketch', () => {
    const s = new SketchBuilder();
    const a = s.point(0, 0);
    const c = s.point(20, 0);
    const lineId = s.line(a, c);
    const center = s.point(10, 0);
    const circleId = s.circle(center, 10);
    const sketchIndex = indexEntities(s.build());
    const read = (id: Id): Intersectable => {
      const curve = curveOf(entityAt(sketchIndex, id), sketchIndex);
      if (curve === undefined) throw new Error(`"${id}" is not a curve`);
      return curve;
    };
    expectPoints(intersections(read(lineId), read(circleId)), [at(0, 0), at(20, 0)]);
  });
});

describe('intersections', () => {
  describe('line × line', () => {
    it('crosses two infinite lines, outside both segments', () => {
      expectPoints(intersections(line(at(0, 0), at(10, 0)), vertical(20)), [at(20, 0)]);
    });

    it('is empty for parallel lines', () => {
      expect(intersections(horizontal(0), horizontal(5))).toEqual([]);
    });

    it('is empty for coincident lines, which meet everywhere', () => {
      expect(intersections(horizontal(0), horizontal(0))).toEqual([]);
    });
  });

  describe('line × circle', () => {
    it('crosses twice', () => {
      expectPoints(intersections(horizontal(0), circle(at(0, 0), 10)), [at(-10, 0), at(10, 0)]);
    });

    it('touches a tangent line once', () => {
      expectPoints(intersections(horizontal(10), circle(at(0, 0), 10)), [at(0, 10)]);
    });

    it('is empty for a line clear of the circle', () => {
      expect(intersections(horizontal(20), circle(at(0, 0), 10))).toEqual([]);
    });
  });

  describe('line × arc', () => {
    it('crosses only inside the sweep', () => {
      expectPoints(intersections(line(at(-10, -10), at(10, 10)), quarter), [
        at(5 * Math.SQRT2, 5 * Math.SQRT2),
      ]);
    });

    it('counts a crossing on the end of the sweep', () => {
      expectPoints(intersections(horizontal(0), quarter), [at(10, 0)]);
    });
  });

  describe('circle × circle', () => {
    it('crosses twice', () => {
      expectPoints(intersections(circle(at(0, 0), 10), circle(at(10, 0), 10)), [
        at(5, -Math.sqrt(75)),
        at(5, Math.sqrt(75)),
      ]);
    });

    it('touches once when tangent', () => {
      expectPoints(intersections(circle(at(0, 0), 10), circle(at(20, 0), 10)), [at(10, 0)]);
    });

    it('is empty for concentric circles', () => {
      expect(intersections(circle(at(0, 0), 10), circle(at(0, 0), 5))).toEqual([]);
      expect(intersections(circle(at(0, 0), 10), circle(at(0, 0), 10))).toEqual([]);
    });

    it('gives the same crossings whichever circle comes first', () => {
      const a = circle(at(0, 0), 10);
      const b = circle(at(10, 0), 10);
      expect(intersections(a, b)).toEqual(intersections(b, a));
    });
  });

  describe('circle × arc', () => {
    it('crosses when the tangent point is inside the sweep', () => {
      const through = arcThrough(at(20, 0), at(20, 10), at(20, -10));
      expectPoints(intersections(circle(at(0, 0), 10), through), [at(10, 0)]);
    });

    it('is empty when the tangent point is outside the sweep', () => {
      const around = arcThrough(at(20, 0), at(20, -10), at(20, 10));
      expect(intersections(circle(at(0, 0), 10), around)).toEqual([]);
    });
  });

  describe('arc × arc', () => {
    const left = arcThrough(at(0, 0), at(10, 0), at(-10, 0));
    const right = arcThrough(at(0, 10), at(-10, 10), at(10, 10));

    it('crosses where both sweeps pass', () => {
      expectPoints(intersections(left, right), [at(-Math.sqrt(75), 5), at(Math.sqrt(75), 5)]);
    });

    it('is empty when one sweep misses them both', () => {
      const other = arcThrough(at(0, 10), at(10, 10), at(-10, 10));
      expect(intersections(left, other)).toEqual([]);
    });

    it('gives the same crossings whichever arc comes first', () => {
      expect(intersections(left, right)).toEqual(intersections(right, left));
    });
  });

  describe('degenerate operands', () => {
    it('crosses nothing for a zero-length line', () => {
      const point = line(at(0, 0), at(0, 0));
      expect(intersections(point, circle(at(0, 0), 5))).toEqual([]);
      expect(intersections(circle(at(0, 0), 5), point)).toEqual([]);
    });

    it('crosses nothing for a zero radius', () => {
      expect(intersections(horizontal(0), circle(at(0, 0), 0))).toEqual([]);
      expect(intersections(quarter, circle(at(0, 0), 0))).toEqual([]);
    });
  });
});

describe('trimTarget', () => {
  const span = line(at(0, 0), at(10, 0));
  const at7 = vertical(7);
  const at3 = vertical(3);

  it('picks the nearest crossing inside the span', () => {
    expect(trimTarget(span, 'end', [at7, at3])).toEqual(at(7, 0));
    expect(trimTarget(span, 'start', [at7, at3])).toEqual(at(3, 0));
  });

  it('ignores a crossing on the endpoint itself', () => {
    expect(trimTarget(span, 'end', [vertical(10)])).toBeUndefined();
    expect(trimTarget(span, 'start', [vertical(0)])).toBeUndefined();
  });

  it('ignores crossings outside the span', () => {
    expect(trimTarget(span, 'end', [vertical(15)])).toBeUndefined();
    expect(trimTarget(span, 'start', [vertical(-5)])).toBeUndefined();
  });

  it('ignores a circle that only meets the line at its own ends', () => {
    expect(trimTarget(span, 'end', [circle(at(0, 0), 10)])).toBeUndefined();
  });

  it('ignores a crossing on an arc endpoint', () => {
    expect(trimTarget(quarter, 'end', [horizontal(10)])).toBeUndefined();
    expect(trimTarget(quarter, 'start', [horizontal(10)])).toBeUndefined();
  });

  it('picks the nearest crossing of an arc, measured along the sweep', () => {
    expectAt(trimTarget(half, 'start', [vertical(5), vertical(-5)]), at(5, Math.sqrt(75)));
    expectAt(trimTarget(half, 'end', [vertical(5), vertical(-5)]), at(-5, Math.sqrt(75)));
  });

  it('has no target on a circle, which has no ends', () => {
    expect(trimTarget(circle(at(0, 0), 10), 'end', [vertical(5)])).toBeUndefined();
    expect(trimTarget(circle(at(0, 0), 10), 'start', [vertical(5)])).toBeUndefined();
  });

  it('has no target on a degenerate curve', () => {
    expect(trimTarget(line(at(2, 2), at(2, 2)), 'end', [vertical(2)])).toBeUndefined();
  });

  it('is undefined when nothing qualifies', () => {
    expect(trimTarget(span, 'end', [])).toBeUndefined();
  });

  it('never returns the curve itself, however it is passed back', () => {
    expect(trimTarget(span, 'end', [span])).toBeUndefined();
    expect(trimTarget(span, 'start', [span, at7, at3])).toEqual(at(3, 0));
    expect(trimTarget(span, 'end', [line(at(10, 0), at(0, 0))])).toBeUndefined();
    expect(trimTarget(half, 'start', [half])).toBeUndefined();
    expect(trimTarget(half, 'end', [half])).toBeUndefined();
  });
});

describe('extendTarget', () => {
  const span = line(at(0, 0), at(10, 0));

  it('lengthens the end to the nearest crossing beyond it', () => {
    expect(extendTarget(span, 'end', [vertical(20), vertical(15)])).toEqual(at(15, 0));
  });

  it('lengthens the start the other way', () => {
    expect(extendTarget(span, 'start', [vertical(-10), vertical(-3)])).toEqual(at(-3, 0));
  });

  it('ignores a crossing on the endpoint itself', () => {
    expect(extendTarget(span, 'end', [vertical(10)])).toBeUndefined();
    expect(extendTarget(span, 'start', [vertical(0)])).toBeUndefined();
    expect(extendTarget(quarter, 'end', [horizontal(10)])).toBeUndefined();
  });

  it('ignores a crossing on the far side of the span', () => {
    expect(extendTarget(span, 'end', [vertical(-5)])).toBeUndefined();
    expect(extendTarget(span, 'start', [vertical(15)])).toBeUndefined();
  });

  it('runs an arc on past the end angle, or back before the start', () => {
    const past = line(at(-5 * Math.SQRT2, -50), at(-5 * Math.SQRT2, 50));
    expectAt(extendTarget(quarter, 'end', [past]), at(-5 * Math.SQRT2, 5 * Math.SQRT2));
    expectAt(extendTarget(quarter, 'start', [past]), at(-5 * Math.SQRT2, -5 * Math.SQRT2));
  });

  it('reaches a crossing outside the sweep from either end', () => {
    expectAt(extendTarget(quarter, 'start', [vertical(5)]), at(5, -Math.sqrt(75)));
    expectAt(extendTarget(quarter, 'end', [vertical(5)]), at(5, -Math.sqrt(75)));
  });

  it('has no target on a circle, which has no ends', () => {
    expect(extendTarget(circle(at(0, 0), 10), 'end', [vertical(5)])).toBeUndefined();
  });

  it('has no target on a degenerate curve', () => {
    expect(extendTarget(line(at(2, 2), at(2, 2)), 'end', [vertical(2)])).toBeUndefined();
  });

  it('is undefined when nothing lies beyond', () => {
    expect(extendTarget(span, 'end', [])).toBeUndefined();
    const tangent = circle(at(0, 20), 10);
    expect(extendTarget(half, 'end', [tangent])).toBeUndefined();
    expect(extendTarget(half, 'start', [tangent])).toBeUndefined();
    expectAt(trimTarget(half, 'end', [tangent]), at(0, 10));
  });

  it('never returns the curve itself, however it is passed back', () => {
    expect(extendTarget(span, 'end', [span])).toBeUndefined();
    expect(extendTarget(span, 'end', [span, vertical(15)])).toEqual(at(15, 0));
    expect(extendTarget(quarter, 'end', [quarter])).toBeUndefined();
  });
});

describe('an arc drawn all the way round', () => {
  const full = arcThrough(at(0, 0), at(10, 0), at(10, 0));

  it('trims to the nearest crossing along the full sweep', () => {
    expectAt(trimTarget(full, 'end', [vertical(5)]), at(5, -Math.sqrt(75)));
    expectAt(trimTarget(full, 'start', [vertical(5)]), at(5, Math.sqrt(75)));
  });

  it('has nothing beyond either end to extend to', () => {
    expect(extendTarget(full, 'end', [vertical(5)])).toBeUndefined();
    expect(extendTarget(full, 'start', [vertical(5)])).toBeUndefined();
  });
});
