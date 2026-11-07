import { angleOf, arcParams, distance, lineIntersection } from './geometry';
import type { Vec2 } from './geometry';
import type { Entity, Id, Point } from './model';
import type { EntityIndex } from './sketch';

const TAU = Math.PI * 2;

/** World px. Two points closer than this are the same point. */
const EPS = 1e-9;

/**
 * A curve reduced to what intersection math needs. An arc only exists inside its sweep.
 */
export type Intersectable =
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 }
  | { readonly kind: 'circle'; readonly center: Vec2; readonly radius: number }
  | {
      readonly kind: 'arc';
      readonly center: Vec2;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
    };

/** What a circle and an arc share: a whole turn of geometry, however it is drawn. */
type Round = { readonly center: Vec2; readonly radius: number };

/** The members of `Intersectable`, for the helpers that handle a single kind. */
type Line = Extract<Intersectable, { kind: 'line' }>;
type Arc = Extract<Intersectable, { kind: 'arc' }>;

/** A curve with ends to trim or extend: everything but a circle. */
type Ended = Exclude<Intersectable, { kind: 'circle' }>;

/**
 * Where a point falls relative to a curve's span, seen from one end: `inside`
 * the span, `beyond` that end, or `far` — out of reach from it. `far` covers
 * the other side of the span, and the slop around either end, where moving the
 * curve to meet the point would change nothing.
 */
type SpanSide = 'inside' | 'beyond' | 'far';

// ── Entities ──────────────────────────────────────────────────────────────

function pointAt(index: EntityIndex, id: Id): Point | undefined {
  const entity = index.get(id);
  return entity?.kind === 'point' ? entity : undefined;
}

/** A point's position, without the entity wrapped around it. */
function vec(p: Point): Vec2 {
  return { x: p.x, y: p.y };
}

/** An entity as an Intersectable, or undefined when it is a point or degenerate (zero length/radius). */
export function curveOf(entity: Entity, index: EntityIndex): Intersectable | undefined {
  switch (entity.kind) {
    case 'point':
      return undefined;
    case 'line': {
      const a = pointAt(index, entity.p1);
      const b = pointAt(index, entity.p2);
      // A zero-length line has no direction to run in, so no span to cross or trim.
      if (a === undefined || b === undefined || distance(a, b) === 0) return undefined;
      return { kind: 'line', a: vec(a), b: vec(b) };
    }
    case 'circle': {
      const center = pointAt(index, entity.center);
      // A zero radius is a point in a circle's clothes.
      if (center === undefined || entity.radius <= 0) return undefined;
      return { kind: 'circle', center: vec(center), radius: entity.radius };
    }
    case 'arc': {
      const center = pointAt(index, entity.center);
      const start = pointAt(index, entity.start);
      const end = pointAt(index, entity.end);
      if (center === undefined || start === undefined || end === undefined) return undefined;
      const { radius, startAngle, endAngle } = arcParams(center, start, end);
      // A zero radius collapses the arc onto its centre.
      if (radius <= 0) return undefined;
      return { kind: 'arc', center: vec(center), radius, startAngle, endAngle };
    }
  }
}

// ── Crossings ─────────────────────────────────────────────────────────────

/**
 * Every point where two curves cross. Lines are INFINITE, a circle is FULL; an
 * arc only crosses inside its sweep (startAngle → endAngle clockwise on screen,
 * the convention of `arcParams` in core/geometry). Deterministic order.
 */
export function intersections(x: Intersectable, y: Intersectable): readonly Vec2[] {
  // A zero radius or a zero-length line is not a curve, so nothing crosses it.
  if (degenerate(x) || degenerate(y)) return [];
  return canonical(cross(x, y));
}

function degenerate(curve: Intersectable): boolean {
  switch (curve.kind) {
    case 'line':
      return distance(curve.a, curve.b) === 0;
    case 'circle':
    case 'arc':
      return curve.radius <= 0;
  }
}

function cross(x: Intersectable, y: Intersectable): Vec2[] {
  switch (x.kind) {
    case 'line':
      switch (y.kind) {
        case 'line':
          return lineLine(x, y);
        case 'circle':
          return lineCircle(x, y);
        case 'arc':
          return inSweep(lineCircle(x, y), y);
      }
    case 'circle':
      switch (y.kind) {
        case 'line':
          return lineCircle(y, x);
        case 'circle':
          return circleCircle(x, y);
        case 'arc':
          return inSweep(circleCircle(x, y), y);
      }
    case 'arc':
      switch (y.kind) {
        case 'line':
          return inSweep(lineCircle(y, x), x);
        case 'circle':
          return inSweep(circleCircle(y, x), x);
        case 'arc':
          return inSweep(inSweep(circleCircle(x, y), x), y);
      }
  }
}

function lineLine(x: Line, y: Line): Vec2[] {
  // Parallel and coincident lines have no single crossing to report.
  const p = lineIntersection(x.a, x.b, y.a, y.b);
  return p === undefined ? [] : [p];
}

/**
 * Where the infinite line through `a`–`b` meets the full circle: the roots of
 * |a + t·(b − a) − centre|² = r². A tangent line's discriminant sits on zero,
 * give or take rounding, so it is clamped there and the two equal roots
 * collapse in `canonical`.
 */
function lineCircle(line: Line, round: Round): Vec2[] {
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  const fx = line.a.x - round.center.x;
  const fy = line.a.y - round.center.y;
  const dd = dx * dx + dy * dy;
  const rr = round.radius * round.radius;
  const fd = fx * dx + fy * dy;
  const ff = fx * fx + fy * fy;
  let disc = fd * fd - dd * (ff - rr);
  if (disc < 0) {
    if (disc < -EPS * Math.max(dd * rr, 1)) return [];
    disc = 0;
  }
  const root = Math.sqrt(disc);
  const at = (t: number): Vec2 => ({ x: line.a.x + t * dx, y: line.a.y + t * dy });
  return [at((-fd - root) / dd), at((-fd + root) / dd)];
}

/** Where two full circles meet: the standard two-point formula. */
function circleCircle(x: Round, y: Round): Vec2[] {
  const dx = y.center.x - x.center.x;
  const dy = y.center.y - x.center.y;
  const d = Math.hypot(dx, dy);
  // Concentric circles never meet: they are nested, or they are one circle
  // lying on the other and meet everywhere.
  if (d === 0) return [];
  const sum = x.radius + y.radius;
  const gap = Math.abs(x.radius - y.radius);
  if (d > sum + EPS || d + EPS < gap) return [];
  const a = (d * d + x.radius * x.radius - y.radius * y.radius) / (2 * d);
  // Tangent circles meet once: the offset across the centre line collapses.
  const h = Math.sqrt(Math.max(0, x.radius * x.radius - a * a));
  const ux = dx / d;
  const uy = dy / d;
  const bx = x.center.x + a * ux;
  const by = x.center.y + a * uy;
  return [
    { x: bx - h * uy, y: by + h * ux },
    { x: bx + h * uy, y: by - h * ux },
  ];
}

/** The crossings that lie on the arc, the ends of its sweep included. */
function inSweep(points: readonly Vec2[], arc: Arc): Vec2[] {
  const sweep = arc.endAngle - arc.startAngle;
  // The tolerance read as an angle, so a crossing landing on an end still counts.
  const eps = EPS / arc.radius;
  return points.filter((p) => {
    const off = offset(angleOf(arc.center, p), arc.startAngle);
    return off >= -eps && off <= sweep + eps;
  });
}

/** `angle` measured clockwise from `start`, in [0, 2π). */
function offset(angle: number, start: number): number {
  const off = (angle - start) % TAU;
  return off < 0 ? off + TAU : off;
}

/**
 * Ordered by x then y — so the answer never depends on which curve came first
 * — with crossings that coincide within EPS collapsed to the first of them.
 */
function canonical(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  const out: Vec2[] = [];
  for (const p of sorted) {
    const last = out.at(-1);
    if (last !== undefined && distance(p, last) <= EPS) continue;
    out.push(p);
  }
  return out;
}

// ── Trimming and extending ────────────────────────────────────────────────

/**
 * The nearest crossing of `curve` with any of `others` that lies INSIDE its
 * span — where a trim shortens it to. Undefined when there is none.
 */
export function trimTarget(
  curve: Intersectable,
  end: 'start' | 'end',
  others: readonly Intersectable[],
): Vec2 | undefined {
  // A circle has no ends to shorten towards.
  if (curve.kind === 'circle') return undefined;
  return nearestCrossing(curve, end, others, 'inside');
}

/** The nearest crossing that lies BEYOND `end` along the curve — where an extend lengthens it to. Undefined when there is none. */
export function extendTarget(
  curve: Intersectable,
  end: 'start' | 'end',
  others: readonly Intersectable[],
): Vec2 | undefined {
  // A circle has no ends to lengthen from.
  if (curve.kind === 'circle') return undefined;
  return nearestCrossing(curve, end, others, 'beyond');
}

function nearestCrossing(
  curve: Ended,
  end: 'start' | 'end',
  others: readonly Intersectable[],
  want: SpanSide,
): Vec2 | undefined {
  // A degenerate curve has no span to speak of.
  if (degenerate(curve)) return undefined;
  // An arc only crosses inside its sweep, but an extend reaches the crossings
  // that lie outside it, so the search runs against the whole circle the arc
  // sits on; the span itself then decides which of them count.
  const probe = fullOf(curve);
  let best: Vec2 | undefined;
  let bestMeasure = Infinity;
  for (const other of others) {
    // Callers hand the curve back among the others; its own ends are not targets.
    if (sameCurve(curve, other)) continue;
    for (const p of intersections(probe, other)) {
      if (sideOf(curve, end, p) !== want) continue;
      const measure = measureAlong(curve, end, p);
      if (measure < bestMeasure) {
        bestMeasure = measure;
        best = p;
      }
    }
  }
  return best;
}

/** The curve with its span opened out: an arc becomes the circle it lies on. */
function fullOf(curve: Ended): Intersectable {
  return curve.kind === 'arc'
    ? { kind: 'circle', center: curve.center, radius: curve.radius }
    : curve;
}

function sideOf(curve: Ended, end: 'start' | 'end', p: Vec2): SpanSide {
  // An arc's outside is shared by both ends — past the end angle clockwise is
  // also before the start angle the other way round — so only a line's answer
  // depends on which end is asked about.
  return curve.kind === 'line' ? lineSide(curve, end, p) : arcSide(curve, p);
}

function lineSide(line: Line, end: 'start' | 'end', p: Vec2): SpanSide {
  const dx = line.b.x - line.a.x;
  const dy = line.b.y - line.a.y;
  const t = ((p.x - line.a.x) * dx + (p.y - line.a.y) * dy) / (dx * dx + dy * dy);
  // A crossing within EPS of either end is where the line already ends: moving
  // to it would change nothing, and the far end is out of reach from here.
  if (distance(p, line.a) <= EPS || distance(p, line.b) <= EPS) return 'far';
  if (t > 0 && t < 1) return 'inside';
  const pastB = t > 1;
  if (end === 'end') return pastB ? 'beyond' : 'far';
  return pastB ? 'far' : 'beyond';
}

function arcSide(arc: Arc, p: Vec2): SpanSide {
  const start = onCircle(arc, arc.startAngle);
  const finish = onCircle(arc, arc.endAngle);
  const sweep = arc.endAngle - arc.startAngle;
  const off = offset(angleOf(arc.center, p), arc.startAngle);
  // Within EPS of either end is where the arc already ends: moving to it would
  // change nothing, and the far end is out of reach from here. A point just
  // before the start is EPS from it as well, however it is measured round.
  if (distance(p, start) <= EPS || distance(p, finish) <= EPS) return 'far';
  // The same epsilon read as an angle, so a crossing a hair inside an end
  // counts as sitting on it.
  const eps = EPS / arc.radius;
  if (off <= eps || (off >= sweep - eps && off <= sweep + eps)) return 'far';
  if (off < sweep) return 'inside';
  // Past the end angle clockwise is also before the start angle the other way
  // round, so both ends reach the same outside; only the ranking differs.
  return 'beyond';
}

/** The point on a round curve at `angle`. */
function onCircle(round: Round, angle: number): Vec2 {
  return {
    x: round.center.x + round.radius * Math.cos(angle),
    y: round.center.y + round.radius * Math.sin(angle),
  };
}

/** How far `p` is from the `end` endpoint, measured along the curve, not straight. */
function measureAlong(curve: Ended, end: 'start' | 'end', p: Vec2): number {
  if (curve.kind === 'line') return distance(p, end === 'end' ? curve.b : curve.a);
  const off = offset(angleOf(curve.center, p), curve.startAngle);
  const sweep = curve.endAngle - curve.startAngle;
  const ahead = off > sweep;
  // Outside the sweep the distance runs on round the circle — clockwise for
  // 'end', anticlockwise back to the start for 'start' — and inside it runs
  // back along the sweep.
  if (end === 'end') return curve.radius * (ahead ? off - sweep : sweep - off);
  return curve.radius * (ahead ? TAU - off : off);
}

/**
 * Whether two Intersectables describe the same curve, within EPS. Callers hand
 * the curve back among `others`, and its own ends must not count as targets.
 */
function sameCurve(x: Intersectable, y: Intersectable): boolean {
  if (x.kind === 'line' && y.kind === 'line') {
    // Either order: the same two points describe the same segment.
    return (
      (samePoint(x.a, y.a) && samePoint(x.b, y.b)) || (samePoint(x.a, y.b) && samePoint(x.b, y.a))
    );
  }
  if (x.kind === 'circle' && y.kind === 'circle') {
    return samePoint(x.center, y.center) && Math.abs(x.radius - y.radius) <= EPS;
  }
  if (x.kind === 'arc' && y.kind === 'arc') {
    if (!samePoint(x.center, y.center) || Math.abs(x.radius - y.radius) > EPS) return false;
    // The same arc can come back with its angles a full turn apart, so compare
    // the ends as points: they carry the direction the arc is drawn in.
    return (
      samePoint(onCircle(x, x.startAngle), onCircle(y, y.startAngle)) &&
      samePoint(onCircle(x, x.endAngle), onCircle(y, y.endAngle))
    );
  }
  return false;
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return distance(a, b) <= EPS;
}
