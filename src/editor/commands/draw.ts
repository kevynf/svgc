import { Draft } from '../../core/draft';
import { angleOf, arcParams, distance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Id } from '../../core/model';
import type { Command, MenuItem, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { hitTest } from '../hit';
import type { InferenceResult } from '../inference';
import { applyInferred, Picker, placePoint, snappedPoint } from './picker';
import type { Anchor } from './picker';

/** A picked location plus the inference that produced it, kept until the command commits. */
interface Pick {
  readonly position: Vec2;
  readonly result: InferenceResult;
}

function toPick(result: InferenceResult): Pick {
  return { position: result.position, result };
}

/** Resolves a pick inside a draft: reuses a snapped point or creates one with its curve constraints. */
function resolve(draft: Draft, pick: Pick): Id {
  const id = placePoint(draft, pick.result);
  if (snappedPoint(pick.result) === undefined) applyInferred(draft, pick.result, { point: id });
  return id;
}

function position(editor: Editor, id: Id, fallback: Vec2): Vec2 {
  const e = editor.sketch.entities.find((x) => x.id === id);
  return e?.kind === 'point' ? { x: e.x, y: e.y } : fallback;
}

abstract class DrawCommand implements Command {
  abstract readonly id: string;
  protected readonly picker: Picker;

  constructor(protected readonly editor: Editor) {
    this.picker = new Picker(editor);
  }

  abstract prompt(): Message;
  protected abstract click(pick: Pick, input: PointerInput): void;
  protected abstract preview(): OverlayShape[];
  /** Drops the in-progress step. Returns false when there was none. */
  protected abstract restart(): boolean;
  protected abstract anchor(): Anchor | undefined;

  pointerMove(input: PointerInput): void {
    const anchor = this.anchor();
    this.picker.update(input, anchor === undefined ? {} : { anchor });
    this.editor.viewChanged();
  }

  pointerUp(input: PointerInput): void {
    const anchor = this.anchor();
    const result = this.picker.update(input, anchor === undefined ? {} : { anchor });
    this.click(toPick(result), input);
    this.editor.viewChanged();
  }

  cancel(): boolean {
    return this.restart();
  }

  overlay(): readonly OverlayShape[] {
    return [...this.preview(), ...this.picker.overlay()];
  }

  menu(): readonly MenuItem[] {
    return [
      {
        label: { key: 'commands.restart' },
        icon: 'repeat',
        enabled: this.anchor() !== undefined,
        run: () => {
          this.restart();
          this.editor.viewChanged();
        },
      },
    ];
  }

  dispose(): void {
    this.picker.reset();
  }
}

/** Polyline: each click ends a segment and starts the next one from its end point. */
export class LineCommand extends DrawCommand {
  readonly id = 'line';
  private start: Pick | undefined;
  /** Id of the previous segment's end point when continuing a chain. */
  private startId: Id | undefined;
  /** Set while dragging an arc out of the chain's current start point. */
  private arcDrag: { from: Vec2; tangent: Vec2 } | undefined;

  prompt(): Message {
    if (this.arcDrag !== undefined) return { key: 'prompts.tangentArc' };
    return { key: this.start === undefined ? 'prompts.lineStart' : 'prompts.lineNext' };
  }

  protected anchor(): Anchor | undefined {
    if (this.start === undefined) return undefined;
    const id = this.startId ?? snappedPoint(this.start.result);
    return id === undefined
      ? { position: this.start.position }
      : { position: this.start.position, id };
  }

  /**
   * Dragging out of the start point (or of the curve the start point ends)
   * creates a tangent arc, as in Inventor; a plain drag draws a segment.
   */
  pointerDown(input: PointerInput): void {
    const start = this.start;
    this.arcDrag = undefined;
    if (start === undefined) return;
    const hit = hitTest(this.editor.sketch, input.world, { tolerance: this.picker.tolerance });
    const startPointId = this.startId ?? snappedPoint(start.result);
    const onStart =
      (hit !== undefined && hit === startPointId) ||
      distance(input.world, start.position) <= this.picker.tolerance;
    if (!onStart) return;

    const curveId = this.startCurveId;
    const tangent =
      startPointId !== undefined && curveId !== undefined
        ? exitDirection(this.editor, curveId, startPointId)
        : undefined;
    if (tangent === undefined) return;
    this.arcDrag = { from: start.position, tangent };
    this.editor.beginDrag();
  }

  override pointerMove(input: PointerInput): void {
    const arc = this.arcDrag;
    if (arc === undefined) {
      super.pointerMove(input);
      return;
    }
    this.picker.update(input, {
      anchor: { position: arc.from, id: this.startId },
      exclude: this.arcExclude(),
    });
    this.editor.viewChanged();
  }

  override pointerUp(input: PointerInput): void {
    const arc = this.arcDrag;
    this.arcDrag = undefined;
    if (arc === undefined) {
      super.pointerUp(input);
      return;
    }
    const pick = toPick(
      this.picker.update(input, { anchor: { position: arc.from }, exclude: this.arcExclude() }),
    );
    const shape = tangentArc(arc.from, arc.tangent, pick.position);
    this.editor.cancelDrag();
    if (shape === undefined || shape.radius < this.picker.tolerance) {
      this.editor.viewChanged();
      return;
    }
    const draft = new Draft(this.editor.sketch);
    const p1 = this.startId ?? (this.start === undefined ? undefined : resolve(draft, this.start));
    if (p1 === undefined) return;
    const p2 = placePoint(draft, pick.result);
    if (p1 === p2) return;
    const center = draft.point(shape.center);
    const id = shape.swapped ? draft.arc(center, p2, p1) : draft.arc(center, p1, p2);
    if (this.startCurveId !== undefined) {
      draft.constrain({ kind: 'tangent', a: this.startCurveId, b: id });
    }
    if (!this.editor.commit(draft.sketch)) return;

    const end = position(this.editor, p2, pick.position);
    this.start = { position: end, result: { position: end, constraints: [], alignments: [] } };
    this.startId = p2;
    this.editor.viewChanged();
  }

  protected click(pick: Pick): void {
    if (this.arcDrag !== undefined) return;
    const start = this.start;
    if (start === undefined) {
      this.start = pick;
      this.startId = undefined;
      return;
    }
    if (distance(start.position, pick.position) < this.picker.tolerance) return;

    const draft = new Draft(this.editor.sketch);
    const p1 = this.startId ?? resolve(draft, start);
    const p2 = placePoint(draft, pick.result);
    if (p1 === p2) return;
    const segment = draft.line(p1, p2);
    applyInferred(draft, pick.result, { point: p2, segment, anchor: p1 });
    if (!this.editor.commit(draft.sketch)) return;

    const end = position(this.editor, p2, pick.position);
    this.start = { position: end, result: { position: end, constraints: [], alignments: [] } };
    this.startId = p2;
  }

  /** Curve (line or arc) whose endpoint is the chain's current start point. */
  private get startCurveId(): Id | undefined {
    const startId = this.startId;
    if (startId === undefined) return undefined;
    return this.editor.sketch.entities.find(
      (e) =>
        (e.kind === 'line' && (e.p1 === startId || e.p2 === startId)) ||
        (e.kind === 'arc' && (e.start === startId || e.end === startId)),
    )?.id;
  }

  private arcExclude(): ReadonlySet<Id> {
    return new Set(this.startId === undefined ? [] : [this.startId]);
  }

  override cancel(): boolean {
    if (this.arcDrag !== undefined) {
      this.arcDrag = undefined;
      this.editor.endDrag();
      return true;
    }
    return super.cancel();
  }

  protected preview(): OverlayShape[] {
    const pick = this.picker.pick;
    if (this.start === undefined) return [];
    const arc = this.arcDrag;
    if (arc !== undefined && pick !== undefined) {
      const shape = tangentArc(arc.from, arc.tangent, pick.position);
      return shape === undefined ? [] : arcPreview(shape);
    }
    if (pick === undefined) return [];
    return [{ kind: 'previewLine', from: this.start.position, to: pick.position }];
  }

  protected restart(): boolean {
    if (this.start === undefined) return false;
    this.start = undefined;
    this.startId = undefined;
    return true;
  }
}

/** Center point circle: center, then a point on the rim. */
export class CircleCommand extends DrawCommand {
  readonly id = 'circle';
  private center: Pick | undefined;

  prompt(): Message {
    return { key: this.center === undefined ? 'prompts.circleCenter' : 'prompts.circleRadius' };
  }

  protected anchor(): Anchor | undefined {
    return undefined;
  }

  override pointerMove(input: PointerInput): void {
    this.picker.update(input, this.center === undefined ? {} : { pointsOnly: true });
    this.editor.viewChanged();
  }

  override pointerUp(input: PointerInput): void {
    const result = this.picker.update(input, this.center === undefined ? {} : { pointsOnly: true });
    this.click(toPick(result));
    this.editor.viewChanged();
  }

  protected click(pick: Pick): void {
    const center = this.center;
    if (center === undefined) {
      this.center = pick;
      return;
    }
    const radius = distance(center.position, pick.position);
    if (radius < this.picker.tolerance) return;
    const draft = new Draft(this.editor.sketch);
    const c = resolve(draft, center);
    const circle = draft.circle(c, radius);
    const rim = snappedPoint(pick.result);
    if (rim !== undefined && rim !== c)
      draft.constrain({ kind: 'pointOnCurve', point: rim, curve: circle });
    if (this.editor.commit(draft.sketch)) this.center = undefined;
  }

  protected preview(): OverlayShape[] {
    const pick = this.picker.pick;
    if (this.center === undefined || pick === undefined) return [];
    return [
      {
        kind: 'previewCircle',
        center: this.center.position,
        radius: distance(this.center.position, pick.position),
      },
    ];
  }

  protected restart(): boolean {
    if (this.center === undefined) return false;
    this.center = undefined;
    return true;
  }
}

/** Two point rectangle: opposite corners, edges constrained horizontal and vertical. */
export class RectangleCommand extends DrawCommand {
  readonly id = 'rectangle';
  private first: Pick | undefined;

  prompt(): Message {
    return { key: this.first === undefined ? 'prompts.rectFirst' : 'prompts.rectSecond' };
  }

  protected anchor(): Anchor | undefined {
    return undefined;
  }

  protected click(pick: Pick): void {
    const first = this.first;
    if (first === undefined) {
      this.first = pick;
      return;
    }
    const a = first.position;
    const c = pick.position;
    const tol = this.picker.tolerance;
    if (Math.abs(c.x - a.x) < tol || Math.abs(c.y - a.y) < tol) return;

    const draft = new Draft(this.editor.sketch);
    const p1 = resolve(draft, first);
    const p2 = draft.point({ x: c.x, y: a.y });
    const p3 = resolve(draft, pick);
    const p4 = draft.point({ x: a.x, y: c.y });
    const edges = [
      draft.line(p1, p2),
      draft.line(p2, p3),
      draft.line(p3, p4),
      draft.line(p4, p1),
    ] as const;
    draft.constrain({ kind: 'horizontal', a: edges[0] });
    draft.constrain({ kind: 'vertical', a: edges[1] });
    draft.constrain({ kind: 'horizontal', a: edges[2] });
    draft.constrain({ kind: 'vertical', a: edges[3] });
    if (this.editor.commit(draft.sketch)) this.first = undefined;
  }

  protected preview(): OverlayShape[] {
    const pick = this.picker.pick;
    if (this.first === undefined || pick === undefined) return [];
    const a = this.first.position;
    const c = pick.position;
    const corners = [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }];
    return corners.map((from, i) => ({ kind: 'previewLine', from, to: corners[(i + 1) % 4]! }));
  }

  protected restart(): boolean {
    if (this.first === undefined) return false;
    this.first = undefined;
    return true;
  }
}

interface ArcShape {
  readonly center: Vec2;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/** An arc as preview segments, so the overlay needs no arc primitive. */
function arcPreview(arc: ArcShape): OverlayShape[] {
  const n = Math.max(8, Math.ceil(((arc.endAngle - arc.startAngle) / (Math.PI * 2)) * 64));
  const at = (i: number): Vec2 => {
    const t = arc.startAngle + ((arc.endAngle - arc.startAngle) * i) / n;
    return {
      x: arc.center.x + arc.radius * Math.cos(t),
      y: arc.center.y + arc.radius * Math.sin(t),
    };
  };
  return Array.from({ length: n }, (_, i): OverlayShape => ({
    kind: 'previewLine',
    from: at(i),
    to: at(i + 1),
  }));
}

/**
 * The arc leaving `from` in direction `tangent` (unit) and ending at `to`,
 * oriented clockwise on screen like model arcs. Undefined when `to` lies on
 * the tangent line (the arc would be infinitely large).
 */
export function tangentArc(
  from: Vec2,
  tangent: Vec2,
  to: Vec2,
): (ArcShape & { readonly swapped: boolean }) | undefined {
  const n = { x: -tangent.y, y: tangent.x };
  const d = { x: to.x - from.x, y: to.y - from.y };
  const dn = d.x * n.x + d.y * n.y;
  const len2 = d.x * d.x + d.y * d.y;
  if (Math.abs(dn) < 1e-6 * Math.sqrt(len2) || len2 === 0) return undefined;
  const r = len2 / (2 * dn);
  const center = { x: from.x + n.x * r, y: from.y + n.y * r };
  // Moving clockwise on screen (increasing angle) at `from` heads along (-sin a, cos a).
  const a = angleOf(center, from);
  const swapped = -Math.sin(a) * tangent.x + Math.cos(a) * tangent.y < 0;
  const params = swapped ? arcParams(center, to, from) : arcParams(center, from, to);
  return { center, swapped, ...params };
}

/** Unit direction leaving `curve` at its endpoint `at`, continuing the curve. */
function exitDirection(editor: Editor, curveId: Id, at: Id): Vec2 | undefined {
  const sketch = editor.sketch;
  const curve = sketch.entities.find((e) => e.id === curveId);
  const point = (id: Id) => {
    const p = sketch.entities.find((e) => e.id === id);
    return p?.kind === 'point' ? p : undefined;
  };
  if (curve?.kind === 'line') {
    const [p1, p2] = [point(curve.p1), point(curve.p2)];
    if (p1 === undefined || p2 === undefined) return undefined;
    const [from, to] = curve.p2 === at ? [p1, p2] : [p2, p1];
    const len = distance(from, to);
    return len === 0 ? undefined : { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
  }
  if (curve?.kind === 'arc') {
    const c = point(curve.center);
    const p = point(at);
    if (c === undefined || p === undefined) return undefined;
    const a = angleOf(c, p);
    // Clockwise travel continues past `end`; leaving at `start` reverses it.
    return curve.end === at
      ? { x: -Math.sin(a), y: Math.cos(a) }
      : { x: Math.sin(a), y: -Math.cos(a) };
  }
  return undefined;
}

/** Center of the circle through three points, or undefined when they are (nearly) collinear. */
export function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | undefined {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const scale = Math.max(distance(a, b), distance(b, c), distance(a, c));
  if (Math.abs(d) < 1e-9 * scale * scale) return undefined;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}

/**
 * The arc through `start`, `through` and `end`, oriented the way the model
 * stores arcs (clockwise on screen). `swapped` tells whether start and end
 * had to trade places for that.
 */
export function threePointArc(
  start: Vec2,
  through: Vec2,
  end: Vec2,
):
  | { center: Vec2; swapped: boolean; radius: number; startAngle: number; endAngle: number }
  | undefined {
  const center = circumcenter(start, through, end);
  if (center === undefined) return undefined;
  const params = arcParams(center, start, end);
  let a = angleOf(center, through);
  while (a < params.startAngle) a += Math.PI * 2;
  if (a <= params.endAngle) return { center, swapped: false, ...params };
  return { center, swapped: true, ...arcParams(center, end, start) };
}

/** Three point arc (A3): start, end, then a point the arc passes through. */
export class ArcCommand extends DrawCommand {
  readonly id = 'arc';
  private start: Pick | undefined;
  private end: Pick | undefined;

  prompt(): Message {
    if (this.start === undefined) return { key: 'prompts.arcStart' };
    return { key: this.end === undefined ? 'prompts.arcEnd' : 'prompts.arcThrough' };
  }

  protected anchor(): Anchor | undefined {
    return undefined;
  }

  protected click(pick: Pick): void {
    if (this.start === undefined) {
      this.start = pick;
      return;
    }
    if (this.end === undefined) {
      if (distance(this.start.position, pick.position) >= this.picker.tolerance) this.end = pick;
      return;
    }
    const arc = threePointArc(this.start.position, pick.position, this.end.position);
    if (arc === undefined) return;

    const draft = new Draft(this.editor.sketch);
    const s = resolve(draft, this.start);
    const e = resolve(draft, this.end);
    if (s === e) return;
    const center = draft.point(arc.center);
    const id = arc.swapped ? draft.arc(center, e, s) : draft.arc(center, s, e);
    const through = snappedPoint(pick.result);
    if (through !== undefined && through !== s && through !== e) {
      draft.constrain({ kind: 'pointOnCurve', point: through, curve: id });
    }
    if (this.editor.commit(draft.sketch)) {
      this.start = undefined;
      this.end = undefined;
    }
  }

  protected preview(): OverlayShape[] {
    const pick = this.picker.pick;
    if (this.start === undefined || pick === undefined) return [];
    if (this.end === undefined)
      return [{ kind: 'previewLine', from: this.start.position, to: pick.position }];
    const arc = threePointArc(this.start.position, pick.position, this.end.position);
    if (arc === undefined)
      return [{ kind: 'previewLine', from: this.start.position, to: this.end.position }];
    return arcPreview(arc);
  }

  protected restart(): boolean {
    if (this.start === undefined) return false;
    if (this.end !== undefined) this.end = undefined;
    else this.start = undefined;
    return true;
  }
}

/** Sketch point: one click per point. */
export class PointCommand extends DrawCommand {
  readonly id = 'point';

  prompt(): Message {
    return { key: 'prompts.point' };
  }

  protected anchor(): Anchor | undefined {
    return undefined;
  }

  protected click(pick: Pick): void {
    if (snappedPoint(pick.result) !== undefined) return;
    const draft = new Draft(this.editor.sketch);
    resolve(draft, pick);
    this.editor.commit(draft.sketch);
  }

  protected preview(): OverlayShape[] {
    return [];
  }

  protected restart(): boolean {
    return false;
  }
}
