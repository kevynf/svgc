import { describe, expect, it } from 'vitest';
import { SketchBuilder } from '../core/builder';
import { distance, midpoint, perpendicularDistance } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Constraint, Line } from '../core/model';
import { indexEntities } from '../core/sketch';
import type { EntityIndex, Sketch } from '../core/sketch';
import type { DimensionArrow, DimensionArc, DimensionLayout, DimensionSpec } from './dimensions';
import {
  DIMENSION_KINDS,
  dimensionLayout,
  dimensionText,
  isDimensionKind,
  layoutDimension,
  resolveOffset,
} from './dimensions';

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

/** Fails loudly rather than yielding NaN, so a missing layout shows up as a throw. */
function specLayout(spec: DimensionSpec, index: EntityIndex, scale: number): DimensionLayout {
  const layout = layoutDimension(spec, index, scale);
  if (layout === undefined) throw new Error(`no layout for a ${spec.kind} spec`);
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

describe('layoutDimension', () => {
  const b = new SketchBuilder();
  const p1 = b.point(0, 0);
  const p2 = b.point(100, 0);
  const pp = b.constrain({ kind: 'distance', a: p1, b: p2, value: 100 });
  const line = b.line(p1, p2);
  const p = b.point(50, 40);
  const ptl = b.constrain({ kind: 'distance', a: p, b: line, value: 40 });
  const center = b.point(50, 50);
  const circle = b.circle(center, 40);
  const radius = b.constrain({ kind: 'radius', curve: circle, value: 40 });
  const v = b.point(200, 0);
  const right = b.point(300, 0);
  const down = b.point(200, 100);
  const lineA = b.line(v, right);
  const lineB = b.line(v, down);
  const angle = b.constrain({ kind: 'angle', a: lineA, b: lineB, value: 90 });
  const arcCenter = b.point(400, 0);
  const arcStart = b.point(410, 0);
  const arcEnd = b.point(400, 10);
  const arc = b.arc(arcCenter, arcStart, arcEnd);
  const sketch = b.build();
  const index = indexEntities(sketch);

  it('lays out a spec with no placement exactly like the committed constraint', () => {
    // A spec with no cursor is the committed dimension, so every kind has to
    // agree with what `dimensionLayout` draws for the matching constraint.
    expect(specLayout({ kind: 'distance', operands: [p1, p2] }, index, 1)).toEqual(
      layoutOf(constraintAt(sketch, pp), index, 1),
    );
    expect(specLayout({ kind: 'distance', operands: [p, line] }, index, 1)).toEqual(
      layoutOf(constraintAt(sketch, ptl), index, 1),
    );
    expect(specLayout({ kind: 'radius', operands: [circle] }, index, 1)).toEqual(
      layoutOf(constraintAt(sketch, radius), index, 1),
    );
    expect(specLayout({ kind: 'angle', operands: [lineA, lineB] }, index, 1)).toEqual(
      layoutOf(constraintAt(sketch, angle), index, 1),
    );
  });

  describe('distance between two points', () => {
    // The segment runs left to right along y = 0, so its normal points up the
    // screen and the cursor's y is the offset's sign and size.
    const mid = { x: 50, y: 0 };

    it("takes the offset's magnitude and side from the cursor", () => {
      const s = toScreen(1);
      const above = specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 50, y: -40 } }, index, 1);
      const below = specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 50, y: 60 } }, index, 1);
      expect(perpendicularDistance(s(mid), s(firstLine(above)[0]), s(firstLine(above)[1]))).toBeCloseTo(40, 9);
      expect(s(above.textAt).y).toBeCloseTo(s(mid).y - 40, 9);
      expect(perpendicularDistance(s(mid), s(firstLine(below)[0]), s(firstLine(below)[1]))).toBeCloseTo(60, 9);
      expect(s(below.textAt).y).toBeCloseTo(s(mid).y + 60, 9);
    });

    it("keeps the cursor's side when the offset is floored at OFFSET_PX", () => {
      const s = toScreen(1);
      // A cursor within 14px of the segment still lays the dimension out on its
      // own side, a full 14px away; one right on it takes the normal's side.
      const above = specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 50, y: -5 } }, index, 1);
      const below = specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 50, y: 5 } }, index, 1);
      const on = specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 50, y: 0 } }, index, 1);
      expect(s(above.textAt).y).toBeCloseTo(s(mid).y - 14, 9);
      expect(s(below.textAt).y).toBeCloseTo(s(mid).y + 14, 9);
      expect(s(on.textAt).y).toBeCloseTo(s(mid).y - 14, 9);
    });

    it('measures the offset in screen pixels at any zoom', () => {
      for (const scale of SCALES) {
        const s = toScreen(scale);
        // 60 world units off reads 15 screen px even at the smallest zoom here.
        const far = specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 50, y: -60 } }, index, scale);
        expect(distance(s(mid), s(far.textAt))).toBeCloseTo(60 * scale, 9);
        // One world unit off is under the floor at every zoom, so it stays 14.
        const near = specLayout({ kind: 'distance', operands: [p1, p2], placement: { x: 50, y: -1 } }, index, scale);
        expect(distance(s(mid), s(near.textAt))).toBeCloseTo(14, 9);
      }
    });
  });

  describe('distance from a point to a line', () => {
    // The line runs left to right along y = 0 with the point below it, so the
    // foot is straight up from the point and the cursor's x is the slide.
    const from = at(index, p1);
    const to = at(index, p2);
    const point = at(index, p);

    it("slides the dimension along the line by the cursor's projection", () => {
      const s = toScreen(1);
      const ahead = specLayout({ kind: 'distance', operands: [p, line], placement: { x: 80, y: 40 } }, index, 1);
      const behind = specLayout({ kind: 'distance', operands: [p, line], placement: { x: 20, y: 40 } }, index, 1);
      // The foot sits at x = 50, so a cursor 30 either side of it slides the
      // dimension 30 that way, both ends together.
      expect(s(firstLine(ahead)[0]).x).toBeCloseTo(80, 9);
      expect(s(firstLine(ahead)[1]).x).toBeCloseTo(80, 9);
      expect(s(firstLine(behind)[0]).x).toBeCloseTo(20, 9);
      expect(s(firstLine(behind)[1]).x).toBeCloseTo(20, 9);
    });

    it("reads only the cursor's projection along the line", () => {
      // How far off the line the cursor sits does not enter the slide.
      const near = specLayout({ kind: 'distance', operands: [p, line], placement: { x: 80, y: 40 } }, index, 1);
      const far = specLayout({ kind: 'distance', operands: [p, line], placement: { x: 80, y: 400 } }, index, 1);
      expect(far).toEqual(near);
    });

    it("floors the slide at OFFSET_PX, keeping the projection's direction", () => {
      const s = toScreen(1);
      // A cursor barely past the foot still slides the dimension a full 14px,
      // the way it came from.
      const ahead = specLayout({ kind: 'distance', operands: [p, line], placement: { x: 55, y: 40 } }, index, 1);
      const behind = specLayout({ kind: 'distance', operands: [p, line], placement: { x: 45, y: 40 } }, index, 1);
      expect(s(firstLine(ahead)[0]).x).toBeCloseTo(64, 9);
      expect(s(firstLine(behind)[0]).x).toBeCloseTo(36, 9);
    });

    it('still measures the point-to-line gap wherever the cursor slides it', () => {
      for (const scale of SCALES) {
        const s = toScreen(scale);
        const layout = specLayout({ kind: 'distance', operands: [p, line], placement: { x: 80, y: 40 } }, index, scale);
        const [start, end] = firstLine(layout);
        // The gap itself is untouched: the dimension line still spans it, at
        // right angles to the line, with its far end on the infinite line.
        expect(between(dir(s(start), s(end)), dir(s(from), s(to)))).toBeCloseTo(Math.PI / 2, 9);
        expect(distance(s(start), s(end))).toBeCloseTo(perpendicularDistance(point, from, to) * scale, 9);
        expect(perpendicularDistance(s(end), s(from), s(to))).toBeCloseTo(0, 9);
      }
    });
  });

  describe('angle', () => {
    const vertex = at(index, v);

    it('grows the arc to the cursor, floored at ANGLE_RADIUS_PX', () => {
      for (const scale of SCALES) {
        // A cursor far from the vertex sets the radius, measured in screen px.
        const far = specLayout({ kind: 'angle', operands: [lineA, lineB], placement: { x: 320, y: 120 } }, index, scale);
        expect(soleArc(far).radius * scale).toBeCloseTo(distance({ x: 320, y: 120 }, vertex) * scale, 9);
        // A cursor all but on the vertex is floored at the default 30 screen px.
        const near = specLayout({ kind: 'angle', operands: [lineA, lineB], placement: { x: 201, y: 1 } }, index, scale);
        expect(soleArc(near).radius * scale).toBeCloseTo(30, 9);
      }
    });

    it('keeps the arc centred on the vertex, sweeping from line a to line b', () => {
      const layout = specLayout({ kind: 'angle', operands: [lineA, lineB], placement: { x: 320, y: 120 } }, index, 1);
      const arc = soleArc(layout);
      expect(distance(vertex, arc.center)).toBeCloseTo(0, 9);
      // Line a runs +x from the vertex and line b +y, so the sweep is a quarter
      // turn either way the radius grew.
      expect(between(dir(vertex, arcPoint(arc, arc.startAngle)), 0)).toBeCloseTo(0, 9);
      expect(between(dir(vertex, arcPoint(arc, arc.endAngle)), Math.PI / 2)).toBeCloseTo(0, 9);
    });
  });

  describe('radius', () => {
    const c = at(index, center);

    it("points a circle's leader at the cursor", () => {
      const s = toScreen(1);
      const layout = specLayout({ kind: 'radius', operands: [circle], placement: { x: 90, y: 50 } }, index, 1);
      const arrow = soleArrow(layout);
      // The arrowhead lands on the curve toward the cursor and points away from
      // the centre; the value sits LEADER_PX + TEXT_GAP_PX beyond it.
      expect(arrow.at).toEqual({ x: 90, y: 50 });
      expect(between(arrow.angle, dir(c, arrow.at))).toBeCloseTo(0, 9);
      expect(distance(s(arrow.at), s(layout.textAt))).toBeCloseTo(14 + 8, 9);
      expect(between(dir(c, layout.textAt), dir(c, arrow.at))).toBeCloseTo(0, 9);
      // The leader still runs from the centre out through the curve.
      const [start, end] = firstLine(layout);
      expect(start).toEqual(c);
      expect(perpendicularDistance(c, s(start), s(end))).toBeCloseTo(0, 9);
    });

    it('follows the cursor in any direction, however far away it is', () => {
      for (const cursor of [
        { x: 150, y: 50 },
        { x: 90, y: 90 },
        { x: 50, y: 10 },
        { x: 10, y: 50 },
      ]) {
        const layout = specLayout({ kind: 'radius', operands: [circle], placement: cursor }, index, 1);
        const arrow = soleArrow(layout);
        // The direction is normalised, so only where the cursor points matters:
        // the arrowhead always sits on the curve, toward it.
        expect(distance(c, arrow.at)).toBeCloseTo(40, 9);
        expect(between(dir(c, arrow.at), dir(c, cursor))).toBeCloseTo(0, 9);
      }
    });

    describe('an arc', () => {
      const ac = at(index, arcCenter);

      it('follows the cursor inside the sweep', () => {
        // The quarter arc runs from +x round to +y, so a cursor at 45° is on it.
        const layout = specLayout({ kind: 'radius', operands: [arc], placement: { x: 407, y: 7 } }, index, 1);
        const arrow = soleArrow(layout);
        expect(between(dir(ac, arrow.at), Math.PI / 4)).toBeCloseTo(0, 9);
        expect(distance(ac, arrow.at)).toBeCloseTo(10, 9);
      });

      it('clamps the leader onto the arc when the cursor points past it', () => {
        // A cursor anywhere outside the sweep lands the arrowhead on the arc's
        // end — the last point of the sweep — so it never floats off the curve.
        for (const cursor of [
          { x: 390, y: 0 },
          { x: 400, y: -10 },
          { x: 390, y: 10 },
          { x: 393, y: -7 },
        ]) {
          const layout = specLayout({ kind: 'radius', operands: [arc], placement: cursor }, index, 1);
          const arrow = soleArrow(layout);
          expect(arrow.at.x).toBeCloseTo(400, 9);
          expect(arrow.at.y).toBeCloseTo(10, 9);
          expect(distance(ac, arrow.at)).toBeCloseTo(10, 9);
        }
      });

      it('falls back to the mid-sweep with no cursor', () => {
        const arrow = soleArrow(specLayout({ kind: 'radius', operands: [arc] }, index, 1));
        expect(between(dir(ac, arrow.at), Math.PI / 4)).toBeCloseTo(0, 9);
      });

      it("wraps the cursor's angle into the sweep before clamping it", () => {
        // A sweep crossing the negative y axis: the cursor's angle may be
        // expressed either side of ±π and still clamp the same way.
        const b = new SketchBuilder();
        const center = b.point(500, 0);
        const start = b.point(510, 0);
        const end = b.point(500, -10);
        const wide = b.arc(center, start, end);
        const sketch = b.build();
        const index = indexEntities(sketch);
        const c = at(index, center);
        // Inside the three-quarter sweep, at π: the leader follows the cursor.
        const inside = specLayout({ kind: 'radius', operands: [wide], placement: { x: 490, y: 0 } }, index, 1);
        const insideArrow = soleArrow(inside);
        expect(between(dir(c, insideArrow.at), Math.PI)).toBeCloseTo(0, 9);
        expect(distance(c, insideArrow.at)).toBeCloseTo(10, 9);
        // Past the sweep's end, at -π/4 — the same direction as 7π/4 — the
        // leader lands on the arc's end, at 3π/2.
        const outside = specLayout({ kind: 'radius', operands: [wide], placement: { x: 507, y: -7 } }, index, 1);
        expect(soleArrow(outside).at.x).toBeCloseTo(500, 9);
        expect(soleArrow(outside).at.y).toBeCloseTo(-10, 9);
      });
    });
  });
});

describe('a stored placement', () => {
  // A committed dimension carries the placement the cursor chose for it, so it
  // draws where the user put it instead of back at the default anchor.
  const b = new SketchBuilder();
  const origin = b.point(0, 0);
  const far = b.point(100, 0);
  const line = b.line(origin, far);
  const p = b.point(50, 40);
  const circle = b.circle(origin, 40);
  const v = b.point(0, 200);
  const right = b.point(100, 200);
  const down = b.point(0, 300);
  const lineA = b.line(v, right);
  const lineB = b.line(v, down);
  const arcCenter = b.point(300, 0);
  const arcStart = b.point(310, 0);
  const arcEnd = b.point(300, 10);
  const arc = b.arc(arcCenter, arcStart, arcEnd);
  const sketch = b.build();
  const index = indexEntities(sketch);
  const a = at(index, origin);
  const c = at(index, far);
  const mid = midpoint(a, c);
  const centre = at(index, origin);
  const vertex = at(index, v);
  const ac = at(index, arcCenter);

  it('lays out a stored placement exactly like the cursor that chose it', () => {
    // The offset a cursor resolved to and the one stored from it are the same
    // number, so the two lay out identically.
    expect(specLayout({ kind: 'distance', operands: [origin, far], offset: 60 }, index, 1)).toEqual(
      specLayout({ kind: 'distance', operands: [origin, far], placement: { x: 50, y: -60 } }, index, 1),
    );
    expect(specLayout({ kind: 'distance', operands: [p, line], offset: 40 }, index, 1)).toEqual(
      specLayout({ kind: 'distance', operands: [p, line], placement: { x: 90, y: 40 } }, index, 1),
    );
    expect(specLayout({ kind: 'radius', operands: [circle], offset: Math.PI / 2 }, index, 1)).toEqual(
      specLayout({ kind: 'radius', operands: [circle], placement: { x: 0, y: 40 } }, index, 1),
    );
  });

  it('puts a point-to-point distance where it was placed', () => {
    const s = toScreen(1);
    // The segment runs left to right, so its normal points up the screen and a
    // positive offset sits above it, 60 world px off.
    const above = specLayout({ kind: 'distance', operands: [origin, far], offset: 60 }, index, 1);
    expect(perpendicularDistance(s(mid), s(firstLine(above)[0]), s(firstLine(above)[1]))).toBeCloseTo(60, 9);
    expect(s(above.textAt).y).toBeCloseTo(s(mid).y - 60, 9);
    // A negative offset puts it on the other side of the segment.
    const below = specLayout({ kind: 'distance', operands: [origin, far], offset: -60 }, index, 1);
    expect(s(below.textAt).y).toBeCloseTo(s(mid).y + 60, 9);
  });

  it('slides a point-to-line distance along the line by its placement', () => {
    const s = toScreen(1);
    // The perpendicular foot sits at x = 50, so a placement of 40 slides the
    // dimension line 40 that way and -40 slides it back, both ends together.
    const ahead = specLayout({ kind: 'distance', operands: [p, line], offset: 40 }, index, 1);
    const behind = specLayout({ kind: 'distance', operands: [p, line], offset: -40 }, index, 1);
    expect(s(firstLine(ahead)[0]).x).toBeCloseTo(90, 9);
    expect(s(firstLine(ahead)[1]).x).toBeCloseTo(90, 9);
    expect(s(firstLine(behind)[0]).x).toBeCloseTo(10, 9);
    expect(s(firstLine(behind)[1]).x).toBeCloseTo(10, 9);
  });

  it('sweeps an angle arc as wide as it was placed', () => {
    const layout = specLayout({ kind: 'angle', operands: [lineA, lineB], offset: 80 }, index, 1);
    const arc = soleArc(layout);
    expect(arc.radius).toBeCloseTo(80, 9);
    expect(distance(vertex, arc.center)).toBeCloseTo(0, 9);
    // The value rides the bisector out beyond the wider arc, as it always has.
    expect(distance(vertex, layout.textAt)).toBeCloseTo(80 + 8, 9);
  });

  it("points a radius leader where it was placed", () => {
    // A circle at the origin, placed pointing down: atan2's +π/2 is +y, and Y
    // points down the screen.
    const layout = specLayout({ kind: 'radius', operands: [circle], offset: Math.PI / 2 }, index, 1);
    const arrow = soleArrow(layout);
    expect(between(dir(centre, arrow.at), Math.PI / 2)).toBeCloseTo(0, 9);
    expect(distance(centre, arrow.at)).toBeCloseTo(40, 9);
    expect(arrow.at.y).toBeCloseTo(40, 9);
  });

  it('follows the cursor over the stored placement when both are given', () => {
    // A dimension being placed follows the cursor; the stored placement is only
    // what it falls back to once the cursor is gone.
    const above = { x: 50, y: -20 };
    expect(specLayout({ kind: 'distance', operands: [origin, far], placement: above, offset: 60 }, index, 1)).toEqual(
      specLayout({ kind: 'distance', operands: [origin, far], placement: above }, index, 1),
    );
    const left = { x: -40, y: 0 };
    expect(specLayout({ kind: 'radius', operands: [circle], placement: left, offset: Math.PI / 2 }, index, 1)).toEqual(
      specLayout({ kind: 'radius', operands: [circle], placement: left }, index, 1),
    );
  });

  it('runs the witness lines all the way to a placed dimension line', () => {
    const s = toScreen(1);
    const layout = specLayout({ kind: 'distance', operands: [origin, far], offset: 60 }, index, 1);
    for (const point of [a, c]) {
      // 60 out to the dimension line, then the 2px overshoot past it.
      expect(distance(s(point), s(witnessEnd(layout.lines, point)))).toBeCloseTo(60 + 2, 9);
    }
    // The stubs stay on the side the offset chose: above, with the line above.
    expect(s(witnessEnd(layout.lines, a)).y).toBeCloseTo(-62, 9);
    const below = specLayout({ kind: 'distance', operands: [origin, far], offset: -60 }, index, 1);
    expect(s(witnessEnd(below.lines, a)).y).toBeCloseTo(62, 9);
  });

  it('leaves the default witness stubs at OFFSET_PX + OVERSHOOT_PX', () => {
    // No placement at all still draws the 16px stubs it always has.
    const s = toScreen(1);
    const layout = specLayout({ kind: 'distance', operands: [origin, far] }, index, 1);
    for (const point of [a, c]) {
      expect(distance(s(point), s(witnessEnd(layout.lines, point)))).toBeCloseTo(14 + 2, 9);
    }
  });

  it('honours the placement a committed constraint carries', () => {
    const b = new SketchBuilder();
    const first = b.point(0, 0);
    const second = b.point(100, 0);
    const d = b.constrain({ kind: 'distance', a: first, b: second, value: 100, placement: 60 });
    const built = b.build();
    const builtIndex = indexEntities(built);
    const constraint = constraintAt(built, d);
    // The builder passes the field straight through to the constraint...
    expect(constraint).toEqual({ kind: 'distance', id: d, a: first, b: second, value: 100, placement: 60 });
    // ...and the layout honours it: 60 above the segment, not the default 14.
    const s = toScreen(1);
    const layout = layoutOf(constraint, builtIndex, 1);
    const spread = midpoint(at(builtIndex, first), at(builtIndex, second));
    expect(perpendicularDistance(s(spread), s(firstLine(layout)[0]), s(firstLine(layout)[1]))).toBeCloseTo(60, 9);
    expect(s(layout.textAt).y).toBeCloseTo(s(spread).y - 60, 9);
  });

  it('leaves a stored radius angle off the arc it was clamped from', () => {
    // A cursor's angle is clamped into the sweep as it resolves; a stored one
    // already went through that, so the layout takes it as it stands — even
    // pointing up, outside the quarter sweep from +x round to +y.
    const outside = specLayout({ kind: 'radius', operands: [arc], offset: -Math.PI / 2 }, index, 1);
    const arrow = soleArrow(outside);
    expect(arrow.at.x).toBeCloseTo(300, 9);
    expect(arrow.at.y).toBeCloseTo(-10, 9);
    expect(distance(ac, arrow.at)).toBeCloseTo(10, 9);
    // A cursor pointing the same way would have been clamped onto the arc's end.
    const clamped = specLayout({ kind: 'radius', operands: [arc], placement: { x: 300, y: -10 } }, index, 1);
    expect(soleArrow(clamped).at.y).toBeCloseTo(10, 9);
  });

  describe('resolveOffset', () => {
    it('floors the cursor offset at OFFSET_PX, keeping its side', () => {
      for (const scale of SCALES) {
        // A cursor 5 screen px from the segment is inside the floor at every
        // zoom, so the offset is the floor: 14 screen px, in world units.
        const near = 5 / scale;
        const above = resolveOffset({ kind: 'distance', operands: [origin, far], placement: { x: 50, y: -near } }, index, scale);
        const below = resolveOffset({ kind: 'distance', operands: [origin, far], placement: { x: 50, y: near } }, index, scale);
        expect(above).toBeCloseTo(14 / scale, 9);
        expect(below).toBeCloseTo(-14 / scale, 9);
      }
      // Well clear of the floor, the cursor sets the offset exactly.
      expect(resolveOffset({ kind: 'distance', operands: [origin, far], placement: { x: 50, y: -60 } }, index, 1)).toBeCloseTo(60, 9);
    });

    it('takes a stored offset as it stands', () => {
      expect(resolveOffset({ kind: 'distance', operands: [origin, far], offset: 60 }, index, 1)).toBe(60);
      expect(resolveOffset({ kind: 'distance', operands: [p, line], offset: -40 }, index, 1)).toBe(-40);
      expect(resolveOffset({ kind: 'angle', operands: [lineA, lineB], offset: 80 }, index, 1)).toBe(80);
      expect(resolveOffset({ kind: 'radius', operands: [circle], offset: Math.PI / 2 }, index, 1)).toBe(Math.PI / 2);
    });

    it("falls back to each kind's default anchor with neither", () => {
      // The defaults, in world units: 14 off for a distance, a 30px arc for an
      // angle, and the mid-sweep for a radius — the top of a circle.
      expect(resolveOffset({ kind: 'distance', operands: [origin, far] }, index, 1)).toBeCloseTo(14, 9);
      expect(resolveOffset({ kind: 'distance', operands: [p, line] }, index, 1)).toBeCloseTo(14, 9);
      expect(resolveOffset({ kind: 'angle', operands: [lineA, lineB] }, index, 1)).toBeCloseTo(30, 9);
      expect(resolveOffset({ kind: 'radius', operands: [circle] }, index, 1)).toBeCloseTo(-Math.PI / 2, 9);
      expect(resolveOffset({ kind: 'radius', operands: [arc] }, index, 1)).toBeCloseTo(Math.PI / 4, 9);
    });

    it('returns undefined for degenerate geometry', () => {
      // Missing entities, operands of the wrong kind and a spec short of them
      // all measure nothing, so there is no offset to place a dimension at.
      expect(resolveOffset({ kind: 'distance', operands: [origin, 'nope'] }, index, 1)).toBeUndefined();
      expect(resolveOffset({ kind: 'distance', operands: [line, line] }, index, 1)).toBeUndefined();
      expect(resolveOffset({ kind: 'distance', operands: [origin] }, index, 1)).toBeUndefined();
      expect(resolveOffset({ kind: 'radius', operands: [line] }, index, 1)).toBeUndefined();
      expect(resolveOffset({ kind: 'angle', operands: [origin, far] }, index, 1)).toBeUndefined();
      // Coincident points and a zero-length line have no direction either.
      const b = new SketchBuilder();
      const same = b.point(5, 5);
      const twin = b.point(5, 5);
      const short = b.line(same, twin);
      const degenerate = indexEntities(b.build());
      expect(resolveOffset({ kind: 'distance', operands: [same, twin] }, degenerate, 1)).toBeUndefined();
      expect(resolveOffset({ kind: 'distance', operands: [same, short] }, degenerate, 1)).toBeUndefined();
      expect(resolveOffset({ kind: 'angle', operands: [short, short] }, degenerate, 1)).toBeUndefined();
    });
  });
});

describe('dimensionText', () => {
  /** A fixed format, so these read the same whatever locale the run uses. */
  const one = (n: number) => n.toFixed(1);

  it('prefixes a radius with R', () => {
    expect(dimensionText(40, true, one)).toBe('R40.0');
    expect(dimensionText(12.34, true, one)).toBe('R12.3');
  });

  it('shows the plain number for every other kind', () => {
    expect(dimensionText(40, false, one)).toBe('40.0');
    expect(dimensionText(12.34, false, one)).toBe('12.3');
  });

  it("leaves the number itself to the caller's format", () => {
    // A locale's format, so the same value reads differently per locale and the
    // prefix stays in front of whatever it produces.
    const grouped = (n: number) => n.toLocaleString('en-US');
    expect(dimensionText(1234.5, false, grouped)).toBe('1,234.5');
    expect(dimensionText(1234.5, true, grouped)).toBe('R1,234.5');
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
