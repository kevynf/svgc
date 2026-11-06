import type { ConstraintInput } from './builder';
import type { Vec2 } from './geometry';
import type { Constraint, Entity, Id } from './model';
import type { Sketch } from './sketch';

/** The next free numeric suffix for `e<n>` ids in a sketch. */
export function nextIdNumber(sketch: Sketch): number {
  let max = 0;
  for (const item of [...sketch.entities, ...sketch.constraints]) {
    const match = /^e(\d+)$/.exec(item.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** Accumulates additions to an existing sketch; editor commands build one per committed step. */
export class Draft {
  private readonly entities: Entity[];
  private readonly constraints: Constraint[];
  private next: number;

  constructor(private readonly base: Sketch) {
    this.entities = [...base.entities];
    this.constraints = [...base.constraints];
    this.next = nextIdNumber(base);
  }

  point(p: Vec2): Id {
    const id = this.id();
    this.entities.push({ kind: 'point', id, x: p.x, y: p.y });
    return id;
  }

  line(p1: Id, p2: Id): Id {
    const id = this.id();
    this.entities.push({ kind: 'line', id, p1, p2 });
    return id;
  }

  circle(center: Id, radius: number): Id {
    const id = this.id();
    this.entities.push({ kind: 'circle', id, center, radius });
    return id;
  }

  constrain(constraint: ConstraintInput): Id {
    const id = this.id();
    this.constraints.push({ ...constraint, id } as Constraint);
    return id;
  }

  get sketch(): Sketch {
    return { ...this.base, entities: [...this.entities], constraints: [...this.constraints] };
  }

  private id(): Id {
    return `e${this.next++}`;
  }
}
