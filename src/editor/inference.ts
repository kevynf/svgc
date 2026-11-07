import { angleOf, arcParams, degToRad, distance } from '../core/geometry';
import type { ArcParams, Vec2 } from '../core/geometry';
import type { Arc, Circle, Id, Line, Point } from '../core/model';
import type { ConstraintInput } from '../core/builder';
import { indexEntities } from '../core/sketch';
import type { Sketch } from '../core/sketch';
import { distanceTo, pointLookup } from './hit';
import type { PointLookup } from './hit';

const TAU = Math.PI * 2;
const DEFAULT_ANGLE_TOLERANCE = 4;
/** Two lines closer than this count as one line. */
const LINE_EPS = 1e-9;

type Curve = Line | Circle | Arc;

export type InferredConstraint =
  /** Cursor snapped onto an existing point. The caller REUSES that point instead of creating a new one. */
  | { readonly kind: 'coincident'; readonly target: Id }
  /** Cursor projected onto an existing line, circle or arc. */
  | { readonly kind: 'pointOnCurve'; readonly target: Id }
  /** Segment anchor→cursor is horizontal / vertical. */
  | { readonly kind: 'horizontal' }
  | { readonly kind: 'vertical' }
  /** Segment anchor→cursor is parallel / perpendicular to the reference line. */
  | { readonly kind: 'parallel'; readonly target: Id }
  | { readonly kind: 'perpendicular'; readonly target: Id }
  /** Segment anchor→cursor is tangent to an arc/circle that the anchor point lies on as an arc endpoint. */
  | { readonly kind: 'tangent'; readonly target: Id };

/** Visual-only dotted alignment guide (Inventor does not create a constraint for these). */
export interface Alignment {
  /** The existing point the guide comes from. */
  readonly source: Id;
  /** 'x': cursor shares the source's x (vertical guide). 'y': shares its y (horizontal guide). */
  readonly axis: 'x' | 'y';
}

interface Anchor {
  readonly position: Vec2;
  readonly id?: Id;
}

export interface InferenceOptions {
  /** World-space snap distance (caller converts from screen px). */
  readonly tolerance: number;
  /** False when Ctrl is held: return the raw cursor, nothing inferred. */
  readonly enabled: boolean;
  /** The previous click of the current command, if any (e.g. line start). `id` is set when it is an existing point. */
  readonly anchor?: Anchor;
  /** Entities to ignore (e.g. the preview geometry, the anchor point itself). */
  readonly exclude?: ReadonlySet<Id>;
  /** Line most recently hovered by the user; the reference for parallel/perpendicular. */
  readonly reference?: Id;
  /** Angular tolerance in degrees for horizontal/vertical/parallel/perpendicular/tangent. Default 4. */
  readonly angleTolerance?: number;
}

export interface InferenceResult {
  /** Snapped world position. */
  readonly position: Vec2;
  readonly constraints: readonly InferredConstraint[];
  readonly alignments: readonly Alignment[];
}

/** A direction constraint plus the cursor rotated onto its exact direction. */
interface Direction {
  readonly constraint: InferredConstraint;
  readonly position: Vec2;
  /** Axis an H/V constraint pins, so an alignment must not fight it. */
  readonly axis?: 'x' | 'y';
}

/** Smallest absolute difference between two directions, in [0, π]. */
function angleDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % TAU;
  return d > Math.PI ? TAU - d : d;
}

/**
 * Of the two directions along a line at angle `base` (base and base + π), the
 * one closest to `theta`, with its angular distance. Lines have no direction,
 * so drawing leftwards is just as horizontal as drawing rightwards.
 */
function alongLine(theta: number, base: number): { angle: number; delta: number } {
  const forward = angleDelta(theta, base);
  const backward = angleDelta(theta, base + Math.PI);
  return forward <= backward
    ? { angle: base, delta: forward }
    : { angle: base + Math.PI, delta: backward };
}

function unit(v: Vec2): Vec2 | undefined {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? undefined : { x: v.x / len, y: v.y / len };
}

/** `p` rotated about `center` onto `angle`, keeping its distance from `center`. */
function rotateOnto(center: Vec2, p: Vec2, angle: number): Vec2 {
  const r = distance(center, p);
  return { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) };
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Perpendicular distance from `p` to the infinite line through `a` and `b`. */
function distanceToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  return len === 0 ? distance(p, a) : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Whether `angle` lies on the arc sweeping clockwise on screen from `start` to `end`. */
function angleInSweep(angle: number, start: number, end: number): boolean {
  let a = angle;
  while (a < start) a += TAU;
  while (a > start + TAU) a -= TAU;
  return a <= end;
}

/**
 * Direction of the tangent at an arc endpoint, pointing away from the arc so a
 * new segment extends it smoothly. At the start the arc travels towards the
 * sweep, so "away" is the reverse of that travel.
 */
function arcTangentAngle(center: Vec2, endpoint: Vec2, atStart: boolean): number {
  const a = angleOf(center, endpoint);
  return atStart ? a - Math.PI / 2 : a + Math.PI / 2;
}

function nearestPoint(
  sketch: Sketch,
  p: Vec2,
  tolerance: number,
  isExcluded: (id: Id) => boolean,
): Point | undefined {
  let best: { point: Point; d: number } | undefined;
  for (const e of sketch.entities) {
    if (e.kind !== 'point' || isExcluded(e.id)) continue;
    const d = distance(e, p);
    if (d > tolerance) continue;
    if (best === undefined || d < best.d) best = { point: e, d };
  }
  return best?.point;
}

/** Arc whose endpoint is the anchor and whose tangent there matches `theta`. */
function tangentAt(
  sketch: Sketch,
  anchor: Anchor,
  theta: number,
  angleTol: number,
  isExcluded: (id: Id) => boolean,
  pt: PointLookup,
): { id: Id; angle: number } | undefined {
  if (anchor.id === undefined) return undefined;
  let best: { id: Id; angle: number; delta: number } | undefined;
  for (const e of sketch.entities) {
    if (e.kind !== 'arc' || isExcluded(e.id)) continue;
    const atStart = e.start === anchor.id;
    if (!atStart && e.end !== anchor.id) continue;
    const center = pt(e.center);
    const angle = arcTangentAngle(center, pt(atStart ? e.start : e.end), atStart);
    const delta = angleDelta(theta, angle);
    if (delta > angleTol) continue;
    if (best === undefined || delta < best.delta) best = { id: e.id, angle, delta };
  }
  return best;
}

/** Tangent first, then H/V, then parallel/perpendicular against the reference line. */
function inferDirection(
  sketch: Sketch,
  cursor: Vec2,
  anchor: Anchor,
  reference: Id | undefined,
  angleTol: number,
  isExcluded: (id: Id) => boolean,
  pt: PointLookup,
): Direction | undefined {
  const theta = Math.atan2(cursor.y - anchor.position.y, cursor.x - anchor.position.x);

  const tangent = tangentAt(sketch, anchor, theta, angleTol, isExcluded, pt);
  if (tangent !== undefined) {
    return {
      constraint: { kind: 'tangent', target: tangent.id },
      position: rotateOnto(anchor.position, cursor, tangent.angle),
    };
  }

  if (alongLine(theta, 0).delta <= angleTol) {
    return {
      constraint: { kind: 'horizontal' },
      axis: 'y',
      position: { x: cursor.x, y: anchor.position.y },
    };
  }
  if (alongLine(theta, Math.PI / 2).delta <= angleTol) {
    return {
      constraint: { kind: 'vertical' },
      axis: 'x',
      position: { x: anchor.position.x, y: cursor.y },
    };
  }

  if (reference === undefined || isExcluded(reference)) return undefined;
  const line = sketch.entities.find((e) => e.id === reference);
  if (line?.kind !== 'line') return undefined;
  const a = pt(line.p1);
  const b = pt(line.p2);
  if (distance(a, b) === 0) return undefined;
  const ref = Math.atan2(b.y - a.y, b.x - a.x);
  const parallel = alongLine(theta, ref);
  if (parallel.delta <= angleTol) {
    return {
      constraint: { kind: 'parallel', target: line.id },
      position: rotateOnto(anchor.position, cursor, parallel.angle),
    };
  }
  const perpendicular = alongLine(theta, ref + Math.PI / 2);
  if (perpendicular.delta <= angleTol) {
    return {
      constraint: { kind: 'perpendicular', target: line.id },
      position: rotateOnto(anchor.position, cursor, perpendicular.angle),
    };
  }
  return undefined;
}

/** Cursor projected onto a curve, following the same reach as `distanceTo`. */
function projectOnto(entity: Curve, p: Vec2, pt: PointLookup): Vec2 {
  switch (entity.kind) {
    case 'line':
      return closestOnSegment(p, pt(entity.p1), pt(entity.p2));
    case 'circle': {
      const c = pt(entity.center);
      const d = distance(c, p);
      if (d === 0) return p;
      const s = entity.radius / d;
      return { x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s };
    }
    case 'arc': {
      const c = pt(entity.center);
      const { radius, startAngle, endAngle } = arcParams(c, pt(entity.start), pt(entity.end));
      const a = angleOf(c, p);
      if (angleInSweep(a, startAngle, endAngle)) {
        return { x: c.x + radius * Math.cos(a), y: c.y + radius * Math.sin(a) };
      }
      const start = pt(entity.start);
      const end = pt(entity.end);
      return distance(start, p) <= distance(end, p) ? start : end;
    }
  }
}

/**
 * Where the infinite line `origin + t·dir` meets a curve. `onLine` is a point
 * already on that line; a collinear segment is met along its whole length, so
 * the closest point on it is the intersection.
 */
function lineCurveIntersections(
  origin: Vec2,
  dir: Vec2,
  entity: Curve,
  pt: PointLookup,
  onLine: Vec2,
): Vec2[] {
  switch (entity.kind) {
    case 'line': {
      const a = pt(entity.p1);
      const b = pt(entity.p2);
      const e = { x: b.x - a.x, y: b.y - a.y };
      const denom = dir.x * e.y - dir.y * e.x;
      const r = { x: a.x - origin.x, y: a.y - origin.y };
      if (denom === 0) {
        return distanceToLine(origin, a, b) < LINE_EPS ? [closestOnSegment(onLine, a, b)] : [];
      }
      const t = (r.x * e.y - r.y * e.x) / denom;
      const u = (r.x * dir.y - r.y * dir.x) / denom;
      if (u < 0 || u > 1) return [];
      return [{ x: origin.x + t * dir.x, y: origin.y + t * dir.y }];
    }
    case 'circle':
      return circleLineHits(origin, dir, pt(entity.center), {
        radius: entity.radius,
        startAngle: 0,
        endAngle: TAU,
      });
    case 'arc': {
      const c = pt(entity.center);
      return circleLineHits(origin, dir, c, arcParams(c, pt(entity.start), pt(entity.end)));
    }
  }
}

function circleLineHits(origin: Vec2, dir: Vec2, c: Vec2, params: ArcParams): Vec2[] {
  const { radius, startAngle, endAngle } = params;
  const mx = origin.x - c.x;
  const my = origin.y - c.y;
  const dd = dir.x * dir.x + dir.y * dir.y;
  const b = mx * dir.x + my * dir.y;
  const k = mx * mx + my * my - radius * radius;
  const disc = b * b - dd * k;
  if (dd === 0 || disc < 0) return [];
  const root = Math.sqrt(disc);
  const hits: Vec2[] = [];
  for (const t of [(-b - root) / dd, (-b + root) / dd]) {
    const p = { x: origin.x + t * dir.x, y: origin.y + t * dir.y };
    if (!angleInSweep(angleOf(c, p), startAngle, endAngle)) continue;
    hits.push(p);
  }
  return hits;
}

/**
 * Nearest non-excluded curve within tolerance. Without a direction constraint
 * the cursor is projected onto it; with one, the constrained line through the
 * anchor has to actually meet it, otherwise the curve snap is dropped.
 */
function snapToCurve(
  sketch: Sketch,
  position: Vec2,
  anchor: Vec2 | undefined,
  constrained: boolean,
  tolerance: number,
  isExcluded: (id: Id) => boolean,
  pt: PointLookup,
): { id: Id; position: Vec2 } | undefined {
  let best: { entity: Curve; d: number } | undefined;
  for (const e of sketch.entities) {
    if (e.kind === 'point' || isExcluded(e.id)) continue;
    const d = distanceTo(e, position, pt);
    if (d > tolerance) continue;
    if (best === undefined || d < best.d) best = { entity: e, d };
  }
  if (best === undefined) return undefined;
  if (!constrained || anchor === undefined) {
    return { id: best.entity.id, position: projectOnto(best.entity, position, pt) };
  }
  const dir = unit({ x: position.x - anchor.x, y: position.y - anchor.y });
  if (dir === undefined) return undefined;
  let hit: Vec2 | undefined;
  for (const candidate of lineCurveIntersections(anchor, dir, best.entity, pt, position)) {
    if (distance(candidate, position) > tolerance) continue;
    if (hit === undefined || distance(candidate, position) < distance(hit, position))
      hit = candidate;
  }
  return hit === undefined ? undefined : { id: best.entity.id, position: hit };
}

interface AlignmentHit {
  readonly alignment: Alignment;
  readonly coordinate: number;
}

/** Nearest non-excluded point sharing one coordinate of `position`. */
function nearestOnAxis(
  sketch: Sketch,
  position: Vec2,
  axis: 'x' | 'y',
  tolerance: number,
  isExcluded: (id: Id) => boolean,
  skip: (p: Point) => boolean,
): AlignmentHit | undefined {
  const target = axis === 'x' ? position.x : position.y;
  let best: { id: Id; coordinate: number; d: number } | undefined;
  for (const e of sketch.entities) {
    if (e.kind !== 'point' || isExcluded(e.id) || skip(e)) continue;
    const coordinate = axis === 'x' ? e.x : e.y;
    const d = Math.abs(coordinate - target);
    if (d > tolerance) continue;
    if (best === undefined || d < best.d) best = { id: e.id, coordinate, d };
  }
  return best === undefined
    ? undefined
    : { alignment: { source: best.id, axis }, coordinate: best.coordinate };
}

/**
 * Snaps the free coordinates of `position` onto the nearest point per axis.
 * `axis` is the coordinate an H/V constraint pins: that axis is left to the
 * constraint, and on the other one a point already sitting on the constraint
 * line through the anchor is not worth a guide.
 */
function alignTo(
  sketch: Sketch,
  position: Vec2,
  anchor: Anchor | undefined,
  axis: 'x' | 'y' | undefined,
  tolerance: number,
  isExcluded: (id: Id) => boolean,
): { alignments: Alignment[]; position: Vec2 } {
  const alignments: Alignment[] = [];
  let x = position.x;
  let y = position.y;
  const skip = (p: Point): boolean => {
    if (anchor === undefined) return false;
    if (anchor.id !== undefined && p.id === anchor.id) return true;
    if (distance(p, anchor.position) <= LINE_EPS) return true;
    if (axis !== undefined) {
      const off = axis === 'x' ? p.x - anchor.position.x : p.y - anchor.position.y;
      if (Math.abs(off) <= tolerance) return true;
    }
    return false;
  };
  const onX =
    axis === 'x' ? undefined : nearestOnAxis(sketch, position, 'x', tolerance, isExcluded, skip);
  const onY =
    axis === 'y' ? undefined : nearestOnAxis(sketch, position, 'y', tolerance, isExcluded, skip);
  if (onX !== undefined) {
    x = onX.coordinate;
    alignments.push(onX.alignment);
  }
  if (onY !== undefined) {
    y = onY.coordinate;
    alignments.push(onY.alignment);
  }
  return { alignments, position: { x, y } };
}

/**
 * Snaps `cursor` onto nearby geometry and reports what the UI should show:
 * the inferred constraints created on click, plus visual-only alignment
 * guides. Rules apply in priority order — a point hit wins outright, then the
 * direction constraints relative to the anchor, then the curve snap, then the
 * alignments.
 */
export function infer(sketch: Sketch, cursor: Vec2, options: InferenceOptions): InferenceResult {
  if (!options.enabled) return { position: cursor, constraints: [], alignments: [] };

  const pt = pointLookup(sketch);
  const { tolerance } = options;
  const angleTol = degToRad(options.angleTolerance ?? DEFAULT_ANGLE_TOLERANCE);
  const isExcluded = (id: Id): boolean => options.exclude?.has(id) === true;

  // Reusing an existing point says everything; nothing else is inferred.
  const snapped = nearestPoint(sketch, cursor, tolerance, isExcluded);
  if (snapped !== undefined) {
    return {
      position: { x: snapped.x, y: snapped.y },
      constraints: [{ kind: 'coincident', target: snapped.id }],
      alignments: [],
    };
  }

  let position = cursor;
  let direction: Direction | undefined;
  const anchor = options.anchor;
  if (anchor !== undefined && distance(cursor, anchor.position) > tolerance) {
    direction = inferDirection(sketch, cursor, anchor, options.reference, angleTol, isExcluded, pt);
    if (direction !== undefined) position = direction.position;
  }

  const curve = snapToCurve(
    sketch,
    position,
    anchor?.position,
    direction !== undefined,
    tolerance,
    isExcluded,
    pt,
  );
  if (curve !== undefined) position = curve.position;

  const constraints: InferredConstraint[] = [];
  if (direction !== undefined) constraints.push(direction.constraint);
  if (curve !== undefined) constraints.push({ kind: 'pointOnCurve', target: curve.id });

  // A curve snap fixed both coordinates, so there is nothing left to align.
  if (curve !== undefined) return { position, constraints, alignments: [] };
  const aligned = alignTo(sketch, position, anchor, direction?.axis, tolerance, isExcluded);
  return { position: aligned.position, constraints, alignments: aligned.alignments };
}

/**
 * Turns inferred constraints into model constraints once the user clicks.
 * `point` is the id of the (new or reused) point at the cursor, `segment` the new line from anchor to it
 * (if the command creates one), `anchor` the anchor point id.
 * - coincident → [] (the caller reused the point)
 * - pointOnCurve → pointOnLine when target is a line, else pointOnCurve
 * - horizontal/vertical → on `segment` if given ({kind:'horizontal', a: segment}); else between anchor and point ({kind, a: anchor, b: point}); else []
 * - parallel/perpendicular/tangent → need `segment`, else []
 */
export function materialize(
  inferred: readonly InferredConstraint[],
  ids: { readonly point: Id; readonly segment?: Id; readonly anchor?: Id },
  sketch: Sketch,
): ConstraintInput[] {
  const index = indexEntities(sketch);
  const out: ConstraintInput[] = [];
  for (const c of inferred) {
    switch (c.kind) {
      case 'coincident':
        // The caller reused the point, so there is nothing to add.
        break;
      case 'pointOnCurve':
        out.push(
          index.get(c.target)?.kind === 'line'
            ? { kind: 'pointOnLine', point: ids.point, line: c.target }
            : { kind: 'pointOnCurve', point: ids.point, curve: c.target },
        );
        break;
      case 'horizontal':
      case 'vertical':
        if (ids.segment !== undefined) out.push({ kind: c.kind, a: ids.segment });
        else if (ids.anchor !== undefined) out.push({ kind: c.kind, a: ids.anchor, b: ids.point });
        break;
      case 'parallel':
      case 'perpendicular':
      case 'tangent':
        if (ids.segment !== undefined) out.push({ kind: c.kind, a: ids.segment, b: c.target });
        break;
    }
  }
  return out;
}
