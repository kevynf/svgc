import { Draft } from '../../core/draft';
import { distance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Arc, Circle, Entity, EntityKind, Id, Line } from '../../core/model';
import type { Sketch } from '../../core/sketch';
import type { Command, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { hitTest, pointLookup } from '../hit';
import type { PointLookup } from '../hit';
import { HIT_PX } from './select';

/**
 * Inventor's MIRROR command. It runs in two phases: pick the curves to mirror
 * (each click toggles one into the set, Esc clears the set), Enter, then pick
 * the line to mirror them about. Every picked curve is copied across that axis
 * in a single step, and each copy is held in place by `symmetric` constraints
 * tying it to the curve it mirrors — so editing the original later drags its
 * mirror along with it. Sketch points are never mirrored.
 */
export class MirrorCommand implements Command {
  readonly id = 'mirror';
  private phase: Phase = 'pick';
  /** The curves to mirror, in the order they were picked. */
  private picked: readonly Id[] = [];

  constructor(private readonly editor: Editor) {}

  prompt(): Message {
    return { key: this.phase === 'pick' ? 'prompts.mirror' : 'prompts.mirrorLine' };
  }

  pointerMove(input: PointerInput): void {
    this.editor.setHover(this.curveAt(input.world, this.phase === 'pick' ? CURVES : AXIS));
  }

  pointerUp(input: PointerInput): void {
    if (this.phase === 'pick') this.toggle(this.curveAt(input.world, CURVES));
    else this.mirrorAbout(this.curveAt(input.world, AXIS));
    this.editor.viewChanged();
  }

  keyDown(event: KeyboardEvent): boolean {
    // Enter belongs to this command in both phases: with nothing picked there
    // is nothing to confirm, and in the line phase letting it through would
    // restart the command and drop the set.
    if (event.key !== 'Enter') return false;
    if (this.phase === 'pick' && this.picked.length > 0) this.phase = 'line';
    this.editor.viewChanged();
    return true;
  }

  cancel(): boolean {
    if (this.phase === 'line') {
      this.phase = 'pick';
      this.editor.viewChanged();
      return true;
    }
    if (this.picked.length === 0) return false;
    this.picked = [];
    this.editor.viewChanged();
    return true;
  }

  overlay(): readonly OverlayShape[] {
    // The highlight is all the feedback either phase needs: the axis is
    // already drawn as geometry, so a preview line would only repeat it.
    return this.picked.length === 0 ? [] : [{ kind: 'highlight', ids: this.picked }];
  }

  dispose(): void {
    this.picked = [];
    this.editor.setHover(undefined);
  }

  /** Adds the clicked curve to the set, or takes it back out when it is already there. */
  private toggle(id: Id | undefined): void {
    if (id === undefined) return;
    this.picked = this.picked.includes(id) ? this.picked.filter((p) => p !== id) : [...this.picked, id];
  }

  /** Copies every picked curve across `axis` and commits the lot as one step. */
  private mirrorAbout(axisId: Id | undefined): void {
    const axis = axisId === undefined ? undefined : this.axisAt(axisId);
    // The axis is one of the picked curves: mirroring a line about itself would
    // only lay a copy on top of it.
    if (axis === undefined || this.picked.length === 0 || this.picked.includes(axis.id)) return;
    const pt = pointLookup(this.editor.sketch);
    const draft = new Draft(this.editor.sketch);
    const construction = new Set<Id>();
    for (const picked of this.picked) {
      const curve = this.editor.sketch.entities.find((e) => e.id === picked);
      if (curve === undefined || curve.kind === 'point') continue;
      const copy = mirrorCurve(draft, curve, pt, axis);
      if (curve.construction === true) construction.add(copy);
    }
    // A rejected solve leaves the sketch as it is and raises the notice; the
    // command stays on the axis, so another line can be tried.
    if (!this.editor.commit(carryConstruction(draft.sketch, construction))) return;
    this.picked = [];
    this.phase = 'pick';
  }

  /** The entity under `world`, when it is one a click in this phase may pick. */
  private curveAt(world: Vec2, kinds: readonly EntityKind[]): Id | undefined {
    const hit = hitTest(this.editor.sketch, world, { tolerance: this.editor.viewport.toWorldLength(HIT_PX) });
    // Points win the hit test everywhere else; here they are simply not
    // mirrorable, so a click that lands on one picks nothing at all.
    const entity = this.editor.sketch.entities.find((e) => e.id === hit);
    return entity !== undefined && kinds.includes(entity.kind) ? entity.id : undefined;
  }

  /** The axis the clicked line runs through, or undefined when it has no direction. */
  private axisAt(id: Id): Axis | undefined {
    const line = this.editor.sketch.entities.find((e) => e.id === id);
    if (line?.kind !== 'line') return undefined;
    const pt = pointLookup(this.editor.sketch);
    const from = pt(line.p1);
    const to = pt(line.p2);
    // A line whose ends coincide has no normal to mirror about.
    return distance(from, to) === 0 ? undefined : { id: line.id, from, to };
  }
}

/** The two phases of the command: what to mirror, then what to mirror it about. */
type Phase = 'pick' | 'line';

/** What a click may pick in each phase. Sketch points are never mirrored, so 'pick' takes curves only. */
const CURVES: readonly EntityKind[] = ['line', 'circle', 'arc'];
const AXIS: readonly EntityKind[] = ['line'];

/** The mirror axis: the line, and the two points it runs through. */
interface Axis {
  readonly id: Id;
  readonly from: Vec2;
  readonly to: Vec2;
}

/**
 * Reflects `p` about the line through `a` and `b`. A line whose ends coincide
 * has no normal; the command refuses such an axis, and here the point simply
 * comes back unchanged.
 */
export function reflectPoint(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: p.x, y: p.y };
  const n = { x: dy / len, y: -dx / len };
  const k = (p.x - a.x) * n.x + (p.y - a.y) * n.y;
  return { x: p.x - 2 * n.x * k, y: p.y - 2 * n.y * k };
}

/**
 * Adds the mirror image of `curve`, reflected about `axis`, together with the
 * constraints that hold it there. Returns the new curve.
 */
function mirrorCurve(draft: Draft, curve: Line | Circle | Arc, pt: PointLookup, axis: Axis): Id {
  const copyPoint = (id: Id): Id => draft.point(reflectPoint(pt(id), axis.from, axis.to));
  /** Keeps `copy` where `original` reflects to. */
  const keep = (copy: Id, original: Id): void => {
    draft.constrain({ kind: 'symmetric', a: copy, b: original, line: axis.id });
  };

  switch (curve.kind) {
    case 'line': {
      const p1 = copyPoint(curve.p1);
      const p2 = copyPoint(curve.p2);
      keep(p1, curve.p1);
      keep(p2, curve.p2);
      return draft.line(p1, p2);
    }
    case 'circle': {
      const center = copyPoint(curve.center);
      const copy = draft.circle(center, curve.radius);
      keep(center, curve.center);
      // The reflected centre carries the copy across; the radius comes with it
      // and is kept equal to the original's.
      draft.constrain({ kind: 'equal', a: curve.id, b: copy });
      return copy;
    }
    case 'arc': {
      // A reflection reverses orientation, and the model stores an arc running
      // clockwise on screen from start to end, so the copy's ends are the
      // reflected originals the other way round. Its radius follows from the
      // three reflected points, so it needs no constraint of its own.
      const center = copyPoint(curve.center);
      const start = copyPoint(curve.end);
      const end = copyPoint(curve.start);
      keep(center, curve.center);
      keep(start, curve.end);
      keep(end, curve.start);
      return draft.arc(center, start, end);
    }
  }
}

/**
 * Inventor mirrors the construction flag, so the copy of a construction curve
 * is construction itself. `Draft` builds plain geometry, so the flag is
 * carried over here, once, on the curves the mirror just created.
 */
function carryConstruction(sketch: Sketch, ids: ReadonlySet<Id>): Sketch {
  if (ids.size === 0) return sketch;
  return {
    ...sketch,
    entities: sketch.entities.map((e): Entity =>
      ids.has(e.id) && e.kind !== 'point' ? { ...e, construction: true } : e,
    ),
  };
}
