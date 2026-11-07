import { distance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import { curveOf, extendTarget, trimTarget } from '../../core/intersect';
import type { Intersectable } from '../../core/intersect';
import type { Entity, Id } from '../../core/model';
import { indexEntities } from '../../core/sketch';
import type { EntityIndex } from '../../core/sketch';
import type { Key } from '../../i18n/i18n';
import type { Command, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { distanceTo, hitTest, pointLookup } from '../hit';
import { HIT_PX } from './select';

/** Screen px within which a click picks the endpoint it landed beside. */
const END_PX = 12;

/** Which end of a curve is being moved: a line's p1/p2, an arc's start/end. */
type End = 'start' | 'end';

/** The two ends, in the order a cursor equidistant from both settles in. */
const ENDS: readonly End[] = ['start', 'end'];

/** The points at a curve's ends. A circle has neither, so it is hovered but never picked. */
interface Ends {
  readonly start: Id;
  readonly end: Id;
}

/** Where an end would land: the crossing nearest it, inside the span for a trim, beyond it for an extend. */
type Target = (
  curve: Intersectable,
  end: End,
  others: readonly Intersectable[],
) => Vec2 | undefined;

/** What one of the two commands is about: its messages, and the crossing it aims an end at. */
interface Spec {
  /** Shown while the command waits for a curve. */
  readonly prompt: Key;
  /** Shown when the picked end has no crossing to move to. */
  readonly none: Key;
  readonly target: Target;
}

/** What a click would do: the end it picked, and where that end would land. */
interface Pick {
  readonly end: End;
  /** The point that would move. */
  readonly point: Id;
  /** Undefined when no crossing is in reach of that end. */
  readonly target: Vec2 | undefined;
}

/** What the cursor is on: the curve under it, and the end of it a click would move. */
interface Hover {
  readonly curve: Id;
  readonly pick: Pick | undefined;
}

/** The points at a curve's ends: a line's p1/p2, an arc's start/end. A circle has neither. */
function endsOf(entity: Entity): Ends | undefined {
  switch (entity.kind) {
    case 'line':
      return { start: entity.p1, end: entity.p2 };
    case 'arc':
      return { start: entity.start, end: entity.end };
    case 'point':
    case 'circle':
      return undefined;
  }
}

/** Where a point sits, or undefined when the id is not a point. */
function positionOf(index: EntityIndex, id: Id): Vec2 | undefined {
  const entity = index.get(id);
  return entity?.kind === 'point' ? { x: entity.x, y: entity.y } : undefined;
}

/**
 * Inventor's trim (TR) and extend (X). This model has no trim state — a curve
 * is its points, and nothing records where it was cut — so both commands move
 * the clicked endpoint to the crossing they ask for: a trim shortens the curve
 * to the nearest crossing inside its span, an extend lengthens it to the
 * nearest one beyond it. A point can be shared, so the curves built on it
 * follow the move; that is the cost of a model without trim state, and it is
 * what makes a trim parametric — the solver keeps everything else put.
 *
 * The command stays active once it has moved an end, as Inventor's TR does, so
 * a run of ends can be taken without going back to the ribbon.
 */
abstract class EndCommand implements Command {
  abstract readonly id: string;
  /** What the cursor last resolved; undefined over empty space. */
  private hover: Hover | undefined;

  protected constructor(
    private readonly editor: Editor,
    private readonly spec: Spec,
  ) {}

  prompt(): Message {
    // A refusal is a transient message on the editor, which the status bar
    // shows in place of this prompt until the next input.
    return { key: this.spec.prompt };
  }

  pointerMove(input: PointerInput): void {
    this.hover = this.hoverAt(input.world);
    this.editor.setHover(this.hover?.curve);
    // The marker follows the cursor along the curve, so the view must repaint.
    this.editor.viewChanged();
  }

  pointerUp(input: PointerInput): void {
    // The pick is taken from the click itself: the hover is only a preview, and
    // the sketch may have changed since the cursor last moved.
    const pick = this.hoverAt(input.world)?.pick;
    // Nothing under the cursor, or no end close enough to one: the command waits.
    if (pick === undefined) return;
    if (pick.target === undefined) {
      this.editor.setMessage({ key: this.spec.none });
      return;
    }
    // One undo step: the solver re-solves under the constraints, so the curves
    // built on a shared point are taken along.
    this.editor.setPointPosition(pick.point, pick.target.x, pick.target.y);
  }

  cancel(): boolean {
    // There is no step to back out of, so Esc ends the command.
    return false;
  }

  overlay(): readonly OverlayShape[] {
    const hover = this.hover;
    if (hover === undefined) return [];
    const highlight: OverlayShape = { kind: 'highlight', ids: [hover.curve] };
    const target = hover.pick?.target;
    // The marker shows where the end would land, before a click commits it.
    return target === undefined ? [highlight] : [{ kind: 'snap', at: target }, highlight];
  }

  dispose(): void {
    this.hover = undefined;
    this.editor.setHover(undefined);
  }

  /** What the cursor is on: the curve under it, and the end of it a click would move. */
  private hoverAt(world: Vec2): Hover | undefined {
    const entity = this.curveAt(world);
    if (entity === undefined) return undefined;
    const ends = endsOf(entity);
    // A circle has no ends to move, so it is hovered but never picked.
    if (ends === undefined) return { curve: entity.id, pick: undefined };
    const index = indexEntities(this.editor.sketch);
    return { curve: entity.id, pick: this.pickOn(entity, ends, index, world) };
  }

  /**
   * The curve under `world`. A point wins the hit test, and a click on an
   * endpoint is the most natural one here, so the nearest curve is taken when a
   * point wins — exactly as a constraint command asking for a curve does.
   */
  private curveAt(world: Vec2): Entity | undefined {
    const { sketch } = this.editor;
    const tolerance = this.editor.viewport.toWorldLength(HIT_PX);
    const hit = hitTest(sketch, world, { tolerance });
    const entity = hit === undefined ? undefined : sketch.entities.find((e) => e.id === hit);
    if (entity !== undefined && entity.kind !== 'point') return entity;

    const pt = pointLookup(sketch);
    let best: { entity: Entity; d: number } | undefined;
    for (const e of sketch.entities) {
      if (e.kind === 'point') continue;
      const d = distanceTo(e, world, pt);
      if (d > tolerance) continue;
      // Ties keep the earlier entity, as the hit test does.
      if (best !== undefined && d >= best.d) continue;
      best = { entity: e, d };
    }
    return best?.entity;
  }

  /** The end of `entity` a click at `world` would move, with the crossing it would land on. */
  private pickOn(entity: Entity, ends: Ends, index: EntityIndex, world: Vec2): Pick | undefined {
    const near = this.editor.viewport.toWorldLength(END_PX);
    let best: { end: End; point: Id; d: number } | undefined;
    for (const end of ENDS) {
      const point = ends[end];
      const at = positionOf(index, point);
      if (at === undefined) continue;
      const d = distance(at, world);
      if (d > near) continue;
      // Ties keep the earlier end.
      if (best !== undefined && d >= best.d) continue;
      best = { end, point, d };
    }
    // A cursor too far from either end is a click on the curve, not on an end.
    if (best === undefined) return undefined;
    const curve = curveOf(entity, index);
    // A degenerate curve has no span to cross, or to be shortened along.
    if (curve === undefined) return undefined;
    return {
      end: best.end,
      point: best.point,
      target: this.spec.target(curve, best.end, this.curves(index)),
    };
  }

  /**
   * Every curve in the sketch, degenerate ones dropped. The picked curve is
   * among them: the target search skips a curve that matches by geometry, so
   * its own ends are never targets.
   */
  private curves(index: EntityIndex): readonly Intersectable[] {
    const out: Intersectable[] = [];
    for (const entity of this.editor.sketch.entities) {
      const curve = curveOf(entity, index);
      if (curve !== undefined) out.push(curve);
    }
    return out;
  }
}

/** Inventor's TR: shorten a curve to the nearest crossing inside it. */
export class TrimCommand extends EndCommand {
  readonly id = 'trim';
  constructor(editor: Editor) {
    super(editor, { prompt: 'prompts.trim', none: 'prompts.trimNone', target: trimTarget });
  }
}

/** Inventor's X: lengthen a curve to the nearest crossing beyond its end. */
export class ExtendCommand extends EndCommand {
  readonly id = 'extend';
  constructor(editor: Editor) {
    super(editor, { prompt: 'prompts.extend', none: 'prompts.extendNone', target: extendTarget });
  }
}
