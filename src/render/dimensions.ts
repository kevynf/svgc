import {
  add,
  angleOf,
  arcParams,
  distance,
  lineIntersection,
  midpoint,
  perpendicularDistance,
  scaled,
  segmentNormal,
  sub,
  unit,
} from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Constraint, Id, Line, Point } from '../core/model';
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
 *
 * What is measured comes from a `DimensionSpec`: the operands, plus the world
 * cursor position while a dimension is being placed — the dimension follows it,
 * so the user chooses where it sits before committing. Committing keeps that
 * choice as the constraint's `placement`, which a spec carries as its `offset`,
 * so a placed dimension stays where the user put it instead of snapping back
 * to the default anchor — which is still what one with neither of them draws.
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
 * What a dimension measures, without a value: the operands and where it sits.
 * The operands are the same ones the matching constraint carries, so a
 * committed dimension's spec is just its constraint's.
 */
export interface DimensionSpec {
  readonly kind: DimensionKind;
  /** distance: [a, b] (point/line, either order); radius: [curve]; angle: [lineA, lineB]. */
  readonly operands: readonly Id[];
  /** World cursor position controlling where the dimension sits; undefined = the default anchor. */
  readonly placement?: Vec2;
  /**
   * The stored placement a placed dimension carries: the offset the cursor
   * chose, in the model's units (a world distance for distance/angle, radians
   * for a radius). The cursor's `placement` wins when both are given.
   */
  readonly offset?: number;
}

/**
 * Layout of one dimension spec, or undefined when the geometry cannot carry
 * one. Where the dimension sits is `resolveOffset`'s answer — the cursor's
 * `placement` if there is one, the stored `offset` otherwise, the kind's
 * default anchor if neither — and each kind reads it as one quantity: the
 * offset for a distance, the arc's radius for an angle, the leader's direction
 * for a radius. Everything else — witness lines, the reach past each
 * projection, arrowheads and where the value sits — derives from that as it
 * always has.
 */
export function layoutDimension(spec: DimensionSpec, index: EntityIndex, scale: number): DimensionLayout | undefined {
  const offset = resolveOffset(spec, index, scale);
  if (offset === undefined) return undefined;
  const k = 1 / Math.max(scale, MIN_SCALE);
  const { kind, operands } = spec;
  switch (kind) {
    case 'distance': {
      const [a, b] = operands;
      // A spec short of its operands measures nothing, like a missing entity.
      if (a === undefined || b === undefined) return undefined;
      return distanceLayout(a, b, index, k, offset);
    }
    case 'radius': {
      const [curve] = operands;
      if (curve === undefined) return undefined;
      return radiusLayout(curve, index, k, offset);
    }
    case 'angle': {
      const [a, b] = operands;
      if (a === undefined || b === undefined) return undefined;
      return angleLayout(a, b, index, k, offset);
    }
  }
}

/**
 * The stored placement a placed dimension carries: the offset the cursor chose,
 * in the model's units (a world distance for distance/angle, radians for a
 * radius). Undefined for degenerate geometry. A cursor outranks a stored
 * offset, so a dimension being placed follows the cursor; with neither, each
 * kind's default anchor.
 */
export function resolveOffset(spec: DimensionSpec, index: EntityIndex, scale: number): number | undefined {
  const k = 1 / Math.max(scale, MIN_SCALE);
  const { kind, operands, placement, offset } = spec;
  switch (kind) {
    case 'distance': {
      const [a, b] = operands;
      // A spec short of its operands measures nothing, like a missing entity.
      if (a === undefined || b === undefined) return undefined;
      const d = distanceOperands(a, b, index);
      if (d === undefined) return undefined;
      // A point–point distance reads the cursor across the segment; a
      // point–line one reads it along the line, from the perpendicular foot.
      if (d.form === 'points') {
        const spread = pointSpread(d.a, d.b);
        if (spread === undefined) return undefined; // coincident points
        if (placement === undefined) return offset ?? OFFSET_PX * k;
        // The normal is square to the segment, so the cursor's distance from
        // any point along it — the mid here — is its distance from the segment.
        return cursorOffset(placement, midpoint(spread.a, spread.b), spread.n, k);
      }
      const gap = pointGap(d.point, d.line, index);
      if (gap === undefined) return undefined;
      if (placement === undefined) return offset ?? OFFSET_PX * k;
      return cursorOffset(placement, gap.foot, gap.along, k);
    }
    case 'radius': {
      const [curve] = operands;
      if (curve === undefined) return undefined;
      const f = curveFrame(curve, index);
      if (f === undefined) return undefined;
      if (placement !== undefined) return leaderAngle(f, placement);
      // A stored angle is taken as it stands: clamping onto an arc's sweep is
      // the cursor's job, done as it resolves, so a stored one may point off it.
      return offset ?? f.mid;
    }
    case 'angle': {
      const [a, b] = operands;
      if (a === undefined || b === undefined) return undefined;
      const angle = angleFrame(a, b, index);
      if (angle === undefined) return undefined;
      if (placement === undefined) return offset ?? ANGLE_RADIUS_PX * k;
      return Math.max(distance(placement, angle.vertex), ANGLE_RADIUS_PX * k);
    }
  }
}

/** The dimension constraints: the only ones a `DimensionSpec` can describe. */
type DimensionConstraint = Extract<Constraint, { kind: DimensionKind }>;

/** Whether a constraint is one of the three that carry a measured value. */
function isDimension(c: Constraint): c is DimensionConstraint {
  return isDimensionKind(c.kind);
}

/** The operands a dimension constraint measures, in the order its spec lists them. */
function operandsOf(c: DimensionConstraint): readonly Id[] {
  switch (c.kind) {
    case 'distance':
    case 'angle':
      return [c.a, c.b];
    case 'radius':
      return [c.curve];
  }
}

/**
 * Layout of one dimension constraint's on-canvas graphics, or undefined when
 * the geometry cannot carry one: its operands laid out at the placement the
 * user chose for it, which is what a committed dimension — one the user is not
 * moving — draws. A dimension being placed is laid out by `layoutDimension`
 * instead, with the cursor's position.
 */
export function dimensionLayout(c: Constraint, index: EntityIndex, scale: number): DimensionLayout | undefined {
  // Not a dimension: the glyph chip in constraints.ts carries its symbol.
  if (!isDimension(c)) return undefined;
  // A committed dimension's spec is its own constraint: the operands, and the
  // placement it was given, so it draws where the user put it.
  return layoutDimension({ kind: c.kind, operands: operandsOf(c), offset: c.placement }, index, scale);
}

/**
 * The text a dimension shows: a radius reads `R40` the way Inventor draws it,
 * every other kind the plain number. Formatting is the caller's — a locale's
 * number format, say — so only the prefix is decided here.
 */
export function dimensionText(value: number, radius: boolean, format: (n: number) => string): string {
  const text = format(value);
  return radius ? `R${text}` : text;
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

/** A circle or arc as a radius leader sees it: where it sits and which way the leader points. */
interface CurveFrame {
  readonly center: Vec2;
  readonly radius: number;
  /** Mid-sweep direction, in atan2 radians — the leader's default direction. */
  readonly mid: number;
  /** An arc's sweep bounds, absent for a circle, whose leader may point any way. */
  readonly sweep?: { readonly startAngle: number; readonly endAngle: number };
}

/**
 * A circle or arc as a radius leader sees it, from its id. Anything else — a
 * missing id, a line, a point — leaves nothing to lead around.
 */
function curveFrame(curveId: Id, index: EntityIndex): CurveFrame | undefined {
  const e = index.get(curveId);
  if (e === undefined || (e.kind !== 'circle' && e.kind !== 'arc')) return undefined;
  const center = pointAt(index, e.center);
  if (center === undefined) return undefined;
  if (e.kind === 'circle') return e.radius === 0 ? undefined : { center: pos(center), radius: e.radius, mid: -Math.PI / 2 };
  // An arc's endpoints are part of its definition, so a missing one leaves
  // nothing to sweep — unlike constraints.ts, which only needs a nearby point.
  const start = pointAt(index, e.start);
  const end = pointAt(index, e.end);
  if (start === undefined || end === undefined) return undefined;
  const { radius, startAngle, endAngle } = arcParams(center, start, end);
  return radius === 0
    ? undefined
    : { center: pos(center), radius, mid: (startAngle + endAngle) / 2, sweep: { startAngle, endAngle } };
}

// ── Measured geometry ───────────────────────────────────────────────────────

/** What a `distance` between two points measures: the segment and the side a positive offset sits on. */
interface PointSpread {
  readonly a: Vec2;
  readonly b: Vec2;
  /** Unit direction a→b, the way the dimension line runs. */
  readonly dir: Vec2;
  /** The segment normal: the side a positive offset puts the dimension line on. */
  readonly n: Vec2;
}

/** The two points as a spread of plain vectors, or undefined when they coincide. */
function pointSpread(a: Point, b: Point): PointSpread | undefined {
  const dir = unit(sub(b, a));
  // Coincident points have no direction to measure along or offset across.
  if (dir === undefined) return undefined;
  return { a: pos(a), b: pos(b), dir, n: segmentNormal(a, b) };
}

/** What a `distance` from a point to a line measures: the slide along it, from the foot of the perpendicular. */
interface PointGap {
  /** Unit direction along the line, the way a positive offset slides the dimension. */
  readonly along: Vec2;
  /** Where the perpendicular from the point meets the infinite line. */
  readonly foot: Vec2;
  /** Unit normal from the line to the point, the way the gap itself is measured. */
  readonly side: Vec2;
}

function pointGap(p: Point, line: Line, index: EntityIndex): PointGap | undefined {
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
  return { along, foot, side };
}

/** What an `angle` measures: where the two lines meet and which way each runs. */
interface AngleFrame {
  readonly dirA: Vec2;
  readonly dirB: Vec2;
  /** Where the two infinite lines meet. */
  readonly vertex: Vec2;
}

function angleFrame(aId: Id, bId: Id, index: EntityIndex): AngleFrame | undefined {
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
  return { dirA, dirB, vertex };
}

/** A `distance`'s operands, normalised to the two shapes it can measure. */
type DistanceOperands =
  | { readonly form: 'points'; readonly a: Point; readonly b: Point }
  | { readonly form: 'line'; readonly point: Point; readonly line: Line };

/** Two points, or a point and a line in either order; anything else measures nothing. */
function distanceOperands(aId: Id, bId: Id, index: EntityIndex): DistanceOperands | undefined {
  const ea = index.get(aId);
  const eb = index.get(bId);
  if (ea === undefined || eb === undefined) return undefined;
  if (ea.kind === 'point' && eb.kind === 'point') return { form: 'points', a: ea, b: eb };
  // Point–line either way round; normalise to point + line.
  const point = ea.kind === 'point' ? ea : eb.kind === 'point' ? eb : undefined;
  const line = ea.kind === 'line' ? ea : eb.kind === 'line' ? eb : undefined;
  if (point === undefined || line === undefined) return undefined;
  return { form: 'line', point, line };
}

// ── Placement ───────────────────────────────────────────────────────────────

/** One full turn, the lap a cursor angle is wrapped into before it is clamped. */
const TAU = Math.PI * 2;

/**
 * The offset a cursor picks along `dir`, measured from `from`: its projection
 * onto that direction, with a magnitude floor of OFFSET_PX — screen pixels, so
 * the dimension never sits on the geometry at any zoom — and the projection's
 * sign, which says which side the cursor is on. A projection of zero, like no
 * cursor at all, takes the positive side.
 */
function cursorOffset(placement: Vec2, from: Vec2, dir: Vec2, k: number): number {
  const d = dot(sub(placement, from), dir);
  return (d < 0 ? -1 : 1) * Math.max(Math.abs(d), OFFSET_PX * k);
}

/**
 * An angle pulled into an arc's clockwise sweep [startAngle, endAngle] — the
 * interval `arcParams` measures — so a cursor pointing past either end still
 * lands the leader on the arc. The cursor's angle is wrapped into the one lap
 * that starts at `startAngle` first, so the answer never depends on how that
 * angle itself was expressed.
 */
function clampToSweep(angle: number, startAngle: number, endAngle: number): number {
  const lap = angle - startAngle;
  const t = lap - Math.floor(lap / TAU) * TAU; // [0, TAU)
  return startAngle + Math.min(t, endAngle - startAngle);
}

/**
 * The leader's angle for a cursor: from the centre toward it, so the user drags
 * the value to any side of the curve. An arc clamps that angle into its sweep,
 * keeping the arrowhead on the arc; a circle takes any direction.
 */
function leaderAngle(f: CurveFrame, placement: Vec2): number {
  const toward = sub(placement, f.center);
  // A cursor on the centre has no direction to follow, so the default stands.
  if (toward.x === 0 && toward.y === 0) return f.mid;
  const angle = angleOf(f.center, placement);
  return f.sweep === undefined ? angle : clampToSweep(angle, f.sweep.startAngle, f.sweep.endAngle);
}

// ── Distance ────────────────────────────────────────────────────────────────

/** A `distance` between two points, or from a point to a line in either order. */
function distanceLayout(
  aId: Id,
  bId: Id,
  index: EntityIndex,
  k: number,
  offset: number,
): DimensionLayout | undefined {
  const d = distanceOperands(aId, bId, index);
  if (d === undefined) return undefined;
  return d.form === 'points' ? pointToPoint(d.a, d.b, k, offset) : pointToLine(d.point, d.line, index, offset);
}

/**
 * The dimension line runs parallel to the two points, one offset away, and
 * reaches past each of their projections; a witness line drops from each point
 * to it. The offset is the resolved placement — the cursor's signed distance
 * across the segment, or the distance the dimension was placed at — so the
 * user can drag the dimension to either side and any distance away.
 */
function pointToPoint(a: Point, b: Point, k: number, offset: number): DimensionLayout | undefined {
  const spread = pointSpread(a, b);
  if (spread === undefined) return undefined; // coincident points have no direction
  const { a: from, b: to, dir, n } = spread;
  const off = scaled(n, offset);
  const pa = add(from, off);
  const pb = add(to, off);
  const reach = scaled(dir, EXTEND_PX * k);
  const start = sub(pa, reach);
  const end = add(pb, reach);
  // Each witness line runs the whole offset out to the dimension line, then
  // OVERSHOOT_PX past it on the side the offset chose, so a dimension placed
  // far from its geometry no longer leaves its stubs hanging in mid-air. At
  // the default offset that is the (OFFSET_PX + OVERSHOOT_PX) stub it always
  // was.
  const side = offset < 0 ? -1 : 1;
  const witness = add(off, scaled(n, side * OVERSHOOT_PX * k));
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
 * point being measured. The nudge is the resolved offset — the cursor's
 * projection along the line measured from the foot, or the slide the dimension
 * was placed at — so the dimension slides along the line as the cursor does.
 */
function pointToLine(p: Point, line: Line, index: EntityIndex, offset: number): DimensionLayout | undefined {
  const gap = pointGap(p, line, index);
  if (gap === undefined) return undefined;
  const { along, foot, side } = gap;
  const point = pos(p);
  const nudge = scaled(along, offset);
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
function radiusLayout(curveId: Id, index: EntityIndex, k: number, offset: number): DimensionLayout | undefined {
  const f = curveFrame(curveId, index);
  if (f === undefined) return undefined;
  // The resolved offset is the leader's angle, so the leader points wherever
  // the cursor put it — or wherever the dimension was placed, or the mid-sweep.
  const dir = { x: Math.cos(offset), y: Math.sin(offset) };
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

/**
 * An arc between two lines, centred where they meet. Its radius is the resolved
 * offset — the cursor's distance from that vertex, floored at ANGLE_RADIUS_PX,
 * or the radius the dimension was placed at — so the arc grows to meet the
 * cursor and never collapses onto the lines.
 */
function angleLayout(aId: Id, bId: Id, index: EntityIndex, k: number, offset: number): DimensionLayout | undefined {
  const angle = angleFrame(aId, bId, index);
  if (angle === undefined) return undefined;
  const { dirA, dirB, vertex } = angle;
  const from = add(vertex, scaled(dirA, offset));
  const to = add(vertex, scaled(dirB, offset));
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
