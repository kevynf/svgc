import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { distance } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Sketch } from '../core/sketch';
import type { ConstraintPlacement } from './constraints';
import { constraintPlacements, hitConstraint } from './constraints';

/** Offsets are screen px, so a world→screen map with no panning is enough. */
const toScreen = (scale: number) => (p: Vec2) => ({ x: p.x * scale, y: p.y * scale });

const at = (placements: readonly ConstraintPlacement[], id: string): Vec2 =>
  placements.find((p) => p.constraint === id)?.at ?? { x: NaN, y: NaN };

/** One placement per constraint id, so a missing symbol shows up as NaN. */
const index = (placements: readonly ConstraintPlacement[]): Record<string, Vec2> =>
  Object.fromEntries(placements.map((p) => [p.constraint, p.at]));

describe('constraintPlacements', () => {
  it('puts horizontal on the line midpoint, 14px above it', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const line = b.line(p1, p2);
    const h = b.constrain({ kind: 'horizontal', a: line });

    expect(at(constraintPlacements(b.build(), 1), h)).toEqual({ x: 50, y: -14 });
  });

  it('puts vertical to the right of the line midpoint', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(0, 100);
    const line = b.line(p1, p2);
    const v = b.constrain({ kind: 'vertical', a: line });

    expect(at(constraintPlacements(b.build(), 1), v)).toEqual({ x: 14, y: 50 });
  });

  it('keeps the offset 14 screen px from the geometry at any zoom', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const line = b.line(p1, p2);
    const h = b.constrain({ kind: 'horizontal', a: line });
    const sketch = b.build();
    const mid = { x: 50, y: 0 };

    for (const scale of [0.25, 0.5, 1, 2, 8]) {
      const s = toScreen(scale);
      const screen = s(at(constraintPlacements(sketch, scale), h));
      expect(distance(s(mid), screen)).toBeCloseTo(14, 9);
    }
  });

  it('offsets equal the other way from horizontal on the same line', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const line = b.line(p1, p2);
    const h = b.constrain({ kind: 'horizontal', a: line });
    const eq = b.constrain({ kind: 'equal', a: line, b: line });

    const found = index(constraintPlacements(b.build(), 1));
    expect(found[h]).toEqual({ x: 50, y: -14 });
    expect(found[eq]).toEqual({ x: 50, y: 14 });
  });

  it('puts parallel and perpendicular on the midpoint of the first referenced line', () => {
    const b = new SketchBuilder();
    const a1 = b.point(0, 0);
    const a2 = b.point(100, 0);
    const b1 = b.point(0, 50);
    const b2 = b.point(100, 50);
    const first = b.line(a1, a2);
    const second = b.line(b1, b2);
    const par = b.constrain({ kind: 'parallel', a: first, b: second });
    const perp = b.constrain({ kind: 'perpendicular', a: second, b: first });

    const found = index(constraintPlacements(b.build(), 1));
    expect(found[par]).toEqual({ x: 50, y: 0 });
    expect(found[perp]).toEqual({ x: 50, y: 50 });
  });

  it('puts tangent where a line and a circle touch', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 50);
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const line = b.line(p1, p2);
    const tan = b.constrain({ kind: 'tangent', a: line, b: circle });

    expect(at(constraintPlacements(b.build(), 1), tan)).toEqual({ x: 50, y: 0 });
  });

  it('puts tangent on the shared endpoint of a line and an arc', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(10, 0);
    const end = b.point(0, 10);
    const arc = b.arc(center, start, end);
    const far = b.point(20, 0);
    const line = b.line(start, far);
    const tan = b.constrain({ kind: 'tangent', a: line, b: arc });

    expect(at(constraintPlacements(b.build(), 1), tan)).toEqual({ x: 10, y: 0 });
  });

  it('puts tangent on the line through the centers of two circles', () => {
    const b = new SketchBuilder();
    const c1 = b.point(0, 0);
    const c2 = b.point(30, 0);
    const left = b.circle(c1, 10);
    const right = b.circle(c2, 5);
    const tan = b.constrain({ kind: 'tangent', a: left, b: right });

    expect(at(constraintPlacements(b.build(), 1), tan)).toEqual({ x: 10, y: 0 });
  });

  it('falls back to the nearest arc endpoint when the touch point is off the arc', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(10, 0);
    const end = b.point(0, 10);
    const arc = b.arc(center, start, end);
    const p1 = b.point(-50, -5);
    const p2 = b.point(50, -5);
    const line = b.line(p1, p2);
    const tan = b.constrain({ kind: 'tangent', a: line, b: arc });

    expect(at(constraintPlacements(b.build(), 1), tan)).toEqual({ x: 10, y: 0 });
  });

  it('puts equal on an arc at mid-sweep, pushed radially outward', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(10, 0);
    const end = b.point(0, 10);
    const arc = b.arc(center, start, end);
    const other = b.point(100, 100);
    const circle = b.circle(other, 10);
    const eq = b.constrain({ kind: 'equal', a: arc, b: circle });

    const found = at(constraintPlacements(b.build(), 1), eq);
    // Mid-sweep at 45° on r=10, then 14px further out along the same radius.
    expect(found.x).toBeCloseTo(10 * Math.SQRT1_2 + 14 * Math.SQRT1_2, 9);
    expect(found.y).toBeCloseTo(found.x, 9);
  });

  it('puts equal on a circle above it', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 40);
    const p1 = b.point(0, 200);
    const p2 = b.point(100, 200);
    const line = b.line(p1, p2);
    const eq = b.constrain({ kind: 'equal', a: circle, b: line });

    expect(at(constraintPlacements(b.build(), 1), eq)).toEqual({ x: 50, y: -4 });
  });

  it('puts pointOnLine, pointOnCurve and midpoint on the point', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const line = b.line(p1, p2);
    const center = b.point(50, 50);
    const circle = b.circle(center, 40);
    const on = b.point(50, 20);
    const mid = b.point(50, 0);
    const onCurve = b.point(90, 50);
    const c1 = b.constrain({ kind: 'pointOnLine', point: on, line });
    const c2 = b.constrain({ kind: 'midpoint', point: mid, line });
    const c3 = b.constrain({ kind: 'pointOnCurve', point: onCurve, curve: circle });

    const found = index(constraintPlacements(b.build(), 1));
    expect(found[c1]).toEqual({ x: 50, y: 20 });
    expect(found[c2]).toEqual({ x: 50, y: 0 });
    expect(found[c3]).toEqual({ x: 90, y: 50 });
  });

  it('puts fix up and right of the point', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const fix = b.constrain({ kind: 'fix', point: p, x: 0, y: 0 });

    expect(at(constraintPlacements(b.build(), 1), fix)).toEqual({ x: 10, y: -10 });
  });

  it('puts coincident on the shared point', () => {
    const b = new SketchBuilder();
    const a = b.point(30, 40);
    const c = b.point(30, 40);
    const coin = b.constrain({ kind: 'coincident', a, b: c });

    expect(at(constraintPlacements(b.build(), 1), coin)).toEqual({ x: 30, y: 40 });
  });

  it('offsets coincident constraints that share a point so both stay visible', () => {
    const b = new SketchBuilder();
    const a = b.point(30, 40);
    const c = b.point(30, 40);
    const d = b.point(30, 40);
    const first = b.constrain({ kind: 'coincident', a, b: c });
    const second = b.constrain({ kind: 'coincident', a, b: d });

    const found = index(constraintPlacements(b.build(), 1));
    const apart = distance(toScreen(1)(found[first]!), toScreen(1)(found[second]!));
    expect(apart).toBeGreaterThanOrEqual(18);
    expect(apart).toBeLessThanOrEqual(40);
  });

  it('places distance, radius and angle at their value text', () => {
    const b = new SketchBuilder();
    const pa = b.point(10, 10);
    const pb = b.point(10, 10);
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const p3 = b.point(100, 100);
    const p4 = b.point(0, 100);
    const center = b.point(50, 50);
    const on = b.point(50, 20);
    const mid = b.point(50, 0);
    const onCurve = b.point(90, 50);
    const l1 = b.line(p1, p2);
    const l2 = b.line(p3, p4);
    const l3 = b.line(p2, p3);
    const circle = b.circle(center, 40);

    b.constrain({ kind: 'coincident', a: pa, b: pb });
    b.constrain({ kind: 'fix', point: pa, x: 10, y: 10 });
    b.constrain({ kind: 'horizontal', a: l1 });
    b.constrain({ kind: 'vertical', a: l3 });
    b.constrain({ kind: 'parallel', a: l1, b: l2 });
    b.constrain({ kind: 'perpendicular', a: l3, b: l1 });
    b.constrain({ kind: 'equal', a: l1, b: l3 });
    b.constrain({ kind: 'tangent', a: l1, b: circle });
    b.constrain({ kind: 'pointOnLine', point: on, line: l1 });
    b.constrain({ kind: 'pointOnCurve', point: onCurve, curve: circle });
    b.constrain({ kind: 'midpoint', point: mid, line: l1 });
    b.constrain({ kind: 'distance', a: p1, b: p4, value: 100 });
    b.constrain({ kind: 'radius', curve: circle, value: 40 });
    b.constrain({ kind: 'angle', a: l1, b: l3, value: 90 });

    const placements = constraintPlacements(b.build(), 1);
    expect(placements).toHaveLength(14);
    expect(placements.map((p) => p.glyph).sort()).toEqual(
      [
        'coincident', 'fix', 'horizontal', 'vertical', 'parallel', 'perpendicular',
        'equal', 'tangent', 'pointOnLine', 'pointOnCurve', 'midpoint',
        'distance', 'radius', 'angle',
      ].sort(),
    );
    for (const p of placements) {
      expect(Number.isFinite(p.at.x) && Number.isFinite(p.at.y)).toBe(true);
      expect(p.refs.length).toBeGreaterThan(0);
    }
  });

  /**
   * One of each dimension, spread far enough apart that `separate` never nudges
   * them: a point-to-point distance, a circle radius and a right angle.
   */
  function dimensionSketch(): { sketch: Sketch; d: string; r: string; g: string } {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const center = b.point(300, 50);
    const circle = b.circle(center, 40);
    const v = b.point(0, 200);
    const right = b.point(100, 200);
    const down = b.point(0, 300);
    const lineA = b.line(v, right);
    const lineB = b.line(v, down);
    const d = b.constrain({ kind: 'distance', a: p1, b: p2, value: 100 });
    const r = b.constrain({ kind: 'radius', curve: circle, value: 40 });
    const g = b.constrain({ kind: 'angle', a: lineA, b: lineB, value: 90 });
    return { sketch: b.build(), d, r, g };
  }

  it('anchors each dimension symbol at its value text', () => {
    const { sketch, d, r, g } = dimensionSketch();

    const placements = constraintPlacements(sketch, 1);
    expect(placements).toHaveLength(3);
    expect(placements.map((p) => p.glyph).sort()).toEqual(['angle', 'distance', 'radius']);
    for (const p of placements) {
      expect(Number.isFinite(p.at.x) && Number.isFinite(p.at.y)).toBe(true);
      expect(p.refs.length).toBeGreaterThan(0);
    }

    const found = index(placements);
    // The dimension line runs 14px off the two points, so its middle is the value.
    expect(found[d]).toEqual({ x: 50, y: -14 });
    // The leader runs out past the top of the circle to where the value sits.
    expect(found[r]).toEqual({ x: 300, y: -12 });
    // The value sits on the bisector, 30 + 8 px from the vertex.
    expect(found[g]!.x).toBeCloseTo(38 * Math.SQRT1_2, 9);
    expect(found[g]!.y).toBeCloseTo(200 + 38 * Math.SQRT1_2, 9);
  });

  it('keeps a dimension symbol a fixed number of screen px from its geometry', () => {
    const { sketch, d, r, g } = dimensionSketch();
    const mid = { x: 50, y: 0 };
    const onCurve = { x: 300, y: 10 };
    const vertex = { x: 0, y: 200 };

    for (const scale of [0.25, 0.5, 1, 2, 8]) {
      const s = toScreen(scale);
      const found = index(constraintPlacements(sketch, scale));
      // Distance: 14px off the measured points, as every other symbol is.
      expect(distance(s(mid), s(found[d]!))).toBeCloseTo(14, 9);
      // Radius: the leader runs 14px past the curve, the value 8px beyond that.
      expect(distance(s(onCurve), s(found[r]!))).toBeCloseTo(14 + 8, 9);
      // Angle: 8px beyond the 30px arc.
      expect(distance(s(vertex), s(found[g]!))).toBeCloseTo(30 + 8, 9);
    }
  });

  /**
   * A dimension's pick point is the value text the renderer draws, so `separate`
   * pins it: the chips around it are the ones that give way. Both directions
   * matter — a chip arriving after the dimension is nudged off the text, and a
   * dimension arriving after a chip holds its anchor instead of being nudged.
   */
  it('nudges a glyph chip off a dimension value text', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const d = b.constrain({ kind: 'distance', a: p1, b: p2, value: 100 });
    // A coincident pair whose symbol lands exactly on the distance's value text.
    const q1 = b.point(50, -14);
    const q2 = b.point(50, -14);
    const coin = b.constrain({ kind: 'coincident', a: q1, b: q2 });

    const found = index(constraintPlacements(b.build(), 1));
    // The dimension holds the text position; the chip is the one that gives way.
    expect(found[d]).toEqual({ x: 50, y: -14 });
    expect(found[coin]).not.toEqual({ x: 50, y: -14 });
    expect(distance(found[d]!, found[coin]!)).toBeGreaterThanOrEqual(20);
  });

  it('keeps a dimension on its value text when a glyph chip is already there', () => {
    const b = new SketchBuilder();
    // The chip is placed first, so it is the one a nudge would have to move —
    // and the dimension arriving second is the one that used to be nudged off.
    const q1 = b.point(50, -14);
    const q2 = b.point(50, -14);
    const coin = b.constrain({ kind: 'coincident', a: q1, b: q2 });
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const d = b.constrain({ kind: 'distance', a: p1, b: p2, value: 100 });

    const found = index(constraintPlacements(b.build(), 1));
    expect(found[coin]).toEqual({ x: 50, y: -14 });
    // The pick point stays on the text the user reads, chip or no chip.
    expect(found[d]).toEqual({ x: 50, y: -14 });
  });

  it('keeps two colliding dimensions at their own anchors', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 0);
    const d = b.constrain({ kind: 'distance', a: p1, b: p2, value: 100 });
    // A radius whose value text lands 10px from the distance's, well inside the gap.
    const center = b.point(50, 8);
    const circle = b.circle(center, 10);
    const r = b.constrain({ kind: 'radius', curve: circle, value: 10 });

    const found = index(constraintPlacements(b.build(), 1));
    expect(distance(found[d]!, found[r]!)).toBeLessThan(20);
    expect(found[d]).toEqual({ x: 50, y: -14 });
    // The leader runs 14px past the curve, the value 8px beyond that: 10 + 22 above the centre.
    expect(found[r]).toEqual({ x: 50, y: -24 });
  });

  it('skips a dimension whose geometry cannot carry one', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const degenerate = b.circle(center, 0);
    const p1 = b.point(5, 5);
    const p2 = b.point(5, 5);
    b.constrain({ kind: 'radius', curve: degenerate, value: 0 });
    b.constrain({ kind: 'distance', a: p1, b: p2, value: 0 });

    expect(constraintPlacements(b.build(), 1)).toEqual([]);
  });

  it('skips a dimension whose entity is missing from the sketch', () => {
    const b = new SketchBuilder();
    b.constrain({ kind: 'distance', a: 'ghost', b: 'gone', value: 10 });
    b.constrain({ kind: 'radius', curve: 'ghost', value: 10 });
    b.constrain({ kind: 'angle', a: 'ghost', b: 'gone', value: 90 });

    expect(constraintPlacements(b.build(), 1)).toEqual([]);
  });

  it('restricts to constraints referencing the given entities', () => {
    const b = new SketchBuilder();
    const a1 = b.point(0, 0);
    const a2 = b.point(100, 0);
    const b1 = b.point(0, 50);
    const b2 = b.point(100, 50);
    const first = b.line(a1, a2);
    const second = b.line(b1, b2);
    const h = b.constrain({ kind: 'horizontal', a: first });
    const v = b.constrain({ kind: 'horizontal', a: second });
    const pair = b.constrain({ kind: 'horizontal', a: a1, b: a2 });
    const sketch = b.build();

    expect(constraintPlacements(sketch, 1, { only: new Set([first]) }).map((p) => p.constraint)).toEqual([h]);
    expect(constraintPlacements(sketch, 1, { only: new Set([second]) }).map((p) => p.constraint)).toEqual([v]);
    // A point-to-point horizontal refers to its two points, not the line.
    expect(constraintPlacements(sketch, 1, { only: new Set([a2]) }).map((p) => p.constraint)).toEqual([pair]);
    expect(constraintPlacements(sketch, 1, { only: new Set(['nope']) })).toEqual([]);
    expect(constraintPlacements(sketch, 1)).toHaveLength(3);
  });
});

describe('hitConstraint', () => {
  const b = new SketchBuilder();
  const p1 = b.point(0, 0);
  const p2 = b.point(100, 0);
  const line = b.line(p1, p2);
  const h = b.constrain({ kind: 'horizontal', a: line });
  const p3 = b.point(0, 50);
  const p4 = b.point(100, 50);
  const other = b.line(p3, p4);
  const h2 = b.constrain({ kind: 'horizontal', a: other });
  const placements = constraintPlacements(b.build(), 1);

  it('hits the symbol under the point', () => {
    expect(hitConstraint(placements, { x: 50, y: -14 }, 5)).toBe(h);
    expect(hitConstraint(placements, { x: 50, y: 36 }, 5)).toBe(h2);
  });

  it('misses outside the tolerance', () => {
    expect(hitConstraint(placements, { x: 50, y: -10 }, 3)).toBeUndefined();
    expect(hitConstraint(placements, { x: 0, y: 0 }, 5)).toBeUndefined();
    expect(hitConstraint(placements, { x: 500, y: 500 }, 50)).toBeUndefined();
  });

  it('returns the nearest symbol when two are in range', () => {
    expect(hitConstraint(placements, { x: 50, y: -10 }, 20)).toBe(h);
    expect(hitConstraint(placements, { x: 50, y: 40 }, 20)).toBe(h2);
  });
});
