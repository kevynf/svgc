import type { ConstraintInput } from '../../core/builder';
import { arcParams, distance, lineAngleDeg, perpendicularDistance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Id } from '../../core/model';
import { indexEntities } from '../../core/sketch';
import type { EntityIndex, Sketch } from '../../core/sketch';
import type { DimensionSpec } from '../../render/dimensions';
import type { Operand, OperandKind, OperandSpec } from './constrain';

/**
 * What the driving and the driven dimension share: the operands they take and
 * the measurement those operands add up to. Both commands lay the dimension out
 * and draw it the same way; what differs is only what placing it commits — a
 * driving dimension carries a value the user types, a driven one the measurement
 * itself, flagged so the solver never enforces it.
 */

/** Every kind is pickable: the constraint follows from what the user picked. */
const ANY: readonly OperandKind[] = ['point', 'line', 'circle', 'arc'];

/** The operands both dimension commands take, in pick order. */
export const OBJECT: OperandSpec = { kinds: ANY, prompt: 'prompts.dimension' };
export const SECOND_OBJECT: OperandSpec = { kinds: ANY, prompt: 'prompts.dimensionSecond' };

/** A curve is dimensioned by a single pick, so it can never take a second one. */
export function isCurve(kind: OperandKind): boolean {
  return kind === 'circle' || kind === 'arc';
}

/** The dimensions a pick produces: the constraints that carry a measured value. */
export type DimensionConstraint = Extract<
  ConstraintInput,
  { kind: 'distance' | 'radius' | 'angle' }
>;

/** A distance measured between two points: what a line's length is. */
type PointDistance = Extract<ConstraintInput, { kind: 'distance' }>;

/** An angle measured between two lines. */
type LineAngle = Extract<ConstraintInput, { kind: 'angle' }>;

/**
 * What the picked operands measure: a circle or arc its radius, a line alone the
 * distance between its ends, two points a distance, a point and a line the
 * distance between them, and two lines the angle between them. Undefined when
 * they measure nothing, which leaves the pick pending: a line with no length has
 * no direction to lay a dimension along, and a curve never takes a second pick.
 */
export function measure(
  sketch: Sketch,
  picks: readonly Operand[],
): DimensionConstraint | undefined {
  const index = indexEntities(sketch);
  const [first, second] = picks;
  if (first === undefined) return undefined;
  // A curve carries its own dimension, so it completes on the first pick.
  if (isCurve(first.kind)) return radius(index, first.id);
  // So does a line on its own: the length of one is the distance between its
  // ends, so a single pick is the whole dimension.
  if (first.kind === 'line' && second === undefined) return length(index, first.id);
  if (second === undefined) return undefined;
  switch (second.kind) {
    case 'point':
      return first.kind === 'point'
        ? spread(index, first.id, second.id)
        : offset(index, second.id, first.id);
    case 'line':
      return first.kind === 'line'
        ? angle(index, first.id, second.id)
        : offset(index, first.id, second.id);
    default:
      return undefined;
  }
}

/** A line's two endpoints as they sit now, for a command drawing a preview. */
export function endsOf(sketch: Sketch, id: Id): { a: Vec2; b: Vec2 } | undefined {
  return lineEnds(indexEntities(sketch), id);
}

/** What a dimensional constraint measures: its operands, in the order its kind lists them. */
export function specOf(c: DimensionConstraint): DimensionSpec {
  switch (c.kind) {
    case 'distance':
    case 'angle':
      return { kind: c.kind, operands: [c.a, c.b] };
    case 'radius':
      return { kind: 'radius', operands: [c.curve] };
  }
}

/** Radius of a circle, or of an arc measured through its three points. */
function radius(index: EntityIndex, curve: Id): DimensionConstraint | undefined {
  const e = index.get(curve);
  if (e?.kind === 'circle') return { kind: 'radius', curve, value: e.radius };
  if (e?.kind !== 'arc') return undefined;
  const [center, start, end] = [
    pointAt(index, e.center),
    pointAt(index, e.start),
    pointAt(index, e.end),
  ];
  if (center === undefined || start === undefined || end === undefined) return undefined;
  return { kind: 'radius', curve, value: arcParams(center, start, end).radius };
}

/**
 * Length of a line: the distance between its two ends, measured end to end. It
 * is a point-to-point distance, so the dimension is laid out parallel to the
 * line with witness lines reaching to its ends. A zero-length line has no
 * direction to lay one along, so it measures nothing at all.
 */
function length(index: EntityIndex, line: Id): PointDistance | undefined {
  const e = index.get(line);
  if (e?.kind !== 'line') return undefined;
  const measured = spread(index, e.p1, e.p2);
  return measured === undefined || measured.value === 0 ? undefined : measured;
}

/** Distance between two points. */
function spread(index: EntityIndex, a: Id, b: Id): PointDistance | undefined {
  const [pa, pb] = [pointAt(index, a), pointAt(index, b)];
  if (pa === undefined || pb === undefined) return undefined;
  return { kind: 'distance', a, b, value: distance(pa, pb) };
}

/** Distance from a point to a line, the point first as the solver expects. */
function offset(index: EntityIndex, point: Id, line: Id): DimensionConstraint | undefined {
  const p = pointAt(index, point);
  const ends = lineEnds(index, line);
  if (p === undefined || ends === undefined) return undefined;
  return { kind: 'distance', a: point, b: line, value: perpendicularDistance(p, ends.a, ends.b) };
}

/** Degrees counterclockwise on screen, from line `a` to line `b`. */
function angle(index: EntityIndex, a: Id, b: Id): LineAngle | undefined {
  const [ea, eb] = [lineEnds(index, a), lineEnds(index, b)];
  if (ea === undefined || eb === undefined) return undefined;
  return { kind: 'angle', a, b, value: lineAngleDeg(ea.a, ea.b, eb.a, eb.b) };
}

/**
 * Where an entity sits now. The editor holds the solved sketch, so these
 * positions already account for every constraint applied so far.
 */
function pointAt(index: EntityIndex, id: Id): Vec2 | undefined {
  const e = index.get(id);
  return e?.kind === 'point' ? e : undefined;
}

function lineEnds(index: EntityIndex, id: Id): { a: Vec2; b: Vec2 } | undefined {
  const e = index.get(id);
  if (e?.kind !== 'line') return undefined;
  const [a, b] = [pointAt(index, e.p1), pointAt(index, e.p2)];
  return a === undefined || b === undefined ? undefined : { a, b };
}
