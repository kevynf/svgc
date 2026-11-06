import { Draft } from '../../core/draft';
import { distance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Id } from '../../core/model';
import type { Command, MenuItem, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
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

  prompt(): Message {
    return { key: this.start === undefined ? 'prompts.lineStart' : 'prompts.lineNext' };
  }

  protected anchor(): Anchor | undefined {
    if (this.start === undefined) return undefined;
    const id = this.startId ?? snappedPoint(this.start.result);
    return id === undefined ? { position: this.start.position } : { position: this.start.position, id };
  }

  protected click(pick: Pick): void {
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

  protected preview(): OverlayShape[] {
    const pick = this.picker.pick;
    if (this.start === undefined || pick === undefined) return [];
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
    if (rim !== undefined && rim !== c) draft.constrain({ kind: 'pointOnCurve', point: rim, curve: circle });
    if (this.editor.commit(draft.sketch)) this.center = undefined;
  }

  protected preview(): OverlayShape[] {
    const pick = this.picker.pick;
    if (this.center === undefined || pick === undefined) return [];
    return [{ kind: 'previewCircle', center: this.center.position, radius: distance(this.center.position, pick.position) }];
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
    const edges = [draft.line(p1, p2), draft.line(p2, p3), draft.line(p3, p4), draft.line(p4, p1)] as const;
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
