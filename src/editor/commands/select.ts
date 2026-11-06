import type { Vec2 } from '../../core/geometry';
import type { Id } from '../../core/model';
import type { Command, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { boxSelect, hitTest } from '../hit';
import { boxFrom } from '../viewport';

/** Hit tolerance in screen pixels; constant regardless of zoom. */
export const HIT_PX = 6;
/** Movement in screen pixels before a press becomes a drag. */
const DRAG_PX = 3;

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pressed'; readonly at: Vec2; readonly hit: Id | undefined; readonly input: PointerInput }
  | { readonly kind: 'dragging'; readonly point: Id }
  | { readonly kind: 'boxing'; readonly from: Vec2; to: Vec2; readonly additive: boolean };

/**
 * The default command. Click selects (Shift/Ctrl toggles), dragging a point
 * moves it under the constraints, dragging empty space draws a selection box:
 * left-to-right is a window, right-to-left a crossing selection.
 */
export class SelectCommand implements Command {
  readonly id = 'select';
  private state: State = { kind: 'idle' };

  constructor(private readonly editor: Editor) {}

  prompt(): Message {
    switch (this.state.kind) {
      case 'dragging':
        return { key: 'prompts.drag' };
      case 'boxing':
        return { key: this.boxMode() === 'window' ? 'prompts.windowSelect' : 'prompts.crossingSelect' };
      default:
        return { key: 'prompts.select' };
    }
  }

  pointerDown(input: PointerInput): void {
    this.state = { kind: 'pressed', at: input.screen, hit: this.hit(input.world), input };
  }

  pointerMove(input: PointerInput): void {
    const s = this.state;
    if (s.kind === 'idle') {
      this.editor.setHover(this.hit(input.world));
      return;
    }
    if (s.kind === 'pressed') {
      if (Math.hypot(input.screen.x - s.at.x, input.screen.y - s.at.y) < DRAG_PX) return;
      const target = s.hit === undefined ? undefined : this.editor.sketch.entities.find((e) => e.id === s.hit);
      if (target?.kind === 'point') {
        this.state = { kind: 'dragging', point: target.id };
        this.editor.beginDrag();
      } else {
        this.state = { kind: 'boxing', from: s.at, to: input.screen, additive: s.input.shift || s.input.ctrl };
        this.editor.setHover(undefined);
      }
    }
    const next = this.state;
    if (next.kind === 'dragging') {
      this.editor.dragPoint(next.point, input.world);
    } else if (next.kind === 'boxing') {
      next.to = input.screen;
      this.editor.viewChanged();
    }
  }

  pointerUp(input: PointerInput): void {
    const s = this.state;
    this.state = { kind: 'idle' };
    switch (s.kind) {
      case 'pressed': {
        const toggle = input.shift || input.ctrl;
        if (s.hit === undefined) {
          if (!toggle) this.editor.clearSelection();
        } else {
          this.editor.select([s.hit], toggle ? 'toggle' : 'replace');
        }
        return;
      }
      case 'dragging':
        this.editor.endDrag();
        return;
      case 'boxing': {
        const vp = this.editor.viewport;
        const box = boxFrom(vp.toWorld(s.from), vp.toWorld(s.to));
        const ids = boxSelect(this.editor.sketch, box, this.boxMode());
        this.editor.select(ids, s.additive ? 'add' : 'replace');
        return;
      }
      case 'idle':
        return;
    }
  }

  cancel(): boolean {
    const s = this.state;
    this.state = { kind: 'idle' };
    if (s.kind === 'dragging') {
      this.editor.cancelDrag();
      return true;
    }
    return s.kind === 'boxing';
  }

  overlay(): readonly OverlayShape[] {
    const s = this.state;
    if (s.kind !== 'boxing') return [];
    return [{ kind: 'selectionBox', box: boxFrom(s.from, s.to), mode: this.boxMode() }];
  }

  dispose(): void {
    if (this.state.kind === 'dragging') this.editor.endDrag();
    this.state = { kind: 'idle' };
  }

  private boxMode(): 'window' | 'crossing' {
    const s = this.state;
    return s.kind === 'boxing' && s.to.x < s.from.x ? 'crossing' : 'window';
  }

  private hit(world: Vec2): Id | undefined {
    return hitTest(this.editor.sketch, world, { tolerance: this.editor.viewport.toWorldLength(HIT_PX) });
  }
}
