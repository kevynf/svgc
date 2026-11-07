import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { distance, midpoint, perpendicularDistance } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Constraint, Line } from '../core/model';
import { indexEntities } from '../core/sketch';
import type { EntityIndex, Sketch } from '../core/sketch';
import type { DimensionArrow, DimensionArc, DimensionLayout } from './dimensions';
import { DIMENSION_KINDS, dimensionLayout, isDimensionKind } from './dimensions';

/** Offsets are screen px, so a world→screen map with no panning is enough. */
const toScreen = (scale: number) => (p: Vec2) => ({ x: p.x * scale, y: p.y * scale });

/** The zooms a dimension has to keep its on-screen distance from the geometry at. */
const SCALES = [0.25, 0.5, 1, 2, 8];

/** The constraint object for a builder id, so it can be handed to `dimensionLayout`. */
function constraintAt(sketch: Sketch, id: string): Constraint {
  const c = sketch.constraints.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no constraint "${id}"`);
  return c;
}

/** Fails loudly rather than yielding NaN, so a missing layout shows up as a throw. */
function layoutOf(c: Constraint, index: EntityIndex, scale: number): DimensionLayout {
  const layout = dimensionLayout(c, index, scale);
  if (layout === undefined) throw new Error(`no layout for a ${c.kind} constraint`);
  return layout;
}

/** World position of a point entity, so tests can measure against the geometry. */
function at(index: EntityIndex, id: string): Vec2 {
  const e = index.get(id);
  if (e?.kind !== 'point') throw new Error(`"${id}" is not a point`);
  return { x: e.x, y: e.y };
}

/** The dimension line: the first line every layout draws. */
function firstLine(layout: DimensionLayout): readonly [Vec2, Vec2] {
  const line = layout.lines[0];
  if (line === undefined) throw new Error('no dimension line');
  return line;
}

/** The far end of the witness line that touches `p`. */
function witnessEnd(lines: readonly (readonly [Vec2, Vec2])[], p: Vec2): Vec2 {
  const line = lines.find(([a, b]) => distance(a, p) < 1e-9 || distance(b, p) < 1e-9);
  if (line === undefined) throw new Error(`no line touches ${p.x},${p.y}`);
  return distance(line[0], p) < 1e-9 ? line[1] : line[0];
}

/** The arrowhead nearest a point, for picking one end of a two-arrow dimension. */
function arrowNear(layout: DimensionLayout, p: Vec2): DimensionArrow {
  let best = layout.arrows[0];
  if (best === undefined) throw new Error('no arrowheads');
  for (const arrow of layout.arrows) {
    if (distance(arrow.at, p) < distance(best.at, p)) best = arrow;
  }
  return best;
}

/** The only arrowhead, for the kinds that draw a single one. */
function soleArrow(layout: DimensionLayout): DimensionArrow {
  const arrow = layout.arrows[0];
  if (arrow === undefined) throw new Error('no arrowheads');
  return arrow;
}

/** The arc, for the one kind that draws it. */
function soleArc(layout: DimensionLayout): DimensionArc {
  const { arc } = layout;
  if (arc === undefined) throw new Error('no arc');
  return arc;
}

/** The point on an arc at `angle`. */
function arcPoint(arc: DimensionArc, angle: number): Vec2 {
  return { x: arc.center.x + arc.radius * Math.cos(angle), y: arc.center.y + arc.radius * Math.sin(angle) };
}

/** Screen direction from one point to another, in atan2 radians (Y pointing down). */
function dir(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** The angle between two directions, in [0, π], so wrapping never matters. */
function between(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

/** Every point a renderer would draw. */
function drawnPoints(layout: DimensionLayout): Vec2[] {
  return [
    layout.textAt,
    ...layout.lines.flatMap(([a, b]) => [a, b]),
    ...layout.arrows.map((arrow) => arrow.at),
  ];
}

/** Every coordinate the renderer touches has to be a real number. */
function expectFinite(layout: DimensionLayout): void {
  for (const p of drawnPoints(layout)) {
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  }
  for (const arrow of layout.arrows) expect(Number.isFinite(arrow.angle)).toBe(true);
  if (layout.arc !== undefined) {
    expect(Number.isFinite(layout.arc.radius)).toBe(true);
    expect(Number.isFinite(layout.arc.startAngle)).toBe(true);
    expect(Number.isFinite(layout.arc.endAngle)).toBe(true);
  }
}

describe('dimensionLayout', () => {
  describe('distance between two points', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(100, 40);
    const d = b.constrain({ kind: 'distance', a: p1, b: p2, value: 100 });
    const sketch = b.build();
    const index = indexEntities(sketch);
    const constraint = constraintAt(sketch, d);
    const a = at(index, p1);
    const c = at(index, p2);
    const mid = midpoint(a, c);

    it('draws finite coordinates at every zoom', () => {
      for (const scale of SCALES) expectFinite(layoutOf(constraint, index, scale));
    });

    it('runs the dimension line parallel to the two points, 14px off them', () => {
      const s = toScreen(1);
      const layout = layoutOf(constraint, index, 1);
      const [start, end] = firstLine(layout);
      expect(between(dir(s(start), s(end)), dir(s(a), s(c)))).toBeCloseTo(0, 9);
      expect(perpendicularDistance(s(mid), s(start), s(end))).toBeCloseTo(14, 9);
    });

    it('reaches 10px past each projection', () => {
      const s = toScreen(1);
      const layout = layoutOf(constraint, index, 1);
      const [start, end] = firstLine(layout);
      expect(distance(s(start), s(end))).toBeCloseTo(distance(a, c) + 2 * 10, 9);
    });

    it('drops a witness line from each point, overshooting the dimension line', () => {
      const s = toScreen(1);
      const layout = layoutOf(constraint, index, 1);
      for (const p of [a, c]) {
        expect(distance(s(p), s(witnessEnd(layout.lines, p)))).toBeCloseTo(14 + 2, 9);
      }
    });

    it('points the two arrowheads away from each other', () => {
      const layout = layoutOf(constraint, index, 1);
      const atA = arrowNear(layout, a);
      const atC = arrowNear(layout, c);
      expect(between(atA.angle, atC.angle)).toBeCloseTo(Math.PI, 9);
      const away = dir(atC.at, atA.at);
      expect(between(atA.angle, away)).toBeCloseTo(0, 9);
      expect(between(atC.angle, away)).toBeCloseTo(Math.PI, 9);
    });

    it('draws a dimension line, a witness line per point and two arrowheads', () => {
      const layout = layoutOf(constraint, index, 1);
      expect(layout.lines).toHaveLength(3);
      expect(layout.arrows).toHaveLength(2);
      expect(layout.arc).toBeUndefined();
    });

    it('keeps the value 14 screen px off the geometry at any zoom', () => {
      for (const scale of SCALES) {
        const s = toScreen(scale);
        const layout = layoutOf(constraint, index, scale);
        const [start, end] = firstLine(layout);
        expect(distance(s(mid), s(layout.textAt))).toBeCloseTo(14, 9);
        expect(perpendicularDistance(s(mid), s(start), s(end))).toBeCloseTo(14, 9);
      }
    });
  });

  describe('distance from a point to a line', () => {
    const b = new SketchBuilder();
    const l1 = b.point(0, 0);
    const l2 = b.point(100, 0);
    const line = b.line(l1, l2);
    const p = b.point(50, 40);
    const d = b.constrain({ kind: 'distance', a: p, b: line, value: 40 });
    const flipped = b.constrain({ kind: 'distance', a: line, b: p, value: 40 });
    const sketch = b.build();
    const index = indexEntities(sketch);
    const constraint = constraintAt(sketch, d);
    const point = at(index, p);
    const from = at(index, l1);
    const to = at(index, l2);

    it('draws finite coordinates at every zoom', () => {
      for (const scale of SCALES) expectFinite(layoutOf(constraint, index, scale));
    });

    it('runs the dimension line perpendicular to the line, as long as the gap', () => {
      for (const scale of SCALES) {
        const s = toScreen(scale);
        const layout = layoutOf(constraint, index, scale);
        const [start, end] = firstLine(layout);
        expect(between(dir(s(start), s(end)), dir(s(from), s(to)))).toBeCloseTo(Math.PI / 2, 9);
        expect(distance(s(start), s(end))).toBeCloseTo(perpendicularDistance(point, from, to) * scale, 9);
      }
    });

    it('shifts both ends along the line so the dimension clears the point', () => {
      for (const scale of SCALES) {
        const s = toScreen(scale);
        const layout = layoutOf(constraint, index, scale);
        const [start, end] = firstLine(layout);
        // The near end sits OFFSET_PX off the point, measured across itself.
        expect(distance(s(point), s(start))).toBeCloseTo(14, 9);
        expect(perpendicularDistance(s(point), s(start), s(end))).toBeCloseTo(14, 9);
        // The far end is nudged along the line, so it stays on the infinite line.
        expect(perpendicularDistance(s(end), s(from), s(to))).toBeCloseTo(0, 9);
      }
    });

    it('joins the point to its shifted end with a witness line', () => {
      const s = toScreen(1);
      const layout = layoutOf(constraint, index, 1);
      const far = witnessEnd(layout.lines, point);
      expect(distance(s(point), s(far))).toBeCloseTo(14, 9);
      expect(between(dir(s(point), s(far)), dir(s(from), s(to)))).toBeCloseTo(0, 9);
    });

    it('draws a dimension line, one witness line and two arrowheads', () => {
      const layout = layoutOf(constraint, index, 1);
      expect(layout.lines).toHaveLength(2);
      expect(layout.arrows).toHaveLength(2);
      expect(layout.arc).toBeUndefined();
    });

    it('points the two arrowheads outward along the gap', () => {
      const s = toScreen(1);
      const layout = layoutOf(constraint, index, 1);
      const [pointEnd, footEnd] = firstLine(layout);
      const atPoint = arrowNear(layout, pointEnd);
      const atFoot = arrowNear(layout, footEnd);
      // Each arrow points away from the other end, along the measured gap.
      expect(between(atPoint.angle, atFoot.angle)).toBeCloseTo(Math.PI, 9);
      expect(between(atPoint.angle, dir(s(footEnd), s(pointEnd)))).toBeCloseTo(0, 9);
      expect(between(atFoot.angle, dir(s(pointEnd), s(footEnd)))).toBeCloseTo(0, 9);
    });

    it('takes the operands in either order', () => {
      const flippedConstraint = constraintAt(sketch, flipped);
      expect(layoutOf(constraint, index, 1)).toEqual(layoutOf(flippedConstraint, index, 1));
    });
  });

  describe('radius', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 40);
    const arcCenter = b.point(0, 0);
    const arcStart = b.point(10, 0);
    const arcEnd = b.point(0, 10);
    const arc = b.arc(arcCenter, arcStart, arcEnd);
    const r = b.constrain({ kind: 'radius', curve: circle, value: 40 });
    const ra = b.constrain({ kind: 'radius', curve: arc, value: 10 });
    const sketch = b.build();
    const index = indexEntities(sketch);
    const constraint = constraintAt(sketch, r);
    const arcConstraint = constraintAt(sketch, ra);

    it('draws finite coordinates at every zoom', () => {
      for (const scale of SCALES) {
        expectFinite(layoutOf(constraint, index, scale));
        expectFinite(layoutOf(arcConstraint, index, scale));
      }
    });

    it('runs a leader from the centre through the top of a circle', () => {
      const s = toScreen(1);
      const layout = layoutOf(constraint, index, 1);
      const c = s(at(index, center));
      const [start, end] = firstLine(layout);
      // The leader passes through the centre...
      expect(perpendicularDistance(c, s(start), s(end))).toBeCloseTo(0, 9);
      // ...and the arrowhead sits on the curve at the top, pointing away from it.
      const arrow = soleArrow(layout);
      expect(distance(c, s(arrow.at))).toBeCloseTo(40, 9);
      expect(arrow.at.x).toBeCloseTo(50, 9);
      expect(arrow.at.y).toBeCloseTo(10, 9);
      expect(between(arrow.angle, dir(at(index, center), arrow.at))).toBeCloseTo(0, 9);
      expect(layout.lines).toHaveLength(1);
      expect(layout.arrows).toHaveLength(1);
      expect(layout.arc).toBeUndefined();
    });

    it('puts the value LEADER_PX + TEXT_GAP_PX beyond the curve on screen', () => {
      for (const scale of SCALES) {
        const s = toScreen(scale);
        const layout = layoutOf(constraint, index, scale);
        const arrow = soleArrow(layout);
        expect(distance(s(arrow.at), s(layout.textAt))).toBeCloseTo(14 + 8, 9);
      }
    });

    it('draws an arc radius at its mid-sweep', () => {
      const layout = layoutOf(arcConstraint, index, 1);
      const c = at(index, arcCenter);
      const arrow = soleArrow(layout);
      // The quarter arc from (10,0) to (0,10) sweeps through 45°.
      expect(between(dir(c, arrow.at), Math.PI / 4)).toBeCloseTo(0, 9);
      expect(distance(c, arrow.at)).toBeCloseTo(10, 9);
    });
  });

  describe('angle', () => {
    const b = new SketchBuilder();
    const v = b.point(0, 0);
    const right = b.point(100, 0);
    const down = b.point(0, 100);
    const lineA = b.line(v, right);
    const lineB = b.line(v, down);
    const angle = b.constrain({ kind: 'angle', a: lineA, b: lineB, value: 90 });
    const sketch = b.build();
    const index = indexEntities(sketch);
    const constraint = constraintAt(sketch, angle);
    const vertex = at(index, v);

    it('draws finite coordinates at every zoom', () => {
      for (const scale of SCALES) expectFinite(layoutOf(constraint, index, scale));
    });

    it('sweeps an arc ANGLE_RADIUS_PX wide from line a to line b', () => {
      for (const scale of SCALES) {
        const layout = layoutOf(constraint, index, scale);
        const arc = soleArc(layout);
        expect(arc.radius * scale).toBeCloseTo(30, 9);
        expect(distance(vertex, arc.center)).toBeCloseTo(0, 9);
        // From line a's direction (p1→p2, +x) round to line b's (+y), clockwise.
        expect(between(dir(vertex, arcPoint(arc, arc.startAngle)), 0)).toBeCloseTo(0, 9);
        expect(between(dir(vertex, arcPoint(arc, arc.endAngle)), Math.PI / 2)).toBeCloseTo(0, 9);
        expect(arc.endAngle - arc.startAngle).toBeCloseTo(Math.PI / 2, 9);
      }
    });

    it('puts the value on the bisector, TEXT_GAP_PX beyond the arc', () => {
      for (const scale of SCALES) {
        const s = toScreen(scale);
        const layout = layoutOf(constraint, index, scale);
        expect(distance(s(vertex), s(layout.textAt))).toBeCloseTo(30 + 8, 9);
        expect(between(dir(s(vertex), s(layout.textAt)), Math.PI / 4)).toBeCloseTo(0, 9);
      }
    });

    it('draws only the arc and two arrowheads', () => {
      const layout = layoutOf(constraint, index, 1);
      expect(layout.lines).toHaveLength(0);
      expect(layout.arrows).toHaveLength(2);
    });

    it('points both arrowheads the way the arc travels', () => {
      const layout = layoutOf(constraint, index, 1);
      const arc = soleArc(layout);
      const atStart = arrowNear(layout, arcPoint(arc, arc.startAngle));
      const atEnd = arrowNear(layout, arcPoint(arc, arc.endAngle));
      // The tangent at each end, in the clockwise direction of travel.
      const tangent = (angle: number) => Math.atan2(Math.cos(angle), -Math.sin(angle));
      expect(atStart.angle).toBeCloseTo(tangent(arc.startAngle), 9);
      expect(atEnd.angle).toBeCloseTo(tangent(arc.endAngle), 9);
      // Both point the same way round, so they differ by the arc's sweep.
      expect(between(atStart.angle, atEnd.angle)).toBeCloseTo(arc.endAngle - arc.startAngle, 9);
    });

    it('falls back to the midpoints when the lines are parallel', () => {
      const b = new SketchBuilder();
      const p1 = b.point(0, 0);
      const p2 = b.point(100, 0);
      const p3 = b.point(0, 100);
      const p4 = b.point(100, 100);
      const first = b.line(p1, p2);
      const second = b.line(p3, p4);
      const parallel = b.constrain({ kind: 'angle', a: first, b: second, value: 0 });
      const sketch = b.build();
      const layout = layoutOf(constraintAt(sketch, parallel), indexEntities(sketch), 1);
      const arc = soleArc(layout);
      expect(arc.center).toEqual({ x: 50, y: 50 });
      expect(arc.radius).toBeCloseTo(30, 9);
    });
  });

  describe('degenerate geometry', () => {
    it('returns undefined for an id missing from the index', () => {
      const b = new SketchBuilder();
      const p1 = b.point(0, 0);
      const sketch = b.build();
      const index = indexEntities(sketch);
      expect(dimensionLayout({ kind: 'distance', id: 'd', a: p1, b: 'nope', value: 10 }, index, 1)).toBeUndefined();
      expect(dimensionLayout({ kind: 'radius', id: 'r', curve: 'nope', value: 10 }, index, 1)).toBeUndefined();
      expect(dimensionLayout({ kind: 'angle', id: 'g', a: 'nope', b: 'nope', value: 90 }, index, 1)).toBeUndefined();
      // A line whose endpoints are gone has no segment to measure or meet at.
      const orphan: Line = { kind: 'line', id: 'orphan', p1: 'gone', p2: 'gone' };
      const orphanIndex = indexEntities({ ...sketch, entities: [orphan] });
      expect(dimensionLayout({ kind: 'distance', id: 'e', a: p1, b: 'orphan', value: 10 }, orphanIndex, 1)).toBeUndefined();
      expect(dimensionLayout({ kind: 'angle', id: 'g2', a: 'orphan', b: 'orphan', value: 90 }, orphanIndex, 1)).toBeUndefined();
    });

    it('still lays out a point that sits on the line', () => {
      const b = new SketchBuilder();
      const p1 = b.point(0, 0);
      const p2 = b.point(10, 0);
      const line = b.line(p1, p2);
      const on = b.point(5, 0);
      const d = b.constrain({ kind: 'distance', a: on, b: line, value: 0 });
      const sketch = b.build();
      // A zero gap is degenerate, not missing: the dimension line just has no
      // length, and the renderer decides what a zero-length line looks like.
      const layout = layoutOf(constraintAt(sketch, d), indexEntities(sketch), 1);
      expect(distance(firstLine(layout)[0], firstLine(layout)[1])).toBeCloseTo(0, 12);
      expectFinite(layout);
    });

    it('returns undefined for coincident points', () => {
      const b = new SketchBuilder();
      const p1 = b.point(5, 5);
      const p2 = b.point(5, 5);
      const d = b.constrain({ kind: 'distance', a: p1, b: p2, value: 0 });
      const sketch = b.build();
      expect(dimensionLayout(constraintAt(sketch, d), indexEntities(sketch), 1)).toBeUndefined();
    });

    it('returns undefined for a zero-length line', () => {
      const b = new SketchBuilder();
      const p1 = b.point(5, 5);
      const p2 = b.point(5, 5);
      const line = b.line(p1, p2);
      const p = b.point(20, 5);
      const other = b.point(40, 5);
      const otherLine = b.line(p, other);
      const d = b.constrain({ kind: 'distance', a: p, b: line, value: 0 });
      const g = b.constrain({ kind: 'angle', a: line, b: otherLine, value: 90 });
      const sketch = b.build();
      const index = indexEntities(sketch);
      expect(dimensionLayout(constraintAt(sketch, d), index, 1)).toBeUndefined();
      expect(dimensionLayout(constraintAt(sketch, g), index, 1)).toBeUndefined();
    });

    it('returns undefined for a zero radius', () => {
      const b = new SketchBuilder();
      const center = b.point(0, 0);
      const circle = b.circle(center, 0);
      const onCenter = b.point(0, 0);
      const arc = b.arc(center, onCenter, center);
      const r = b.constrain({ kind: 'radius', curve: circle, value: 0 });
      const ra = b.constrain({ kind: 'radius', curve: arc, value: 0 });
      const sketch = b.build();
      const index = indexEntities(sketch);
      expect(dimensionLayout(constraintAt(sketch, r), index, 1)).toBeUndefined();
      expect(dimensionLayout(constraintAt(sketch, ra), index, 1)).toBeUndefined();
    });

    it('returns undefined for operands of the wrong kind', () => {
      const b = new SketchBuilder();
      const p1 = b.point(0, 0);
      const p2 = b.point(100, 0);
      const line = b.line(p1, p2);
      const index = indexEntities(b.build());
      // A distance between two lines, a radius on a line, an angle between points.
      expect(dimensionLayout({ kind: 'distance', id: 'd', a: line, b: line, value: 10 }, index, 1)).toBeUndefined();
      expect(dimensionLayout({ kind: 'radius', id: 'r', curve: line, value: 10 }, index, 1)).toBeUndefined();
      expect(dimensionLayout({ kind: 'angle', id: 'g', a: p1, b: p2, value: 90 }, index, 1)).toBeUndefined();
      // A kind that is not a dimension has no layout either.
      expect(dimensionLayout({ kind: 'horizontal', id: 'h', a: line }, index, 1)).toBeUndefined();
    });
  });
});

describe('isDimensionKind', () => {
  it('accepts the three dimension kinds', () => {
    expect(DIMENSION_KINDS).toEqual(['distance', 'radius', 'angle']);
    for (const kind of DIMENSION_KINDS) expect(isDimensionKind(kind)).toBe(true);
  });

  it('rejects every other constraint kind', () => {
    const others = [
      'coincident', 'fix', 'horizontal', 'vertical', 'parallel', 'perpendicular',
      'equal', 'tangent', 'pointOnLine', 'pointOnCurve', 'midpoint',
    ] as const;
    for (const kind of others) expect(isDimensionKind(kind)).toBe(false);
  });
});
