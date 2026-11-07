import {
  add,
  arcParams,
  lineIntersection,
  midpoint,
  perpendicularDistance,
  scaled,
  segmentNormal,
  sub,
  unit,
} from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Arc, Circle, Constraint, Id, Line, Point } from '../core/model';
import type { EntityIndex } from '../core/sketch';

/**
 * Dimensions on the canvas — the measured value a `distance`, `radius` or
 * `angle` constraint carries, drawn the way a CAD system does: a dimension
 * line with witness lines and arrowheads, the value text just beyond it, an
 * arc for an angle and a leader for a radius.
 *
 * The layout is pure geometry in WORLD coordinates, and takes the viewport
 * `scale` because every offset from the geometry is given in SCREEN pixels
 * and divided by it: a dimension keeps the same distance from its geometry at
 * any zoom, the same reason `constraints.ts` divides its offsets. Nothing here
 * touches the DOM — the renderer maps the result through its own world →
 * screen transform, and formatting the value text is the caller's job.
 */

/** How far a dimension sits off the geometry it measures, on screen. */
const OFFSET_PX = 14;
/** How far a witness line runs past the dimension line, on screen. */
const OVERSHOOT_PX = 2;
/** How far the dimension line runs past each projection, on screen. */
const EXTEND_PX = 10;
/** Radius of an angle dimension's arc, on screen. */
const ANGLE_RADIUS_PX = 30;
/** How far a radius leader runs past the curve, on screen. */
const LEADER_PX = 14;
/** How far the value text sits beyond the dimension line or the leader end, on screen. */
const TEXT_GAP_PX = 8;

/** The viewport clamps its scale to [1e-3, 1e3]; this keeps a degenerate one finite. */
const MIN_SCALE = 1e-6;

/** The constraint kinds that carry a measured value, drawn as a dimension. */
export const DIMENSION_KINDS = ['distance', 'radius', 'angle'] as const;

/** A constraint kind `dimensionLayout` knows how to draw. */
export type DimensionKind = (typeof DIMENSION_KINDS)[number];

/** Whether a constraint kind is one of the three dimensions. */
export function isDimensionKind(kind: Constraint['kind']): kind is DimensionKind {
  return (DIMENSION_KINDS as readonly string[]).includes(kind);
}

/** An arrowhead tip plus the direction it points, in screen-space radians (atan2 with Y pointing down). */
export interface DimensionArrow {
  readonly at: Vec2;
  readonly angle: number;
}

/** An arc running clockwise on screen from startAngle to endAngle — the model's arc convention. */
export interface DimensionArc {
  readonly center: Vec2;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

export interface DimensionLayout {
  /** Dimension line, witness lines and leaders, in world coordinates. */
  readonly lines: readonly (readonly [Vec2, Vec2])[];
  readonly arc?: DimensionArc;
  readonly arrows: readonly DimensionArrow[];
  /** Where the value text sits, in world coordinates. */
  readonly textAt: Vec2;
}

/**
 * Layout of one dimension constraint's on-canvas graphics, or undefined when
 * the geometry cannot carry one. Every offset from the geometry is a SCREEN
 * pixel count divided by `scale`, so a dimension keeps the same distance from
 * its geometry at any zoom — the same reason constraints.ts divides its offsets.
 */
export function dimensionLayout(c: Constraint, index: EntityIndex, scale: number): DimensionLayout | undefined {
  const k = 1 / Math.max(scale, MIN_SCALE);
  switch (c.kind) {
    case 'distance':
      return distanceLayout(c.a, c.b, index, k);
    case 'radius':
      return radiusLayout(c.curve, index, k);
    case 'angle':
      return angleLayout(c.a, c.b, index, k);
    default:
      // Not a dimension: the glyph chip in constraints.ts carries its symbol.
      return undefined;
  }
}

// ── Geometry helpers ────────────────────────────────────────────────────────

function pointAt(index: EntityIndex, id: Id): Point | undefined {
  const e = index.get(id);
  return e?.kind === 'point' ? e : undefined;
}

/** A point's position as a plain vector, so a layout never aliases entities. */
function pos(p: Point): Vec2 {
  return { x: p.x, y: p.y };
}

/** Dot product; its sign against a normal says which side of a line a point is on. */
function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

interface Segment {
  readonly a: Vec2;
  readonly b: Vec2;
}

/** A line's two endpoints as plain vectors. */
function segmentOf(e: Line, index: EntityIndex): Segment | undefined {
  const a = pointAt(index, e.p1);
  const b = pointAt(index, e.p2);
  return a === undefined || b === undefined ? undefined : { a: pos(a), b: pos(b) };
}

/** Radius and mid-sweep angle of a circle or arc; a circle's sweep starts at the top. */
function frame(e: Circle | Arc, index: EntityIndex): { center: Vec2; radius: number; mid: number } | undefined {
  const center = pointAt(index, e.center);
  if (center === undefined) return undefined;
  if (e.kind === 'circle') return e.radius === 0 ? undefined : { center: pos(center), radius: e.radius, mid: -Math.PI / 2 };
  // An arc's endpoints are part of its definition, so a missing one leaves
  // nothing to sweep — unlike constraints.ts, which only needs a nearby point.
  const start = pointAt(index, e.start);
  const end = pointAt(index, e.end);
  if (start === undefined || end === undefined) return undefined;
  const { radius, startAngle, endAngle } = arcParams(center, start, end);
  return radius === 0 ? undefined : { center: pos(center), radius, mid: (startAngle + endAngle) / 2 };
}

// ── Distance ────────────────────────────────────────────────────────────────

/** A `distance` between two points, or from a point to a line in either order. */
function distanceLayout(aId: Id, bId: Id, index: EntityIndex, k: number): DimensionLayout | undefined {
  const ea = index.get(aId);
  const eb = index.get(bId);
  if (ea === undefined || eb === undefined) return undefined;
  if (ea.kind === 'point' && eb.kind === 'point') return pointToPoint(ea, eb, k);
  // Point–line either way round; normalise to point + line.
  const point = ea.kind === 'point' ? ea : eb.kind === 'point' ? eb : undefined;
  const line = ea.kind === 'line' ? ea : eb.kind === 'line' ? eb : undefined;
  if (point === undefined || line === undefined) return undefined;
  return pointToLine(point, line, index, k);
}

/**
 * The dimension line runs parallel to the two points, one offset away, and
 * reaches past each of their projections; a witness line drops from each point
 * down to it.
 */
function pointToPoint(a: Point, b: Point, k: number): DimensionLayout | undefined {
  const dir = unit(sub(b, a));
  if (dir === undefined) return undefined; // coincident points have no direction
  const n = segmentNormal(a, b);
  const from = pos(a);
  const to = pos(b);
  const off = scaled(n, OFFSET_PX * k);
  const pa = add(from, off);
  const pb = add(to, off);
  const reach = scaled(dir, EXTEND_PX * k);
  const start = sub(pa, reach);
  const end = add(pb, reach);
  const witness = scaled(n, (OFFSET_PX + OVERSHOOT_PX) * k);
  return {
    lines: [
      [start, end],
      [from, add(from, witness)],
      [to, add(to, witness)],
    ],
    // The two arrowheads sit at the ends and point outward, away from each other.
    arrows: [
      { at: start, angle: Math.atan2(-dir.y, -dir.x) },
      { at: end, angle: Math.atan2(dir.y, dir.x) },
    ],
    textAt: midpoint(pa, pb),
  };
}

/**
 * The dimension line runs perpendicular from the point to the infinite line,
 * with both ends nudged along that line so it no longer passes through the
 * point being measured.
 */
function pointToLine(p: Point, line: Line, index: EntityIndex, k: number): DimensionLayout | undefined {
  const seg = segmentOf(line, index);
  if (seg === undefined) return undefined;
  const along = unit(sub(seg.b, seg.a));
  if (along === undefined) return undefined; // a zero-length line has no direction
  const point = pos(p);
  // Foot of the perpendicular from the point to the INFINITE line, taking the
  // side of the line the point is on so the foot lands on the line, not past it.
  const n = segmentNormal(seg.a, seg.b);
  const side = dot(sub(point, seg.a), n) >= 0 ? n : scaled(n, -1);
  const foot = sub(point, scaled(side, perpendicularDistance(point, seg.a, seg.b)));
  const nudge = scaled(along, OFFSET_PX * k);
  const start = add(point, nudge);
  const end = add(foot, nudge);
  return {
    lines: [
      [start, end],
      [point, start],
    ],
    // Both ends point outward along the perpendicular, away from each other.
    arrows: [
      { at: start, angle: Math.atan2(side.y, side.x) },
      { at: end, angle: Math.atan2(-side.y, -side.x) },
    ],
    textAt: midpoint(start, end),
  };
}

// ── Radius ──────────────────────────────────────────────────────────────────

/** A leader from the centre, through the curve, out to where the value sits. */
function radiusLayout(curveId: Id, index: EntityIndex, k: number): DimensionLayout | undefined {
  const e = index.get(curveId);
  if (e === undefined || (e.kind !== 'circle' && e.kind !== 'arc')) return undefined;
  const f = frame(e, index);
  if (f === undefined) return undefined;
  // The mid-sweep direction is a unit vector by construction.
  const dir = { x: Math.cos(f.mid), y: Math.sin(f.mid) };
  const on = add(f.center, scaled(dir, f.radius));
  const end = add(on, scaled(dir, (LEADER_PX + TEXT_GAP_PX) * k));
  return {
    lines: [[f.center, end]],
    // One arrowhead, on the curve, pointing away from the centre.
    arrows: [{ at: on, angle: Math.atan2(dir.y, dir.x) }],
    textAt: end,
  };
}

// ── Angle ───────────────────────────────────────────────────────────────────

/** An arc between two lines, centred where they meet. */
function angleLayout(aId: Id, bId: Id, index: EntityIndex, k: number): DimensionLayout | undefined {
  const ea = index.get(aId);
  const eb = index.get(bId);
  if (ea?.kind !== 'line' || eb?.kind !== 'line') return undefined;
  const sa = segmentOf(ea, index);
  const sb = segmentOf(eb, index);
  if (sa === undefined || sb === undefined) return undefined;
  const dirA = unit(sub(sa.b, sa.a));
  const dirB = unit(sub(sb.b, sb.a));
  if (dirA === undefined || dirB === undefined) return undefined; // a zero-length line
  // Where the two infinite lines meet; parallel lines fall back the way
  // constraints.ts's lineTouch does, to the midpoint between the two midpoints.
  const vertex = lineIntersection(sa.a, sa.b, sb.a, sb.b) ?? midpoint(midpoint(sa.a, sa.b), midpoint(sb.a, sb.b));
  const r = ANGLE_RADIUS_PX * k;
  const from = add(vertex, scaled(dirA, r));
  const to = add(vertex, scaled(dirB, r));
  // arcParams sweeps clockwise on screen, so this arc runs from line a to line b.
  const { radius, startAngle, endAngle } = arcParams(vertex, from, to);
  const mid = (startAngle + endAngle) / 2;
  return {
    // The arc is the dimension line here; no witness lines are needed.
    lines: [],
    arc: { center: vertex, radius, startAngle, endAngle },
    // Each arrowhead points the way the arc travels, so the pair reads as a
    // clockwise sweep from line a round to line b.
    arrows: [
      { at: from, angle: Math.atan2(Math.cos(startAngle), -Math.sin(startAngle)) },
      { at: to, angle: Math.atan2(Math.cos(endAngle), -Math.sin(endAngle)) },
    ],
    // The value sits on the bisector, TEXT_GAP_PX beyond the arc.
    textAt: add(vertex, scaled({ x: Math.cos(mid), y: Math.sin(mid) }, radius + TEXT_GAP_PX * k)),
  };
}
