import type { ConstraintInput } from '../../core/builder';
import { arcParams, distance, lineAngleDeg, midpoint, perpendicularDistance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Id } from '../../core/model';
import type { OverlayShape, PointerInput } from '../command';
import { ConstraintCommand } from './constrain';
import type { Operand, OperandKind, OperandSpec } from './constrain';

/** Every kind is pickable: the constraint follows from what the user picked. */
const ANY: readonly OperandKind[] = ['point', 'line', 'circle', 'arc'];
const OBJECT: OperandSpec = { kinds: ANY, prompt: 'prompts.dimension' };
const SECOND_OBJECT: OperandSpec = { kinds: ANY, prompt: 'prompts.dimensionSecond' };

/** A curve is dimensioned by a single pick, so it can never take a second one. */
function isCurve(kind: OperandKind): boolean {
  return kind === 'circle' || kind === 'arc';
}

/**
 * The dimension command: what it constrains is decided by the operands. A
 * circle or arc gets a radius, two points a distance, a point and a line the
 * distance between them, and two lines the angle between them. Every value is
 * the measurement the sketch already has, so adding a dimension never moves
 * geometry — the command stays active for the next one.
 */
export class DimensionCommand extends ConstraintCommand {
  readonly id = 'dimension';
  protected readonly operands = [OBJECT, SECOND_OBJECT];
  /** Latest cursor position, the end of the rubber band drawn while a pick is pending. */
  private cursor: Vec2 | undefined;

  protected override compatible(a: OperandKind, b: OperandKind): boolean {
    return !isCurve(a) && !isCurve(b);
  }

  protected override build(picks: readonly Operand[]): ConstraintInput | undefined {
    const [first, second] = picks;
    if (first === undefined) return undefined;
    // A curve carries its own dimension, so it completes on the first pick.
    if (isCurve(first.kind)) return this.radius(first.id);
    if (second === undefined) return undefined;
    switch (second.kind) {
      case 'point':
        return first.kind === 'point' ? this.spread(first.id, second.id) : this.offset(second.id, first.id);
      case 'line':
        return first.kind === 'line' ? this.angle(first.id, second.id) : this.offset(first.id, second.id);
      default:
        return undefined;
    }
  }

  /** Radius of a circle, or of an arc measured through its three points. */
  private radius(curve: Id): ConstraintInput | undefined {
    const e = this.editor.sketch.entities.find((x) => x.id === curve);
    if (e?.kind === 'circle') return { kind: 'radius', curve, value: e.radius };
    if (e?.kind !== 'arc') return undefined;
    const [center, start, end] = [this.point(e.center), this.point(e.start), this.point(e.end)];
    if (center === undefined || start === undefined || end === undefined) return undefined;
    return { kind: 'radius', curve, value: arcParams(center, start, end).radius };
  }

  /** Distance between two points. */
  private spread(a: Id, b: Id): ConstraintInput | undefined {
    const [pa, pb] = [this.point(a), this.point(b)];
    if (pa === undefined || pb === undefined) return undefined;
    return { kind: 'distance', a, b, value: distance(pa, pb) };
  }

  /** Distance from a point to a line, the point first as the solver expects. */
  private offset(point: Id, line: Id): ConstraintInput | undefined {
    const p = this.point(point);
    const ends = this.ends(line);
    if (p === undefined || ends === undefined) return undefined;
    return { kind: 'distance', a: point, b: line, value: perpendicularDistance(p, ends.a, ends.b) };
  }

  /** Degrees counterclockwise on screen, from line `a` to line `b`. */
  private angle(a: Id, b: Id): ConstraintInput | undefined {
    const [ea, eb] = [this.ends(a), this.ends(b)];
    if (ea === undefined || eb === undefined) return undefined;
    return { kind: 'angle', a, b, value: lineAngleDeg(ea.a, ea.b, eb.a, eb.b) };
  }

  /**
   * Where an entity sits now. The editor holds the solved sketch, so these
   * positions already account for every constraint applied so far.
   */
  private point(id: Id): Vec2 | undefined {
    const e = this.editor.sketch.entities.find((x) => x.id === id);
    return e?.kind === 'point' ? e : undefined;
  }

  private ends(id: Id): { a: Vec2; b: Vec2 } | undefined {
    const e = this.editor.sketch.entities.find((x) => x.id === id);
    if (e?.kind !== 'line') return undefined;
    const [a, b] = [this.point(e.p1), this.point(e.p2)];
    return a === undefined || b === undefined ? undefined : { a, b };
  }

  /**
   * Where an operand sits now, so a preview can start from it: the point
   * itself, or the middle of a line. A curve never waits for a second pick,
   * so it has no preview position.
   */
  private position(id: Id): Vec2 | undefined {
    const e = this.editor.sketch.entities.find((x) => x.id === id);
    if (e?.kind === 'point') return { x: e.x, y: e.y };
    const ends = this.ends(id);
    return ends === undefined ? undefined : midpoint(ends.a, ends.b);
  }

  override pointerMove(input: PointerInput): void {
    super.pointerMove(input);
    this.cursor = input.world;
  }

  override overlay(): readonly OverlayShape[] {
    const shapes = super.overlay();
    const [first] = this.picks;
    const from = first === undefined ? undefined : this.position(first.id);
    if (from === undefined || this.cursor === undefined) return shapes;
    return [...shapes, { kind: 'previewLine', from, to: this.cursor }];
  }
}
