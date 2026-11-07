import { angleOf, arcParams, distance } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Entity, Id, Point } from '../core/model';
import type { Sketch } from '../core/sketch';
import type { Box } from './viewport';

const TAU = Math.PI * 2;

export type PointLookup = (id: Id) => Point;

export function pointLookup(sketch: Sketch): PointLookup {
  const points = new Map<Id, Point>();
  for (const e of sketch.entities) {
    if (e.kind === 'point') points.set(e.id, e);
  }
  return (id) => {
    const p = points.get(id);
    if (p === undefined) throw new Error(`Unknown point "${id}"`);
    return p;
  };
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether `angle` lies on the arc sweeping clockwise on screen from `start` to `end`. */
function angleOnArc(angle: number, start: number, end: number): boolean {
  let a = angle;
  while (a < start) a += TAU;
  while (a > start + TAU) a -= TAU;
  return a <= end;
}

/** Distance from `p` to the entity's geometry, in world units. */
export function distanceTo(entity: Entity, p: Vec2, pt: PointLookup): number {
  switch (entity.kind) {
    case 'point':
      return distance(entity, p);
    case 'line':
      return distanceToSegment(p, pt(entity.p1), pt(entity.p2));
    case 'circle':
      return Math.abs(distance(pt(entity.center), p) - entity.radius);
    case 'arc': {
      const c = pt(entity.center);
      const s = pt(entity.start);
      const e = pt(entity.end);
      const { radius, startAngle, endAngle } = arcParams(c, s, e);
      if (angleOnArc(angleOf(c, p), startAngle, endAngle)) {
        return Math.abs(distance(c, p) - radius);
      }
      return Math.min(distance(s, p), distance(e, p));
    }
  }
}

export interface HitOptions {
  /** World-space tolerance. */
  readonly tolerance: number;
  /** Entities to skip, e.g. the point being dragged. */
  readonly exclude?: ReadonlySet<Id>;
}

/**
 * The entity under `p`. Points win over curves when both are within
 * tolerance, so endpoints stay grabbable where curves meet.
 */
export function hitTest(
  sketch: Sketch,
  p: Vec2,
  { tolerance, exclude }: HitOptions,
): Id | undefined {
  const pt = pointLookup(sketch);
  let best: { id: Id; d: number; point: boolean } | undefined;
  for (const e of sketch.entities) {
    if (exclude?.has(e.id)) continue;
    const d = distanceTo(e, p, pt);
    if (d > tolerance) continue;
    const point = e.kind === 'point';
    if (best === undefined || (point && !best.point) || (point === best.point && d < best.d)) {
      best = { id: e.id, d, point };
    }
  }
  return best?.id;
}

function inside(p: Vec2, box: Box): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentTouchesBox(a: Vec2, b: Vec2, box: Box): boolean {
  if (inside(a, box) || inside(b, box)) return true;
  const corners: Vec2[] = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  return corners.some((c, i) => segmentsIntersect(a, b, c, corners[(i + 1) % 4]!));
}

/** Polyline approximation of a circular arc, fine enough for box tests. */
function arcSamples(c: Vec2, r: number, start: number, end: number): Vec2[] {
  const n = Math.max(8, Math.ceil(((end - start) / TAU) * 96));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = start + ((end - start) * i) / n;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

function polylineTouchesBox(points: Vec2[], box: Box): boolean {
  return points.some((p, i) => i > 0 && segmentTouchesBox(points[i - 1]!, p, box));
}

function curveSamples(entity: Entity, pt: PointLookup): Vec2[] {
  switch (entity.kind) {
    case 'point':
      return [entity];
    case 'line':
      return [pt(entity.p1), pt(entity.p2)];
    case 'circle': {
      const c = pt(entity.center);
      return arcSamples(c, entity.radius, 0, TAU);
    }
    case 'arc': {
      const c = pt(entity.center);
      const { radius, startAngle, endAngle } = arcParams(c, pt(entity.start), pt(entity.end));
      return arcSamples(c, radius, startAngle, endAngle);
    }
  }
}

/**
 * Window selection keeps entities fully inside the box; crossing selection
 * also keeps entities that touch it (Inventor: left-to-right vs right-to-left).
 */
export function boxSelect(sketch: Sketch, box: Box, mode: 'window' | 'crossing'): Id[] {
  const pt = pointLookup(sketch);
  return sketch.entities
    .filter((e) => {
      const samples = curveSamples(e, pt);
      if (mode === 'window' || e.kind === 'point') return samples.every((p) => inside(p, box));
      return polylineTouchesBox(samples, box);
    })
    .map((e) => e.id);
}

/** World bounds of all geometry, or undefined for an empty sketch. */
export function sketchBounds(sketch: Sketch): Box | undefined {
  const pt = pointLookup(sketch);
  let box: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
  for (const e of sketch.entities) {
    for (const p of curveSamples(e, pt)) {
      if (box === undefined) {
        box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      } else {
        box.minX = Math.min(box.minX, p.x);
        box.minY = Math.min(box.minY, p.y);
        box.maxX = Math.max(box.maxX, p.x);
        box.maxY = Math.max(box.maxY, p.y);
      }
    }
  }
  return box;
}
