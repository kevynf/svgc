import type { ConstraintInput } from '../../core/builder';
import { Draft } from '../../core/draft';
import type { Vec2 } from '../../core/geometry';
import type { Entity, Id } from '../../core/model';
import type { Sketch } from '../../core/sketch';
import type { Key } from '../../i18n/i18n';
import type { Command, Message, OverlayShape, PointerInput } from '../command';
import type { CommandFactory, Editor } from '../editor';
import { distanceTo, hitTest, pointLookup } from '../hit';
import { HIT_PX } from './select';

/** The entity kinds a constraint operand may be. */
export type OperandKind = Entity['kind'];

/** What one operand of a constraint command accepts. */
export interface OperandSpec {
  readonly kinds: readonly OperandKind[];
  /** Prompt shown while this pick is pending. */
  readonly prompt: Key;
}

/** An operand the user has picked. */
export interface Operand {
  readonly id: Id;
  readonly kind: OperandKind;
}

const POINT: OperandSpec = { kinds: ['point'], prompt: 'prompts.pickPoint' };
const FIX_POINT: OperandSpec = { kinds: ['point'], prompt: 'prompts.pickFixPoint' };
const LINE: OperandSpec = { kinds: ['line'], prompt: 'prompts.pickLine' };
const CURVE: OperandSpec = { kinds: ['circle', 'arc'], prompt: 'prompts.pickCurve' };
const LINE_OR_POINT: OperandSpec = { kinds: ['line', 'point'], prompt: 'prompts.pickLineOrPoint' };
const LINE_OR_CURVE: OperandSpec = {
  kinds: ['line', 'circle', 'arc'],
  prompt: 'prompts.pickLineOrCurve',
};
const SECOND_POINT: OperandSpec = { kinds: ['point'], prompt: 'prompts.pickSecondPoint' };
const SECOND_LINE: OperandSpec = { kinds: ['line'], prompt: 'prompts.pickSecondLine' };
const SECOND_OBJECT: OperandSpec = {
  kinds: ['line', 'circle', 'arc'],
  prompt: 'prompts.pickSecondObject',
};
/** Horizontal/vertical: a line alone completes the constraint, two points make the pair. */
const AXIS: readonly OperandSpec[] = [LINE_OR_POINT, SECOND_POINT];

/**
 * Inventor's constraint commands: pick the command, then the operands. A command stays active once
 * it has applied a constraint, so a run of them can be added without going back to the ribbon; Esc
 * drops the pending operand and only then ends the command.
 */
export abstract class ConstraintCommand implements Command {
  abstract readonly id: string;
  /** The operands, in pick order. */
  protected abstract readonly operands: readonly OperandSpec[];
  /** The operands picked so far; subclasses read them to draw their previews. */
  protected picks: readonly Operand[] = [];
  /** Overrides the operand prompt until the next click, e.g. after a rejection. */
  protected status: Message | undefined;

  constructor(protected readonly editor: Editor) {}

  prompt(): Message {
    if (this.status !== undefined) return this.status;
    const step = this.operands[Math.min(this.picks.length, this.operands.length - 1)]!;
    return { key: step.prompt };
  }

  pointerMove(input: PointerInput): void {
    const step = this.operands[this.picks.length];
    this.editor.setHover(
      step === undefined ? undefined : this.operandAt(input.world, step.kinds)?.id,
    );
  }

  pointerUp(input: PointerInput): void {
    this.status = undefined;
    const step = this.operands[this.picks.length];
    if (step === undefined) return;
    const operand = this.operandAt(input.world, step.kinds);
    if (operand === undefined) return;
    const previous = this.picks[this.picks.length - 1];
    if (
      previous !== undefined &&
      (previous.id === operand.id || !this.compatible(previous.kind, operand.kind))
    ) {
      this.reject({ key: 'prompts.incompatible' });
      return;
    }
    const picks = [...this.picks, operand];
    const constraint = this.build(picks);
    if (constraint === undefined) {
      this.picks = picks;
      this.editor.viewChanged();
      return;
    }
    this.complete(constraint);
  }

  cancel(): boolean {
    if (this.picks.length === 0) return false;
    this.picks = [];
    this.editor.viewChanged();
    return true;
  }

  overlay(): readonly OverlayShape[] {
    return this.picks.length === 0 ? [] : [{ kind: 'highlight', ids: this.picks.map((p) => p.id) }];
  }

  dispose(): void {
    this.picks = [];
    this.editor.setHover(undefined);
  }

  /** Builds the constraint once the operands allow it; undefined while a pick is still missing. */
  protected abstract build(picks: readonly Operand[]): ConstraintInput | undefined;

  /**
   * Called once the operands allow the constraint. The default applies it; a command that places
   * and values the constraint first (the dimension command) overrides this.
   */
  protected complete(constraint: ConstraintInput): void {
    this.apply(constraint);
  }

  /** Whether the second operand may follow the first. */
  protected compatible(_a: OperandKind, _b: OperandKind): boolean {
    return true;
  }

  /**
   * Adds the constraint unless the solver rejects it. planegcs names whichever member of a
   * conflicting or redundant group it likes — not necessarily the new constraint — so the
   * diagnostics are compared with the sketch as it was before the pick. Nothing is committed on a
   * rejection, so there is nothing to undo: the sketch is simply left as it is.
   */
  private apply(constraint: ConstraintInput): void {
    const next = this.admit(constraint);
    if (next === undefined) return;
    this.status = undefined;
    this.picks = [];
    this.editor.commit(next);
    this.editor.viewChanged();
  }

  /**
   * The sketch with `constraint` added, or undefined when the solver rejects it (a conflict or a
   * redundancy) — recording the message the status bar shows, exactly as `apply` does today.
   */
  protected admit(constraint: ConstraintInput): Sketch | undefined {
    const draft = new Draft(this.editor.sketch);
    draft.constrain(constraint);
    const before = this.editor.evaluate(this.editor.sketch);
    const result = this.editor.evaluate(draft.sketch);
    if (introduced(result.conflicting, before.conflicting)) {
      this.reject({ key: `prompts.conflict.${constraint.kind}` });
      return undefined;
    }
    if (introduced(result.redundant, before.redundant)) {
      this.reject({ key: 'prompts.redundant' });
      return undefined;
    }
    return draft.sketch;
  }

  private reject(message: Message): void {
    this.status = message;
    this.picks = [];
    this.editor.viewChanged();
  }

  /**
   * The entity under `world` that can serve as an operand of one of `kinds`.
   * Points win the hit test, but a command asking for a curve still gets the
   * nearest one when the click landed next to it.
   */
  private operandAt(world: Vec2, kinds: readonly OperandKind[]): Operand | undefined {
    const { sketch } = this.editor;
    const tolerance = this.editor.viewport.toWorldLength(HIT_PX);
    const hit = hitTest(sketch, world, { tolerance });
    const entity = sketch.entities.find((e) => e.id === hit);
    if (entity !== undefined && kinds.includes(entity.kind))
      return { id: entity.id, kind: entity.kind };

    const pt = pointLookup(sketch);
    let best: { operand: Operand; d: number } | undefined;
    for (const e of sketch.entities) {
      if (!kinds.includes(e.kind)) continue;
      const d = distanceTo(e, world, pt);
      if (d > tolerance) continue;
      // Ties keep the earlier entity, as hitTest does.
      if (best !== undefined && d >= best.d) continue;
      best = { operand: { id: e.id, kind: e.kind }, d };
    }
    return best?.operand;
  }
}

/** Whether `next` reports a constraint id that `before` did not. */
function introduced(next: readonly Id[], before: readonly Id[]): boolean {
  return next.some((id) => !before.includes(id));
}

/** Both operands, once the command has all of them. */
function pair(picks: readonly Operand[]): { a: Id; b: Id } | undefined {
  const [a, b] = picks;
  return a === undefined || b === undefined ? undefined : { a: a.id, b: b.id };
}

/** Two points merged into one. */
export class CoincidentCommand extends ConstraintCommand {
  readonly id = 'coincident';
  protected readonly operands = [POINT, SECOND_POINT];

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'coincident', ...both };
  }
}

/** A point locked where it is. */
export class FixCommand extends ConstraintCommand {
  readonly id = 'fix';
  protected readonly operands = [FIX_POINT];

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const [first] = picks;
    if (first === undefined) return undefined;
    const point = this.editor.sketch.entities.find((e) => e.id === first.id);
    if (point?.kind !== 'point') return undefined;
    return { kind: 'fix', point: point.id, x: point.x, y: point.y };
  }
}

/** Horizontal on a line, or between two points. */
export class HorizontalCommand extends ConstraintCommand {
  readonly id = 'horizontal';
  protected readonly operands = AXIS;

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const [a, b] = picks;
    if (a === undefined) return undefined;
    if (b === undefined) return a.kind === 'line' ? { kind: 'horizontal', a: a.id } : undefined;
    return { kind: 'horizontal', a: a.id, b: b.id };
  }
}

/** Vertical on a line, or between two points. */
export class VerticalCommand extends ConstraintCommand {
  readonly id = 'vertical';
  protected readonly operands = AXIS;

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const [a, b] = picks;
    if (a === undefined) return undefined;
    if (b === undefined) return a.kind === 'line' ? { kind: 'vertical', a: a.id } : undefined;
    return { kind: 'vertical', a: a.id, b: b.id };
  }
}

/** Two lines kept parallel. */
export class ParallelCommand extends ConstraintCommand {
  readonly id = 'parallel';
  protected readonly operands = [LINE, SECOND_LINE];

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'parallel', ...both };
  }
}

/** Two lines kept at right angles. */
export class PerpendicularCommand extends ConstraintCommand {
  readonly id = 'perpendicular';
  protected readonly operands = [LINE, SECOND_LINE];

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'perpendicular', ...both };
  }
}

/** Equal length for two lines, equal radius for circles and arcs. */
export class EqualCommand extends ConstraintCommand {
  readonly id = 'equal';
  protected readonly operands = [LINE_OR_CURVE, SECOND_OBJECT];

  protected override compatible(a: OperandKind, b: OperandKind): boolean {
    return a === 'line' ? b === 'line' : b !== 'line';
  }

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'equal', ...both };
  }
}

/** A curve touching another, or a line touching a curve. */
export class TangentCommand extends ConstraintCommand {
  readonly id = 'tangent';
  protected readonly operands = [LINE_OR_CURVE, SECOND_OBJECT];

  protected override compatible(a: OperandKind, b: OperandKind): boolean {
    return !(a === 'line' && b === 'line');
  }

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'tangent', ...both };
  }
}

/** A point placed at the middle of a line. */
export class MidpointCommand extends ConstraintCommand {
  readonly id = 'midpoint';
  protected readonly operands = [POINT, LINE];

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'midpoint', point: both.a, line: both.b };
  }
}

/** A point kept on a line. */
export class PointOnLineCommand extends ConstraintCommand {
  readonly id = 'pointOnLine';
  protected readonly operands = [POINT, LINE];

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'pointOnLine', point: both.a, line: both.b };
  }
}

/** A point kept on a circle or an arc. */
export class PointOnCurveCommand extends ConstraintCommand {
  readonly id = 'pointOnCurve';
  protected readonly operands = [POINT, CURVE];

  protected build(picks: readonly Operand[]): ConstraintInput | undefined {
    const both = pair(picks);
    return both === undefined ? undefined : { kind: 'pointOnCurve', point: both.a, curve: both.b };
  }
}

/** The constraint commands, keyed by the ids the ribbon and the aliases reference. */
export const CONSTRAINT_COMMANDS: ReadonlyMap<string, CommandFactory> = new Map<
  string,
  CommandFactory
>([
  ['coincident', (editor) => new CoincidentCommand(editor)],
  ['fix', (editor) => new FixCommand(editor)],
  ['horizontal', (editor) => new HorizontalCommand(editor)],
  ['vertical', (editor) => new VerticalCommand(editor)],
  ['parallel', (editor) => new ParallelCommand(editor)],
  ['perpendicular', (editor) => new PerpendicularCommand(editor)],
  ['equal', (editor) => new EqualCommand(editor)],
  ['tangent', (editor) => new TangentCommand(editor)],
  ['midpoint', (editor) => new MidpointCommand(editor)],
  ['pointOnLine', (editor) => new PointOnLineCommand(editor)],
  ['pointOnCurve', (editor) => new PointOnCurveCommand(editor)],
]);
