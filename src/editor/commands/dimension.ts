import type { ConstraintInput } from '../../core/builder';
import { constraintValue } from '../../core/edit';
import { evaluateSource } from '../../core/expr';
import { midpoint } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Constraint, Id, Value } from '../../core/model';
import { indexEntities } from '../../core/sketch';
import { layoutDimension, resolveOffset } from '../../render/dimensions';
import type { EditRequest, Message, OverlayShape, PointerInput } from '../command';
import { hitTest } from '../hit';
import { ConstraintCommand } from './constrain';
import type { Operand, OperandKind } from './constrain';
import { endsOf, isCurve, measure, OBJECT, SECOND_OBJECT, specOf } from './dimension-spec';
import type { DimensionConstraint } from './dimension-spec';
import { HIT_PX } from './select';

/** The dimension follows the cursor until the user puts it somewhere. */
interface Placing {
  readonly kind: 'placing';
  readonly constraint: DimensionConstraint;
  /** Where the cursor is: the dimension follows it, and Enter places it here. */
  cursor: Vec2 | undefined;
  /**
   * The line whose length is being placed, so a second line clicked while it
   * follows the cursor turns the dimension into the angle between the two.
   * Absent for every other dimension, which has no second line to take.
   */
  readonly fromLine?: Id;
}

/** The value box is open on a placed dimension. */
interface Entering {
  readonly kind: 'entering';
  readonly constraint: DimensionConstraint;
  /** Where the user put the dimension, so the placement they chose is stored. */
  readonly placement: Vec2;
  /** Where the value text sits, so the box opens on it. */
  readonly at: Vec2;
}

/** Where the command is: picking operands, placing the dimension, valuing it. */
type Phase = { readonly kind: 'pick' } | Placing | Entering;

/**
 * The dimension command, Inventor's way: pick the operands and the dimension
 * starts following the cursor, click to place it, then type its value —
 * pre-filled with the measurement, so accepting it moves nothing while a typed
 * value drives the geometry to it. What it constrains is decided by the
 * operands: a circle or arc gets a radius, a line its length, two points a
 * distance, a point and a line the distance between them, and two lines the
 * angle between them. A line's length is the whole dimension on its own, so
 * the two-line angle is reached the other way round: while that length is
 * being placed, clicking a second line turns the pending dimension into the
 * angle between the two, which then follows the cursor like any other. The
 * command stays active for the next one.
 */
export class DimensionCommand extends ConstraintCommand {
  readonly id = 'dimension';
  protected readonly operands = [OBJECT, SECOND_OBJECT];
  /** Latest cursor position, the end of the rubber band drawn while a pick is pending. */
  private cursor: Vec2 | undefined;
  /** What the command is doing once the operands are complete. */
  private phase: Phase = { kind: 'pick' };
  /** The line a single pick measured the length of, so a second line can convert it. */
  private lengthOf: Id | undefined;

  protected override compatible(a: OperandKind, b: OperandKind): boolean {
    return !isCurve(a) && !isCurve(b);
  }

  protected override build(picks: readonly Operand[]): ConstraintInput | undefined {
    const measured = measure(this.editor.sketch, picks);
    const [first, second] = picks;
    // Only the single-line case remembers its line; every other build starts
    // from a clean slate, so a stale one can never convert a later dimension.
    this.lengthOf = second === undefined && first?.kind === 'line' && measured !== undefined ? first.id : undefined;
    return measured;
  }

  /**
   * The line under `world`, within the click tolerance, as a pick would find
   * it. Points win the hit test, so a click on a line's end never counts as a
   * second line — and neither does a click on a curve.
   */
  private lineAt(world: Vec2): Id | undefined {
    const hit = hitTest(this.editor.sketch, world, { tolerance: this.editor.viewport.toWorldLength(HIT_PX) });
    const e = this.editor.sketch.entities.find((x) => x.id === hit);
    return e?.kind === 'line' ? e.id : undefined;
  }

  /**
   * Where an operand sits now, so a preview can start from it: the point
   * itself, or the middle of a line. A curve never waits for a second pick,
   * so it has no preview position.
   */
  private position(id: Id): Vec2 | undefined {
    const e = this.editor.sketch.entities.find((x) => x.id === id);
    if (e?.kind === 'point') return { x: e.x, y: e.y };
    const ends = endsOf(this.editor.sketch, id);
    return ends === undefined ? undefined : midpoint(ends.a, ends.b);
  }

  /**
   * The operands are complete, so the dimension starts following the cursor
   * instead of being applied: the user places it, then values it.
   */
  protected override complete(constraint: ConstraintInput): void {
    // `build()` only produces the three dimensional kinds; the test is what
    // narrows the constraint to them.
    if (constraint.kind === 'distance' || constraint.kind === 'radius' || constraint.kind === 'angle') {
      this.phase = { kind: 'placing', constraint, cursor: this.cursor, fromLine: this.lengthOf };
    }
    this.editor.viewChanged();
  }

  override pointerMove(input: PointerInput): void {
    this.cursor = input.world;
    const phase = this.phase;
    if (phase.kind === 'pick') {
      super.pointerMove(input);
      return;
    }
    // The dimension follows the cursor while it is being placed; the value box
    // owns the pointer once it is open.
    if (phase.kind === 'placing') {
      phase.cursor = input.world;
      this.editor.viewChanged();
    }
  }

  override pointerUp(input: PointerInput): void {
    const phase = this.phase;
    // A click puts the dimension where it follows the cursor; the value box owns
    // the pointer once it is open.
    if (phase.kind === 'placing') {
      if (!this.convert(phase, input.world)) this.place(input.world);
      return;
    }
    if (phase.kind === 'pick') super.pointerUp(input);
  }

  /** Enter places the dimension at the cursor, the keyboard path to a click. */
  keyDown(event: KeyboardEvent): boolean {
    const phase = this.phase;
    if (event.key !== 'Enter' || phase.kind !== 'placing') return false;
    if (phase.cursor !== undefined) this.place(phase.cursor);
    return true;
  }

  override prompt(): Message {
    const phase = this.phase;
    if (phase.kind === 'placing') {
      // A line's own length is still pending, so a second line would turn it
      // into the angle between the two — the hint says so.
      if (phase.fromLine !== undefined) return this.status ?? { key: 'prompts.dimensionPlaceLine' };
      return this.status ?? { key: 'prompts.dimensionPlace' };
    }
    if (phase.kind === 'entering') return this.status ?? { key: 'prompts.dimensionValue' };
    return super.prompt();
  }

  /** The value box on a placed dimension, pre-filled with the measurement. */
  get edit(): EditRequest | undefined {
    const phase = this.phase;
    if (phase.kind !== 'entering') return undefined;
    return { at: phase.at, value: this.measured(phase.constraint), label: { key: 'prompts.dimensionValue' } };
  }

  /**
   * Applies what the user typed. Accepting the measurement untouched (`edited`
   * false) applies the exact value the sketch already has, so nothing moves;
   * otherwise the text is a parameter name or an expression and the dimension
   * drives the geometry to it. An unusable value, or one the solver rejects,
   * keeps the box open so it can be fixed.
   */
  commitEdit(text: string, edited: boolean): boolean {
    const phase = this.phase;
    if (phase.kind !== 'entering') return false;
    const value = edited ? this.parse(text, phase.constraint.kind) : phase.constraint.value;
    if (value === undefined) return false;
    const offset = resolveOffset(
      { ...specOf(phase.constraint), placement: phase.placement },
      indexEntities(this.editor.sketch),
      this.editor.viewport.scale,
    );
    const next = this.admit({
      ...phase.constraint,
      value,
      ...(offset === undefined ? {} : { placement: offset }),
    });
    // A conflict or a redundancy: the message is recorded and the box stays open.
    if (next === undefined) return false;
    this.editor.commit(next);
    this.reset();
    return true;
  }

  /** Esc in the value box: drops the entry and goes back to placing. */
  cancelEdit(): void {
    this.cancel();
  }

  override cancel(): boolean {
    // Esc backs out one step at a time: the value box, the placement, the
    // pending pick, and only then the command itself.
    const phase = this.phase;
    if (phase.kind === 'entering') {
      // Back to placing, with the dimension where it was put. A rejection
      // recorded while the box was open is stale now, so it goes too.
      this.status = undefined;
      this.phase = { kind: 'placing', constraint: phase.constraint, cursor: phase.placement };
      this.editor.viewChanged();
      return true;
    }
    if (phase.kind === 'placing') {
      this.reset();
      return true;
    }
    return super.cancel();
  }

  override overlay(): readonly OverlayShape[] {
    const phase = this.phase;
    if (phase.kind === 'pick') {
      const shapes = super.overlay();
      const [first] = this.picks;
      const from = first === undefined ? undefined : this.position(first.id);
      if (from === undefined || this.cursor === undefined) return shapes;
      return [...shapes, { kind: 'previewLine', from, to: this.cursor }];
    }
    const spec = { ...specOf(phase.constraint), placement: phase.kind === 'placing' ? phase.cursor : phase.placement };
    const layout = layoutDimension(spec, indexEntities(this.editor.sketch), this.editor.viewport.scale);
    const highlight: OverlayShape = { kind: 'highlight', ids: spec.operands };
    // Degenerate operands have no layout to draw, but their highlight stands.
    if (layout === undefined) return [highlight];
    const dimension: OverlayShape = {
      kind: 'dimension',
      layout,
      radius: phase.constraint.kind === 'radius',
      // The measured value rides along while the dimension follows the cursor;
      // once it is placed, the value box shows it instead.
      ...(phase.kind === 'placing' ? { value: this.measured(phase.constraint) } : {}),
    };
    return [highlight, dimension];
  }

  override dispose(): void {
    this.reset();
    super.dispose();
  }

  /**
   * Inventor's route to the angle between two lines: a line's length is the
   * whole dimension on its own, so while it is being placed a click on a second
   * line turns the pending dimension into the angle between the two — the arc
   * then follows the cursor from there, ready to be placed like any other.
   * Returns false when the click was no such line, so it places the dimension.
   */
  private convert(phase: Placing, at: Vec2): boolean {
    const first = phase.fromLine;
    const second = this.lineAt(at);
    if (first === undefined || second === undefined || second === first) return false;
    const constraint = measure(this.editor.sketch, [
      { id: first, kind: 'line' },
      { id: second, kind: 'line' },
    ]);
    if (constraint === undefined) return false;
    this.phase = { kind: 'placing', constraint, cursor: at };
    this.editor.viewChanged();
    return true;
  }

  /** Puts the dimension at `at` and opens the value box on its value text. */
  private place(at: Vec2): void {
    const phase = this.phase;
    if (phase.kind !== 'placing') return;
    const layout = layoutDimension(
      { ...specOf(phase.constraint), placement: at },
      indexEntities(this.editor.sketch),
      this.editor.viewport.scale,
    );
    // Degenerate operands (coincident points, a zero-radius curve) leave nowhere
    // to draw the dimension, so the click is ignored.
    if (layout === undefined) return;
    this.phase = { kind: 'entering', constraint: phase.constraint, placement: at, at: layout.textAt };
    this.editor.viewChanged();
  }

  /**
   * The value the user typed: a parameter name binds the name itself, so the
   * dimension tracks it, and anything else is an expression evaluated against
   * the sketch's parameters. Undefined — with the message the status bar shows —
   * when the text is unusable.
   */
  private parse(text: string, kind: DimensionConstraint['kind']): Value | undefined {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    if (this.editor.sketch.params[trimmed] !== undefined) return trimmed;
    let value: number;
    try {
      value = evaluateSource(trimmed, (name) => this.editor.sketch.params[name]);
    } catch {
      this.status = { key: 'properties.invalid' };
      this.editor.viewChanged();
      return undefined;
    }
    // A negative distance or a non-positive radius is not a value the solver can
    // take (translate refuses it, which would throw out of the commit), so it is
    // refused here with the same message an unparseable one gets.
    const admissible = kind === 'radius' ? value > 0 : kind === 'distance' ? value >= 0 : true;
    if (!Number.isFinite(value) || !admissible) {
      this.status = { key: 'properties.invalid' };
      this.editor.viewChanged();
      return undefined;
    }
    return value;
  }

  /**
   * The measurement the constraint carries, as a number: `build()` always
   * measures one, and the id the draft assigns does not matter to
   * `constraintValue`, which reads only the kind and the value.
   */
  private measured(c: DimensionConstraint): number {
    return constraintValue(c as Constraint, this.editor.sketch.params)!;
  }

  /** Back to the start, ready for the next dimension; the command stays active. */
  private reset(): void {
    this.phase = { kind: 'pick' };
    this.picks = [];
    this.status = undefined;
    this.cursor = undefined;
    this.lengthOf = undefined;
    this.editor.viewChanged();
  }
}
