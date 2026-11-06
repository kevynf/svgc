import type { Draft } from '../../core/draft';
import type { Vec2 } from '../../core/geometry';
import type { Id } from '../../core/model';
import type { OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { hitTest } from '../hit';
import { infer, materialize } from '../inference';
import type { InferenceResult } from '../inference';

/** Snap distance in screen pixels; constant regardless of zoom. */
export const SNAP_PX = 8;

export interface Anchor {
  readonly position: Vec2;
  /** Set when the anchor is an existing point. */
  readonly id?: Id;
}

export interface PickOptions {
  readonly anchor?: Anchor;
  readonly exclude?: ReadonlySet<Id>;
  /** Only snap to existing points (e.g. a circle's rim). */
  readonly pointsOnly?: boolean;
}

/**
 * Turns cursor positions into inferred picks for the drawing commands and
 * draws the inference feedback (glyphs, alignment guides, snap marker).
 * The last line under the cursor becomes the parallel/perpendicular reference.
 */
export class Picker {
  private reference: Id | undefined;
  private current: InferenceResult | undefined;

  constructor(private readonly editor: Editor) {}

  get pick(): InferenceResult | undefined {
    return this.current;
  }

  get tolerance(): number {
    return this.editor.viewport.toWorldLength(SNAP_PX);
  }

  update(input: PointerInput, options: PickOptions = {}): InferenceResult {
    const { sketch } = this.editor;
    const tolerance = this.tolerance;
    const exclude = options.exclude ?? new Set<Id>();
    const hovered = hitTest(sketch, input.world, { tolerance, exclude });
    if (hovered !== undefined && sketch.entities.find((e) => e.id === hovered)?.kind === 'line') {
      this.reference = hovered;
    }
    let result = infer(sketch, input.world, {
      tolerance,
      enabled: !input.ctrl,
      exclude,
      ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
      ...(this.reference === undefined ? {} : { reference: this.reference }),
    });
    if (options.pointsOnly === true && !result.constraints.some((c) => c.kind === 'coincident')) {
      result = { position: input.world, constraints: [], alignments: [] };
    }
    this.current = result;
    const target = result.constraints.find((c) => c.kind === 'coincident' || c.kind === 'pointOnCurve');
    this.editor.setHover(target !== undefined && 'target' in target ? target.target : undefined);
    return result;
  }

  reset(): void {
    this.current = undefined;
    this.editor.setHover(undefined);
  }

  overlay(): OverlayShape[] {
    const pick = this.current;
    if (pick === undefined) return [];
    const shapes: OverlayShape[] = pick.alignments.map((alignment) => ({ kind: 'guide', alignment, to: pick.position }));
    if (pick.constraints.length > 0) {
      shapes.push({ kind: 'snap', at: pick.position });
      shapes.push({ kind: 'inferred', at: pick.position, constraints: pick.constraints });
    }
    return shapes;
  }
}

/** The existing point a pick snapped to, if any. */
export function snappedPoint(pick: InferenceResult): Id | undefined {
  const hit = pick.constraints.find((c) => c.kind === 'coincident');
  return hit?.kind === 'coincident' ? hit.target : undefined;
}

/**
 * Resolves a pick to a point id: the snapped existing point, or a new point
 * carrying the pick's inferred constraints. `segment`/`anchor` describe the
 * line ending at this point, if the command just created one.
 */
export function placePoint(draft: Draft, pick: InferenceResult): Id {
  return snappedPoint(pick) ?? draft.point(pick.position);
}

export function applyInferred(
  draft: Draft,
  pick: InferenceResult,
  ids: { readonly point: Id; readonly segment?: Id; readonly anchor?: Id },
): void {
  for (const constraint of materialize(pick.constraints, ids, draft.sketch)) draft.constrain(constraint);
}
