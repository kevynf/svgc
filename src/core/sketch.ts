import type { Entity, EntityKind, Id } from './model';
import type { Constraint } from './model';

export interface Sketch {
  readonly entities: readonly Entity[];
  readonly constraints: readonly Constraint[];
  readonly params: Readonly<Record<string, number>>;
}

export class SketchError extends Error {
  override readonly name = 'SketchError';
}

export function emptySketch(): Sketch {
  return { entities: [], constraints: [], params: {} };
}

export type EntityIndex = ReadonlyMap<Id, Entity>;

export function indexEntities(sketch: Sketch): EntityIndex {
  const index = new Map<Id, Entity>();
  for (const entity of sketch.entities) {
    if (index.has(entity.id)) {
      throw new SketchError(`Duplicate entity id "${entity.id}"`);
    }
    index.set(entity.id, entity);
  }
  return index;
}

export function expectEntity<K extends EntityKind>(
  index: EntityIndex,
  id: Id,
  ...kinds: K[]
): Extract<Entity, { kind: K }> {
  const entity = index.get(id);
  if (entity === undefined) {
    throw new SketchError(`Unknown entity "${id}"`);
  }
  if (!(kinds as EntityKind[]).includes(entity.kind)) {
    throw new SketchError(`Entity "${id}" is a ${entity.kind}, expected ${kinds.join(' or ')}`);
  }
  return entity as Extract<Entity, { kind: K }>;
}
