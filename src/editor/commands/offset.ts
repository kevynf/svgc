import { Draft } from '../../core/draft';
import { evaluateSource } from '../../core/expr';
import {
  add,
  arcParams,
  distance,
  midpoint,
  scaled,
  segmentNormal,
  sub,
  unit,
} from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Id, Value } from '../../core/model';
import type { Command, EditRequest, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { hitTest } from '../hit';
import { HIT_PX } from './select';

/**
 * How far the copy sits from the original at the least, on screen — the floor a
 * dimension being placed uses, so the copy never lands on the geometry it came
 * from at any zoom.
 */
const MIN_OFFSET_PX = 14;
/** A radius below this is refused: the solver rejects a zero or negative one. */
const MIN_RADIUS = 1e-6;

/**
 * The picked curve, resolved to the geometry an offset is measured from: where
 * its points sit now, plus the ids a copy needs. The editor holds the solved
 * sketch, so these positions already account for every constraint applied so
 * far. Undefined for a curve with nothing to offset: a zero-length line, a zero
 * radius, or a missing point.
 */
type Source =
  | { readonly kind: 'line'; readonly id: Id; readonly a: Vec2; readonly b: Vec2 }
  | {
      readonly kind: 'circle';
      readonly id: Id;
      readonly centerId: Id;
      readonly center: Vec2;
      readonly radius: number;
    }
  | {
      readonly kind: 'arc';
      readonly id: Id;
      /** Reused by the copy, so the copy follows the original's centre. */
      readonly centerId: Id;
      readonly center: Vec2;
      readonly radius: number;
      /** Unit directions from the centre to the original's ends, kept by the copy. */
      readonly startDir: Vec2;
      readonly endDir: Vec2;
    };

/** The copy an offset produces, in world coordinates. */
type Copy =
  | { readonly kind: 'line'; readonly from: Vec2; readonly to: Vec2 }
  | { readonly kind: 'curve'; readonly center: Vec2; readonly radius: number };

/** What a cursor resolved: the offset, the value the box carries, where it opens. */
interface Resolved {
  /** Signed world distance from the curve; its sign is the side the copy sits on. */
  readonly offset: number;
  readonly value: number;
  readonly at: Vec2;
}

/** Waiting for the curve to offset. */
interface Picking {
  readonly kind: 'pick';
}

/** The copy follows the cursor, which sets the side and the distance. */
interface Placing {
  readonly kind: 'placing';
  readonly source: Id;
  /** Where the cursor is: the copy follows it, and Enter places it here. */
  cursor: Vec2 | undefined;
}

/** The value box is open on a placed copy. */
interface Entering {
  readonly kind: 'entering';
  readonly source: Id;
  /** The signed offset the cursor resolved; its sign is the side the copy sits on. */
  readonly offset: number;
  /** The measured value the box carries, and what accepting it commits. */
  readonly value: number;
  /** Where the cursor was when the copy was placed, so Esc puts it back there. */
  readonly cursor: Vec2;
  readonly at: Vec2;
}

/** Where the command is: picking the curve, placing the copy, valuing it. */
type Phase = Picking | Placing | Entering;

/**
 * The offset command, Inventor's way: pick a line, circle or arc, move the
 * cursor to choose the side and the distance, click to place the copy, then type
 * the distance — pre-filled with the measurement, so accepting it moves nothing
 * while a typed value drives the copy to it. A line is copied parallel to
 * itself, a circle or an arc concentrically at the same start and end angles.
 *
 * The copy stays attached to what it came from: a line's copy is parallel to it
 * with one end a measured distance away, so it holds the offset while keeping
 * its own length; a circle's or arc's copy shares the original's centre and
 * carries a radius, so it follows that centre as it moves. The distance is never
 * negative — the solver refuses one — so the side the cursor chose lives in the
 * copy's geometry rather than in its value. The command stays active for the
 * next one.
 */
export class OffsetCommand implements Command {
  readonly id = 'offset';
  /** Overrides the prompt until the next change, e.g. after a rejected value. */
  private status: Message | undefined;
  private phase: Phase = { kind: 'pick' };

  constructor(private readonly editor: Editor) {}

  prompt(): Message {
    if (this.status !== undefined) return this.status;
    const phase = this.phase;
    if (phase.kind === 'placing') return { key: 'prompts.offsetPlace' };
    if (phase.kind === 'entering') return { key: 'prompts.offsetValue' };
    return { key: 'prompts.offset' };
  }

  pointerMove(input: PointerInput): void {
    const phase = this.phase;
    // The copy follows the cursor while it is being placed; the value box owns
    // the pointer once it is open.
    if (phase.kind !== 'placing') return;
    phase.cursor = input.world;
    this.editor.viewChanged();
  }

  pointerUp(input: PointerInput): void {
    this.status = undefined;
    const phase = this.phase;
    // A click puts the copy where it follows the cursor and opens the value box;
    // while a pick is pending it takes the curve under the cursor.
    if (phase.kind === 'placing') {
      this.place(input.world);
      return;
    }
    if (phase.kind === 'pick') this.pick(input.world);
  }

  /** Enter places the copy at the cursor, the keyboard path to a click. */
  keyDown(event: KeyboardEvent): boolean {
    const phase = this.phase;
    if (event.key !== 'Enter' || phase.kind !== 'placing') return false;
    if (phase.cursor !== undefined) this.place(phase.cursor);
    return true;
  }

  /** Esc in the value box: drops the entry and goes back to placing. */
  cancelEdit(): void {
    this.cancel();
  }

  cancel(): boolean {
    // Esc backs out one step at a time: the value box, the placement, the
    // pending pick, and only then the command itself.
    const phase = this.phase;
    if (phase.kind === 'entering') {
      // Back to placing, with the copy where it was put. A rejection recorded
      // while the box was open is stale now, so it goes too.
      this.status = undefined;
      this.phase = { kind: 'placing', source: phase.source, cursor: phase.cursor };
      this.editor.viewChanged();
      return true;
    }
    if (phase.kind === 'placing') {
      this.reset();
      return true;
    }
    return false;
  }

  overlay(): readonly OverlayShape[] {
    const phase = this.phase;
    if (phase.kind === 'pick') return [];
    const highlight: OverlayShape = { kind: 'highlight', ids: [phase.source] };
    const copy = this.previewOf(phase);
    if (copy === undefined) return [highlight];
    const preview: OverlayShape =
      copy.kind === 'line'
        ? { kind: 'previewLine', from: copy.from, to: copy.to }
        : { kind: 'previewCircle', center: copy.center, radius: copy.radius };
    return [highlight, preview];
  }

  /** The value box on a placed copy, pre-filled with the measurement. */
  get edit(): EditRequest | undefined {
    const phase = this.phase;
    if (phase.kind !== 'entering') return undefined;
    return { at: phase.at, value: phase.value, label: { key: 'prompts.offsetValue' } };
  }

  /**
   * Applies what the user typed. Accepting the measurement untouched (`edited`
   * false) places the copy exactly where the cursor put it; otherwise the text
   * is a parameter name or an expression and the value drives the copy to it —
   * on the side the cursor chose, since a distance is a magnitude. An unusable
   * value, or one the solver rejects, keeps the box open so it can be fixed.
   */
  commitEdit(text: string, edited: boolean): boolean {
    const phase = this.phase;
    if (phase.kind !== 'entering') return false;
    const value = edited ? this.parse(text) : phase.value;
    if (value === undefined) return false;
    const draft = this.build(phase.source, phase.offset, value);
    // A value the sketch cannot carry, or a solve it did not survive: nothing is
    // committed and the box stays open.
    if (draft === undefined || !this.editor.commit(draft.sketch)) return false;
    this.reset();
    return true;
  }

  dispose(): void {
    this.phase = { kind: 'pick' };
  }

  // ── Picking ──────────────────────────────────────────────────────────────

  /** Takes the curve under `world`; a point, or one with nothing to offset, is no pick. */
  private pick(world: Vec2): void {
    const hit = hitTest(this.editor.sketch, world, {
      tolerance: this.editor.viewport.toWorldLength(HIT_PX),
    });
    const source = hit === undefined ? undefined : this.sourceOf(hit);
    if (source === undefined) return;
    this.phase = { kind: 'placing', source: source.id, cursor: world };
    this.editor.viewChanged();
  }

  // ── Placing ──────────────────────────────────────────────────────────────

  /** Puts the copy where the cursor resolved it and opens the value box on it. */
  private place(cursor: Vec2): void {
    const phase = this.phase;
    if (phase.kind !== 'placing') return;
    const resolved = this.resolve(phase.source, cursor);
    // A copy the cursor cannot resolve — a radius the solver would refuse — is
    // not placed, and the command stays where it is.
    if (resolved === undefined) return;
    this.phase = {
      kind: 'entering',
      source: phase.source,
      offset: resolved.offset,
      value: resolved.value,
      cursor,
      at: resolved.at,
    };
    this.editor.viewChanged();
  }

  /** What the cursor resolves the copy to, or undefined when it cannot be built. */
  private resolve(source: Id, cursor: Vec2): Resolved | undefined {
    const from = this.sourceOf(source);
    if (from === undefined) return undefined;
    const offset = this.offsetOf(from, cursor);
    const copy = this.copyOf(from, offset);
    if (copy === undefined) return undefined;
    return {
      offset,
      // A line's copy is measured by how far it sits from the original; a
      // curve's by the radius it ends up with.
      value: copy.kind === 'line' ? Math.abs(offset) : copy.radius,
      at: this.anchorOf(copy, cursor),
    };
  }

  /**
   * The offset the cursor asks for: its signed distance from the curve, floored
   * at MIN_OFFSET_PX in magnitude so the copy never lands on the original. A
   * cursor with no distance to speak of takes the positive side, as a dimension
   * being placed does.
   */
  private offsetOf(source: Source, cursor: Vec2): number {
    const min = this.editor.viewport.toWorldLength(MIN_OFFSET_PX);
    const raw =
      source.kind === 'line'
        ? dot(sub(cursor, source.a), segmentNormal(source.a, source.b))
        : distance(cursor, source.center) - source.radius;
    return raw < 0 ? -Math.max(-raw, min) : Math.max(raw, min);
  }

  /** The copy `offset` produces, or undefined when the solver would refuse it. */
  private copyOf(source: Source, offset: number): Copy | undefined {
    switch (source.kind) {
      case 'line': {
        const shift = scaled(segmentNormal(source.a, source.b), offset);
        return { kind: 'line', from: add(source.a, shift), to: add(source.b, shift) };
      }
      case 'circle':
      case 'arc': {
        const radius = source.radius + offset;
        // A copy that would collapse onto the centre is not offered at all.
        return radius >= MIN_RADIUS ? { kind: 'curve', center: source.center, radius } : undefined;
      }
    }
  }

  /**
   * Where the value box opens: the middle of a line's copy, or the point of a
   * curve's copy nearest the cursor.
   */
  private anchorOf(copy: Copy, cursor: Vec2): Vec2 {
    if (copy.kind === 'line') return midpoint(copy.from, copy.to);
    const dir = unit(sub(cursor, copy.center));
    // A cursor on the centre has no direction; the copy's right-hand point stands in.
    return add(copy.center, scaled(dir ?? { x: 1, y: 0 }, copy.radius));
  }

  /**
   * The copy being previewed: from the cursor while it follows it, from the
   * resolved offset once it is placed.
   */
  private previewOf(phase: Placing | Entering): Copy | undefined {
    const source = this.sourceOf(phase.source);
    if (source === undefined) return undefined;
    if (phase.kind === 'entering') return this.copyOf(source, phase.offset);
    if (phase.cursor === undefined) return undefined;
    return this.copyOf(source, this.offsetOf(source, phase.cursor));
  }

  // ── Committing ───────────────────────────────────────────────────────────

  /** Builds the copy in a draft, or undefined when the value cannot be carried. */
  private build(id: Id, measured: number, value: Value): Draft | undefined {
    const from = this.sourceOf(id);
    if (from === undefined) return undefined;
    const magnitude = typeof value === 'number' ? value : this.editor.sketch.params[value];
    if (magnitude === undefined || !Number.isFinite(magnitude)) return undefined;
    const draft = new Draft(this.editor.sketch);
    switch (from.kind) {
      case 'line': {
        // A negative distance makes the solver throw, so a typed one is refused.
        if (magnitude < 0) return undefined;
        // The side the cursor chose is carried by the copy's geometry, since the
        // distance itself is only a magnitude.
        const side = measured < 0 ? -1 : 1;
        const shift = scaled(segmentNormal(from.a, from.b), side * magnitude);
        const p1 = draft.point(add(from.a, shift));
        const p2 = draft.point(add(from.b, shift));
        const copy = draft.line(p1, p2);
        // The copy keeps its own length: parallel holds its direction and the
        // distance holds the offset, so it may be re-lengthened freely.
        draft.constrain({ kind: 'parallel', a: from.id, b: copy });
        draft.constrain({ kind: 'distance', a: p1, b: from.id, value });
        return draft;
      }
      case 'circle': {
        // The solver refuses a zero or negative radius, so neither is placed.
        if (!(magnitude >= MIN_RADIUS)) return undefined;
        // The centre is the original's, so the copy follows it as it moves.
        const copy = draft.circle(from.centerId, magnitude);
        draft.constrain({ kind: 'radius', curve: copy, value });
        return draft;
      }
      case 'arc': {
        if (!(magnitude >= MIN_RADIUS)) return undefined;
        // New ends at the new radius along the original's directions keep the
        // start and end angles; the centre is the original's, as for a circle.
        const start = draft.point(add(from.center, scaled(from.startDir, magnitude)));
        const end = draft.point(add(from.center, scaled(from.endDir, magnitude)));
        const copy = draft.arc(from.centerId, start, end);
        draft.constrain({ kind: 'radius', curve: copy, value });
        return draft;
      }
    }
  }

  /**
   * The value the user typed: a parameter name binds the name itself, so the
   * copy tracks it, and anything else is an expression evaluated against the
   * sketch's parameters. Undefined — with the message the status bar shows —
   * when the text is unusable.
   */
  private parse(text: string): Value | undefined {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    if (this.editor.sketch.params[trimmed] !== undefined) return trimmed;
    try {
      return evaluateSource(trimmed, (name) => this.editor.sketch.params[name]);
    } catch {
      this.status = { key: 'properties.invalid' };
      this.editor.viewChanged();
      return undefined;
    }
  }

  /** Back to the start, ready for the next offset; the command stays active. */
  private reset(): void {
    this.phase = { kind: 'pick' };
    this.status = undefined;
    this.editor.viewChanged();
  }

  private sourceOf(id: Id): Source | undefined {
    const entity = this.editor.sketch.entities.find((e) => e.id === id);
    if (entity === undefined || entity.kind === 'point') return undefined;
    const point = (p: Id): Vec2 | undefined => {
      const e = this.editor.sketch.entities.find((x) => x.id === p);
      return e?.kind === 'point' ? { x: e.x, y: e.y } : undefined;
    };
    switch (entity.kind) {
      case 'line': {
        const [a, b] = [point(entity.p1), point(entity.p2)];
        // A zero-length line has no direction to offset along.
        if (a === undefined || b === undefined || distance(a, b) === 0) return undefined;
        return { kind: 'line', id, a, b };
      }
      case 'circle': {
        const center = point(entity.center);
        // A zero radius has no curve to measure an offset from.
        if (center === undefined || !(entity.radius > 0)) return undefined;
        return { kind: 'circle', id, centerId: entity.center, center, radius: entity.radius };
      }
      case 'arc': {
        const [center, start, end] = [point(entity.center), point(entity.start), point(entity.end)];
        if (center === undefined || start === undefined || end === undefined) return undefined;
        const { radius } = arcParams(center, start, end);
        if (!(radius > 0)) return undefined;
        const startDir = unit(sub(start, center));
        const endDir = unit(sub(end, center));
        if (startDir === undefined || endDir === undefined) return undefined;
        return { kind: 'arc', id, centerId: entity.center, center, radius, startDir, endDir };
      }
    }
  }
}

/** Projection of `a` onto `b`: the signed distance along `b` when `b` is a unit vector. */
function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}
