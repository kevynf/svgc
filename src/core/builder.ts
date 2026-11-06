import type { Constraint, Entity, Id } from './model';
import type { Sketch } from './sketch';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type ConstraintInput = WithoutId<Constraint>;

interface CurveOptions {
  readonly construction?: boolean;
}

/** Imperative helper for assembling sketches in code (demos, tests). */
export class SketchBuilder {
  private nextId = 1;
  private readonly entities: Entity[] = [];
  private readonly constraints: Constraint[] = [];
  private readonly params: Record<string, number> = {};

  point(x: number, y: number): Id {
    const id = this.id();
    this.entities.push({ kind: 'point', id, x, y });
    return id;
  }

  line(p1: Id, p2: Id, options: CurveOptions = {}): Id {
    const id = this.id();
    this.entities.push({ kind: 'line', id, p1, p2, ...options });
    return id;
  }

  circle(center: Id, radius: number, options: CurveOptions = {}): Id {
    const id = this.id();
    this.entities.push({ kind: 'circle', id, center, radius, ...options });
    return id;
  }

  arc(center: Id, start: Id, end: Id, options: CurveOptions = {}): Id {
    const id = this.id();
    this.entities.push({ kind: 'arc', id, center, start, end, ...options });
    return id;
  }

  constrain(constraint: ConstraintInput): Id {
    const id = this.id();
    this.constraints.push({ ...constraint, id } as Constraint);
    return id;
  }

  /** Locks a point at its current position. */
  fix(point: Id): Id {
    const entity = this.entities.find((e) => e.id === point);
    if (entity?.kind !== 'point') {
      throw new Error(`"${point}" is not a point`);
    }
    return this.constrain({ kind: 'fix', point, x: entity.x, y: entity.y });
  }

  param(name: string, value: number): this {
    this.params[name] = value;
    return this;
  }

  build(): Sketch {
    return {
      entities: [...this.entities],
      constraints: [...this.constraints],
      params: { ...this.params },
    };
  }

  private id(): Id {
    return `e${this.nextId++}`;
  }
}
