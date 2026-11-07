import type { Constraint, Entity, Id, Value } from './model';
import type { Sketch } from './sketch';

/** Point ids a curve is built from. */
export function definingPoints(entity: Entity): Id[] {
  switch (entity.kind) {
    case 'point':
      return [];
    case 'line':
      return [entity.p1, entity.p2];
    case 'circle':
      return [entity.center];
    case 'arc':
      return [entity.center, entity.start, entity.end];
  }
}

/** Entity ids a constraint refers to. */
export function constraintRefs(c: Constraint): Id[] {
  switch (c.kind) {
    case 'fix':
      return [c.point];
    case 'horizontal':
    case 'vertical':
      return c.b === undefined ? [c.a] : [c.a, c.b];
    case 'pointOnLine':
    case 'midpoint':
      return [c.point, c.line];
    case 'pointOnCurve':
      return [c.point, c.curve];
    case 'radius':
      return [c.curve];
    default:
      return [c.a, c.b];
  }
}

/**
 * Deletes entities and constraints by id, with the cascade a CAD user expects:
 * deleting a point deletes the curves built on it; deleting a curve also
 * deletes its points unless another curve still uses them; constraints
 * referring to anything deleted go too.
 */
export function deleteItems(sketch: Sketch, ids: Iterable<Id>): Sketch {
  const requested = new Set(ids);
  const removed = new Set<Id>();

  const curves = sketch.entities.filter((e) => e.kind !== 'point');
  for (const e of sketch.entities) {
    if (requested.has(e.id)) removed.add(e.id);
  }
  for (const curve of curves) {
    if (definingPoints(curve).some((p) => removed.has(p))) removed.add(curve.id);
  }
  const stillUsed = new Set(curves.filter((c) => !removed.has(c.id)).flatMap(definingPoints));
  for (const curve of curves) {
    if (!removed.has(curve.id)) continue;
    for (const p of definingPoints(curve)) {
      if (!stillUsed.has(p)) removed.add(p);
    }
  }

  const entities = sketch.entities.filter((e) => !removed.has(e.id));
  const constraints = sketch.constraints.filter(
    (c) => !requested.has(c.id) && !constraintRefs(c).some((id) => removed.has(id)),
  );
  if (entities.length === sketch.entities.length && constraints.length === sketch.constraints.length) {
    return sketch;
  }
  return { ...sketch, entities, constraints };
}

/**
 * Toggles construction on the given curves. If any is normal geometry, all
 * become construction; otherwise all become normal (Inventor's behavior for a
 * mixed selection).
 */
export function toggleConstruction(sketch: Sketch, ids: Iterable<Id>): Sketch {
  const targets = new Set(ids);
  const curves = sketch.entities.filter((e) => targets.has(e.id) && e.kind !== 'point');
  if (curves.length === 0) return sketch;
  const construction = curves.some((e) => e.kind !== 'point' && e.construction !== true);
  const entities = sketch.entities.map((e): Entity => {
    if (e.kind === 'point' || !targets.has(e.id)) return e;
    if (construction) return { ...e, construction: true };
    const { construction: _, ...rest } = e;
    return rest as Entity;
  });
  return { ...sketch, entities };
}

/** The dimension constraints: the only ones carrying a `value`. */
type DimensionConstraint = Extract<Constraint, { value: Value }>;

function isDimension(c: Constraint): c is DimensionConstraint {
  return c.kind === 'distance' || c.kind === 'radius' || c.kind === 'angle';
}

/**
 * Numeric value of a dimension constraint (distance, radius or angle), with
 * named parameters resolved against `params`. Undefined for any other kind
 * and for a name the sketch does not define.
 */
export function constraintValue(c: Constraint, params: Readonly<Record<string, number>>): number | undefined {
  if (!isDimension(c)) return undefined;
  return typeof c.value === 'number' ? c.value : params[c.value];
}

/**
 * Sets the value of a dimension constraint (distance, radius, angle). Other
 * kinds have no value and are returned untouched, as are unknown ids and
 * values that are already set.
 */
export function setConstraintValue(sketch: Sketch, id: Id, value: Value): Sketch {
  const current = sketch.constraints.find((c) => c.id === id);
  if (current === undefined || !isDimension(current) || current.value === value) return sketch;
  const constraints = sketch.constraints.map((c): Constraint =>
    isDimension(c) && c.id === id ? { ...c, value } : c,
  );
  return { ...sketch, constraints };
}
