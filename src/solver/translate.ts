import type { SketchPrimitive } from '@salusoft89/planegcs';
import { arcParams, degToRad } from '../core/geometry';
import type { Vec2 } from '../core/geometry';
import type { Constraint, Entity, Id, Value } from '../core/model';
import { expectEntity, indexEntities, SketchError } from '../core/sketch';
import type { EntityIndex, Sketch } from '../core/sketch';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<SketchPrimitive, 'id'>;

/** Pins a point to a target position while respecting all other constraints. */
export interface DragTarget {
  readonly point: Id;
  readonly x: number;
  readonly y: number;
}

export interface Translation {
  readonly primitives: SketchPrimitive[];
  /** Sketch entity id → planegcs primitive id. */
  readonly gcsIdOf: ReadonlyMap<Id, string>;
  /** planegcs primitive id → originating sketch constraint id. Internal constraints are absent. */
  readonly constraintOf: ReadonlyMap<string, Id>;
}

/**
 * Lowers a sketch to planegcs primitives. planegcs requires referenced
 * primitives to be pushed first, so points go before curves, curves before
 * constraints. Named parameters are resolved to numbers here; they are fixed
 * during solving, so this is equivalent to passing them by reference.
 */
export function translate(sketch: Sketch, drag?: DragTarget): Translation {
  const index = indexEntities(sketch);
  const primitives: SketchPrimitive[] = [];
  const gcsIdOf = new Map<Id, string>();
  const constraintOf = new Map<string, Id>();
  let counter = 0;

  const push = (draft: Draft, owner?: Id): string => {
    const id = String(++counter);
    primitives.push({ ...draft, id } as SketchPrimitive);
    if (owner !== undefined) {
      constraintOf.set(id, owner);
    }
    return id;
  };
  const ref = (id: Id): string => {
    const gcsId = gcsIdOf.get(id);
    if (gcsId === undefined) {
      throw new SketchError(`Unknown entity "${id}"`);
    }
    return gcsId;
  };
  const value = (v: Value): number => {
    if (typeof v === 'number') {
      return v;
    }
    const resolved = sketch.params[v];
    if (resolved === undefined) {
      throw new SketchError(`Unknown parameter "${v}"`);
    }
    return resolved;
  };

  for (const entity of sketch.entities) {
    if (entity.kind === 'point') {
      gcsIdOf.set(entity.id, push({ type: 'point', x: entity.x, y: entity.y, fixed: false }));
    }
  }
  for (const entity of sketch.entities) {
    lowerCurve(entity, index, ref, push, gcsIdOf);
  }
  for (const constraint of sketch.constraints) {
    for (const draft of lowerConstraint(constraint, index, ref, value)) {
      push(draft, constraint.id);
    }
  }
  if (drag !== undefined) {
    expectEntity(index, drag.point, 'point');
    const p_id = ref(drag.point);
    push({ type: 'coordinate_x', p_id, x: drag.x, temporary: true });
    push({ type: 'coordinate_y', p_id, y: drag.y, temporary: true });
  }

  return { primitives, gcsIdOf, constraintOf };
}

function lowerCurve(
  entity: Entity,
  index: EntityIndex,
  ref: (id: Id) => string,
  push: (draft: Draft) => string,
  gcsIdOf: Map<Id, string>,
): void {
  switch (entity.kind) {
    case 'point':
      return;
    case 'line':
      expectEntity(index, entity.p1, 'point');
      expectEntity(index, entity.p2, 'point');
      gcsIdOf.set(entity.id, push({ type: 'line', p1_id: ref(entity.p1), p2_id: ref(entity.p2) }));
      return;
    case 'circle':
      expectEntity(index, entity.center, 'point');
      gcsIdOf.set(entity.id, push({ type: 'circle', c_id: ref(entity.center), radius: entity.radius }));
      return;
    case 'arc': {
      const center = expectEntity(index, entity.center, 'point');
      const start = expectEntity(index, entity.start, 'point');
      const end = expectEntity(index, entity.end, 'point');
      const { radius, startAngle, endAngle } = arcParams(center, start, end);
      const a_id = push({
        type: 'arc',
        c_id: ref(entity.center),
        start_id: ref(entity.start),
        end_id: ref(entity.end),
        radius,
        start_angle: startAngle,
        end_angle: endAngle,
      });
      gcsIdOf.set(entity.id, a_id);
      // Keeps start/end on the arc's circle at its start/end angles.
      push({ type: 'arc_rules', a_id });
      return;
    }
  }
}

function endpoints(entity: Entity): Id[] {
  switch (entity.kind) {
    case 'line':
      return [entity.p1, entity.p2];
    case 'arc':
      return [entity.start, entity.end];
    default:
      return [];
  }
}

/** Outward-agnostic normal of a curve at a point, matching planegcs' CalculateNormal. */
function normalAt(entity: Entity, at: Vec2, index: EntityIndex): Vec2 {
  switch (entity.kind) {
    case 'line': {
      const p1 = expectEntity(index, entity.p1, 'point');
      const p2 = expectEntity(index, entity.p2, 'point');
      return { x: -(p2.y - p1.y), y: p2.x - p1.x };
    }
    case 'circle':
    case 'arc': {
      const center = expectEntity(index, entity.center, 'point');
      return { x: center.x - at.x, y: center.y - at.y };
    }
    case 'point':
      throw new SketchError(`Point "${entity.id}" has no normal`);
  }
}

/**
 * When two curves share an endpoint, "distance from center to line = radius"
 * is degenerate at the solution (the point-on-curve and tangency conditions
 * become dependent). Like FreeCAD, constrain the angle between the curve
 * normals at the joint instead, snapped to 0 or π from the current geometry.
 */
function endpointTangency(index: EntityIndex, a: Id, b: Id): { point: Id; angle: number } | undefined {
  const ea = index.get(a);
  const eb = index.get(b);
  if (ea === undefined || eb === undefined || (ea.kind === 'line' && eb.kind === 'line')) return undefined;
  const shared = endpoints(ea).find((id) => endpoints(eb).includes(id));
  if (shared === undefined) return undefined;
  const at = expectEntity(index, shared, 'point');
  const na = normalAt(ea, at, index);
  const nb = normalAt(eb, at, index);
  const current = Math.atan2(na.x * nb.y - na.y * nb.x, na.x * nb.x + na.y * nb.y);
  return { point: shared, angle: Math.abs(current) < Math.PI / 2 ? 0 : Math.PI };
}

function lowerConstraint(
  c: Constraint,
  index: EntityIndex,
  ref: (id: Id) => string,
  value: (v: Value) => number,
): Draft[] {
  const kindOf = (id: Id) => {
    const entity = index.get(id);
    if (entity === undefined) {
      throw new SketchError(`Constraint "${c.id}" references unknown entity "${id}"`);
    }
    return entity.kind;
  };
  const invalid = (): never => {
    throw new SketchError(`Constraint "${c.id}" (${c.kind}) has invalid operands`);
  };
  const points = (...ids: Id[]) => ids.forEach((id) => expectEntity(index, id, 'point'));
  const lines = (...ids: Id[]) => ids.forEach((id) => expectEntity(index, id, 'line'));

  switch (c.kind) {
    case 'coincident':
      points(c.a, c.b);
      if (c.a === c.b) invalid();
      return [{ type: 'p2p_coincident', p1_id: ref(c.a), p2_id: ref(c.b) }];

    case 'fix':
      points(c.point);
      return [
        { type: 'coordinate_x', p_id: ref(c.point), x: c.x },
        { type: 'coordinate_y', p_id: ref(c.point), y: c.y },
      ];

    case 'horizontal':
    case 'vertical': {
      if (c.b === undefined) {
        lines(c.a);
        return [{ type: c.kind === 'horizontal' ? 'horizontal_l' : 'vertical_l', l_id: ref(c.a) }];
      }
      points(c.a, c.b);
      const type = c.kind === 'horizontal' ? 'horizontal_pp' : 'vertical_pp';
      return [{ type, p1_id: ref(c.a), p2_id: ref(c.b) }];
    }

    case 'parallel':
      lines(c.a, c.b);
      return [{ type: 'parallel', l1_id: ref(c.a), l2_id: ref(c.b) }];

    case 'perpendicular':
      lines(c.a, c.b);
      return [{ type: 'perpendicular_ll', l1_id: ref(c.a), l2_id: ref(c.b) }];

    case 'equal': {
      const pair = `${kindOf(c.a)}-${kindOf(c.b)}`;
      const [a, b] = [ref(c.a), ref(c.b)];
      switch (pair) {
        case 'line-line':
          return [{ type: 'equal_length', l1_id: a, l2_id: b }];
        case 'circle-circle':
          return [{ type: 'equal_radius_cc', c1_id: a, c2_id: b }];
        case 'circle-arc':
          return [{ type: 'equal_radius_ca', c1_id: a, a2_id: b }];
        case 'arc-circle':
          return [{ type: 'equal_radius_ca', c1_id: b, a2_id: a }];
        case 'arc-arc':
          return [{ type: 'equal_radius_aa', a1_id: a, a2_id: b }];
        default:
          return invalid();
      }
    }

    case 'tangent': {
      const pair = `${kindOf(c.a)}-${kindOf(c.b)}`;
      const [a, b] = [ref(c.a), ref(c.b)];
      const joint = endpointTangency(index, c.a, c.b);
      if (joint !== undefined) {
        return [{ type: 'angle_via_point', crv1_id: a, crv2_id: b, p_id: ref(joint.point), angle: joint.angle }];
      }
      switch (pair) {
        case 'line-circle':
          return [{ type: 'tangent_lc', l_id: a, c_id: b }];
        case 'circle-line':
          return [{ type: 'tangent_lc', l_id: b, c_id: a }];
        case 'line-arc':
          return [{ type: 'tangent_la', l_id: a, a_id: b }];
        case 'arc-line':
          return [{ type: 'tangent_la', l_id: b, a_id: a }];
        case 'circle-circle':
          return [{ type: 'tangent_cc', c1_id: a, c2_id: b }];
        case 'circle-arc':
          return [{ type: 'tangent_ca', c_id: a, a_id: b }];
        case 'arc-circle':
          return [{ type: 'tangent_ca', c_id: b, a_id: a }];
        case 'arc-arc':
          return [{ type: 'tangent_aa', a1_id: a, a2_id: b }];
        default:
          return invalid();
      }
    }

    case 'pointOnLine':
      points(c.point);
      lines(c.line);
      return [{ type: 'point_on_line_pl', p_id: ref(c.point), l_id: ref(c.line) }];

    case 'pointOnCurve': {
      points(c.point);
      const curve = expectEntity(index, c.curve, 'circle', 'arc');
      return curve.kind === 'circle'
        ? [{ type: 'point_on_circle', p_id: ref(c.point), c_id: ref(c.curve) }]
        : [{ type: 'point_on_arc', p_id: ref(c.point), a_id: ref(c.curve) }];
    }

    case 'midpoint': {
      points(c.point);
      const line = expectEntity(index, c.line, 'line');
      // The line's endpoints are symmetric about the point.
      return [{ type: 'p2p_symmetric_ppp', p1_id: ref(line.p1), p2_id: ref(line.p2), p_id: ref(c.point) }];
    }

    // `a` and `b` keep their orientation: p1 is mirrored to p2, not the other
    // way round, so a mirrored copy stays attached to its original.
    case 'symmetric':
      points(c.a, c.b);
      lines(c.line);
      return [{ type: 'p2p_symmetric_ppl', p1_id: ref(c.a), p2_id: ref(c.b), l_id: ref(c.line) }];

    case 'distance': {
      const distance = value(c.value);
      if (!(distance >= 0)) invalid();
      const pair = `${kindOf(c.a)}-${kindOf(c.b)}`;
      const [a, b] = [ref(c.a), ref(c.b)];
      switch (pair) {
        case 'point-point':
          return [{ type: 'p2p_distance', p1_id: a, p2_id: b, distance }];
        case 'point-line':
          return [{ type: 'p2l_distance', p_id: a, l_id: b, distance }];
        case 'line-point':
          return [{ type: 'p2l_distance', p_id: b, l_id: a, distance }];
        default:
          return invalid();
      }
    }

    case 'radius': {
      const radius = value(c.value);
      if (!(radius > 0)) invalid();
      const curve = expectEntity(index, c.curve, 'circle', 'arc');
      return curve.kind === 'circle'
        ? [{ type: 'circle_radius', c_id: ref(c.curve), radius }]
        : [{ type: 'arc_radius', a_id: ref(c.curve), radius }];
    }

    case 'angle':
      lines(c.a, c.b);
      // planegcs measures angles in math orientation; with Y pointing down,
      // counterclockwise on screen is a negative angle.
      return [{ type: 'l2l_angle_ll', l1_id: ref(c.a), l2_id: ref(c.b), angle: -degToRad(value(c.value)) }];
  }
}
