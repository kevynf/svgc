import type { ConstraintInput } from '../../core/builder';
import { Draft } from '../../core/draft';
import { constraintValue } from '../../core/edit';
import type { Vec2 } from '../../core/geometry';
import type { Constraint } from '../../core/model';
import { indexEntities } from '../../core/sketch';
import { layoutDimension, resolveOffset } from '../../render/dimensions';
import type { Message, OverlayShape, PointerInput } from '../command';
import { ConstraintCommand } from './constrain';
import type { Operand, OperandKind } from './constrain';
import { isCurve, measure, OBJECT, SECOND_OBJECT, specOf } from './dimension-spec';
import type { DimensionConstraint } from './dimension-spec';

/**
 * Inventor's DRIVEN DIMENSION: a dimension that measures and is drawn but
 * constrains nothing. It takes the same operands as the driving dimension and
 * draws the same graphics, and the difference is only in what the placement
 * click commits — there is no value to type, because the measurement IS the
 * value, so the click that puts the dimension down commits it straight away,
 * flagged `driven` so the solver never enforces it. The geometry stays exactly
 * as free as it was; the dimension is something the user reads, not something
 * they fight.
 */

/** The dimension follows the cursor until the user puts it somewhere. */
interface Placing {
  readonly kind: 'placing';
  readonly constraint: DimensionConstraint;
  /** Where the cursor is: the dimension follows it, and Enter places it here. */
  cursor: Vec2 | undefined;
}

/** Where the command is: picking operands, then placing the dimension. */
type Phase = { readonly kind: 'pick' } | Placing;

/**
 * The driven dimension: pick the operands and the dimension starts following
 * the cursor, click to place it — and that click commits it, carrying the
 * measurement it took and nothing else. What it measures is decided by the
 * operands, exactly as it is for the driving dimension: a circle or arc gets a
 * radius, a line its length, two points a distance, a point and a line the
 * distance between them, and two lines the angle between them. The command
 * stays active for the next one.
 */
export class DrivenDimensionCommand extends ConstraintCommand {
  readonly id = 'driven';
  protected readonly operands = [OBJECT, SECOND_OBJECT];
  /** Latest cursor position, the end of the rubber band drawn while a pick is pending. */
  private cursor: Vec2 | undefined;
  /** What the command is doing once the operands are complete. */
  private phase: Phase = { kind: 'pick' };

  protected override compatible(a: OperandKind, b: OperandKind): boolean {
    return !isCurve(a) && !isCurve(b);
  }

  protected override build(picks: readonly Operand[]): ConstraintInput | undefined {
    const measured = measure(this.editor.sketch, picks);
    // The same measurement the driving dimension takes, flagged so the solver
    // lowers it to nothing: measured and drawn, never enforced.
    return measured === undefined ? undefined : { ...measured, driven: true };
  }

  /**
   * The operands are complete, so the dimension starts following the cursor
   * instead of being applied: the user places it, and that click commits it.
   */
  protected override complete(constraint: ConstraintInput): void {
    // `build()` only produces the three dimensional kinds; the test is what
    // narrows the constraint to them.
    if (constraint.kind === 'distance' || constraint.kind === 'radius' || constraint.kind === 'angle') {
      this.phase = { kind: 'placing', constraint, cursor: this.cursor };
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
    // The dimension follows the cursor until the click that places it.
    phase.cursor = input.world;
    this.editor.viewChanged();
  }

  override pointerUp(input: PointerInput): void {
    // A click puts the dimension where it follows the cursor — and, a driven
    // dimension having no value to type, commits it there.
    if (this.phase.kind === 'placing') this.place(input.world);
    else super.pointerUp(input);
  }

  /** Enter places the dimension at the cursor, the keyboard path to a click. */
  keyDown(event: KeyboardEvent): boolean {
    const phase = this.phase;
    if (event.key !== 'Enter' || phase.kind !== 'placing') return false;
    if (phase.cursor !== undefined) this.place(phase.cursor);
    return true;
  }

  override prompt(): Message {
    // Placing is the last step there is: a driven dimension opens no value box.
    return this.status ?? (this.phase.kind === 'placing' ? { key: 'prompts.dimensionPlace' } : super.prompt());
  }

  override overlay(): readonly OverlayShape[] {
    const phase = this.phase;
    if (phase.kind === 'pick') return super.overlay();
    const spec = { ...specOf(phase.constraint), placement: phase.cursor };
    const layout = layoutDimension(spec, indexEntities(this.editor.sketch), this.editor.viewport.scale);
    const highlight: OverlayShape = { kind: 'highlight', ids: spec.operands };
    // Degenerate operands have no layout to draw, but their highlight stands.
    if (layout === undefined) return [highlight];
    return [
      highlight,
      {
        kind: 'dimension',
        layout,
        radius: phase.constraint.kind === 'radius',
        // The measured value rides along while the dimension follows the cursor,
        // and stays on it afterwards: there is no value box to show it instead.
        value: constraintValue(phase.constraint as Constraint, this.editor.sketch.params),
      },
    ];
  }

  override cancel(): boolean {
    // Esc backs out one step at a time: the placement, the pending pick, and
    // only then the command itself.
    if (this.phase.kind === 'placing') {
      this.reset();
      return true;
    }
    return super.cancel();
  }

  override dispose(): void {
    this.reset();
    super.dispose();
  }

  /**
   * Puts the dimension at `at` and commits it. There is no value to type, so the
   * placement click is the whole command: the constraint lands carrying the
   * measurement it took and the placement the cursor chose.
   */
  private place(at: Vec2): void {
    const phase = this.phase;
    if (phase.kind !== 'placing') return;
    const offset = resolveOffset(
      { ...specOf(phase.constraint), placement: at },
      indexEntities(this.editor.sketch),
      this.editor.viewport.scale,
    );
    // Degenerate operands (coincident points, a zero-radius curve) leave nowhere
    // to draw the dimension, so the click is ignored.
    if (offset === undefined) return;
    const draft = new Draft(this.editor.sketch);
    draft.constrain({ ...phase.constraint, placement: offset });
    this.editor.commit(draft.sketch);
    this.reset();
  }

  /** Back to the start, ready for the next dimension; the command stays active. */
  private reset(): void {
    this.phase = { kind: 'pick' };
    this.picks = [];
    this.status = undefined;
    this.cursor = undefined;
    this.editor.viewChanged();
  }
}
