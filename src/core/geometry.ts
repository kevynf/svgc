import type { Entity, Id, Point } from './model';
import { indexEntities } from './sketch';
import type { EntityIndex, Sketch } from './sketch';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface ArcParams {
  readonly radius: number;
  readonly startAngle: number;
  /** Always in (startAngle, startAngle + 2π]. */
  readonly endAngle: number;
}

const TAU = Math.PI * 2;

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function angleOf(center: Vec2, p: Vec2): number {
  return Math.atan2(p.y - center.y, p.x - center.x);
}

export function arcParams(center: Vec2, start: Vec2, end: Vec2): ArcParams {
  const startAngle = angleOf(center, start);
  let endAngle = angleOf(center, end);
  while (endAngle <= startAngle) {
    endAngle += TAU;
  }
  while (endAngle > startAngle + TAU) {
    endAngle -= TAU;
  }
  return { radius: distance(center, start), startAngle, endAngle };
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Direction of the line a→b in degrees, counterclockwise on screen. The SVG Y
 * axis points down, so a line toward the upper right reads +45°.
 */
export function screenAngle(dx: number, dy: number): number {
  const deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return deg === 0 ? 0 : deg;
}

/** Direction of a→b in degrees, counterclockwise on screen: the point-to-point form of screenAngle. */
export function directionDeg(a: Vec2, b: Vec2): number {
  return screenAngle(b.x - a.x, b.y - a.y);
}

/** Perpendicular distance from `p` to the infinite line through `a` and `b`. */
export function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  // A degenerate line has no direction; the distance to its point is the only sensible answer.
  if (len === 0) return distance(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Degrees wrapped into [0, 360), so an angle reads the same whichever way it was measured. */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Angle from the line a1–a2 to the line b1–b2, counterclockwise on screen and
 * wrapped into [0, 360): the convention the model's angle constraint uses.
 */
export function lineAngleDeg(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  return normalizeDeg(directionDeg(b1, b2) - directionDeg(a1, a2));
}

/** `v` scaled to length 1, or undefined when it has no direction. */
export function unit(v: Vec2): Vec2 | undefined {
  const len = Math.hypot(v.x, v.y);
  return len === 0 ? undefined : { x: v.x / len, y: v.y / len };
}

export function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Closest point to `p` on the segment a–b. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a);
  const len2 = d.x * d.x + d.y * d.y;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2));
  return { x: a.x + t * d.x, y: a.y + t * d.y };
}

/** Where the segment p1–p2 crosses p3–p4, or undefined when they are parallel. */
export function lineIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | undefined {
  const d1 = sub(p2, p1);
  const d2 = sub(p4, p3);
  const den = d1.x * d2.y - d1.y * d2.x;
  if (den === 0) return undefined;
  const t = ((p3.x - p1.x) * d2.y - (p3.y - p1.y) * d2.x) / den;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/**
 * Unit normal to a segment, on the outward side of a clockwise outline: above
 * a left-to-right line, right of a top-to-bottom one.
 */
export function segmentNormal(a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a);
  const len = Math.hypot(d.x, d.y);
  return len === 0 ? { x: 0, y: -1 } : { x: d.y / len, y: -d.x / len };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** `v` scaled by `k`. */
export function scaled(v: Vec2, k: number): Vec2 {
  return { x: v.x * k, y: v.y * k };
}

// ── Extent ───────────────────────────────────────────────────────────────

export interface Extent {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function extentOf(points: readonly Vec2[]): Extent {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('Empty extent');
  let box: Extent = { minX: first.x, minY: first.y, maxX: first.x, maxY: first.y };
  for (const p of rest) {
    box = {
      minX: Math.min(box.minX, p.x),
      minY: Math.min(box.minY, p.y),
      maxX: Math.max(box.maxX, p.x),
      maxY: Math.max(box.maxY, p.y),
    };
  }
  return box;
}

/** Exact extent of a circular arc: its ends plus every axis crossing in the sweep. */
function arcExtent(center: Vec2, radius: number, startAngle: number, endAngle: number): Extent {
  const points = [
    { x: center.x + radius * Math.cos(startAngle), y: center.y + radius * Math.sin(startAngle) },
    { x: center.x + radius * Math.cos(endAngle), y: center.y + radius * Math.sin(endAngle) },
  ];
  for (const axis of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    let angle = axis;
    while (angle < startAngle) angle += TAU;
    if (angle > endAngle) continue;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return extentOf(points);
}

function pointAt(index: EntityIndex, id: Id): Point | undefined {
  const entity = index.get(id);
  return entity?.kind === 'point' ? entity : undefined;
}

/** Extent of one entity, or undefined when a curve is missing one of its points. */
function entityExtent(entity: Entity, index: EntityIndex): Extent | undefined {
  switch (entity.kind) {
    case 'point':
      return { minX: entity.x, minY: entity.y, maxX: entity.x, maxY: entity.y };
    case 'line': {
      const a = pointAt(index, entity.p1);
      const b = pointAt(index, entity.p2);
      return a === undefined || b === undefined ? undefined : extentOf([a, b]);
    }
    case 'circle': {
      const center = pointAt(index, entity.center);
      return center === undefined
        ? undefined
        : {
            minX: center.x - entity.radius,
            minY: center.y - entity.radius,
            maxX: center.x + entity.radius,
            maxY: center.y + entity.radius,
          };
    }
    case 'arc': {
      const center = pointAt(index, entity.center);
      const start = pointAt(index, entity.start);
      const end = pointAt(index, entity.end);
      if (center === undefined || start === undefined || end === undefined) return undefined;
      const { radius, startAngle, endAngle } = arcParams(center, start, end);
      return arcExtent(center, radius, startAngle, endAngle);
    }
  }
}

function union(a: Extent | undefined, b: Extent | undefined): Extent | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Exact extent of a sketch's geometry (points, lines, circles, arcs — an arc's
 * sweep crossings included), or undefined when there is no geometry. Curves
 * referencing a missing point contribute nothing rather than throwing, so a
 * sketch mid-edit still has a usable extent.
 */
export function sketchExtent(sketch: Sketch): Extent | undefined {
  const index = indexEntities(sketch);
  let box: Extent | undefined;
  for (const entity of sketch.entities) {
    box = union(box, entityExtent(entity, index));
  }
  return box;
}
