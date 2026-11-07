import { constraintRefs, definingPoints } from '../../core/edit';
import { nextIdNumber } from '../../core/draft';
import { evaluateSource } from '../../core/expr';
import { add, arcParams, distance, lineIntersection, scaled, sub, unit } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Arc, Constraint, Entity, Id, Line, Point, Value } from '../../core/model';
import type { Sketch } from '../../core/sketch';
import type { Command, EditRequest, Message, OverlayShape, PointerInput } from '../command';
import type { Editor } from '../editor';
import { hitTest } from '../hit';
import { HIT_PX } from './select';

/**
 * The two lines resolved at their shared vertex: where they cross, the unit direction of each
 * running from the vertex toward the endpoint the fillet keeps (its far end), and which endpoint
 * each line has at the vertex (its near end, the one the fillet trims away). `half` is half the
 * angle between the two directions — the wedge the fillet rounds.
 */
interface Vertex {
  readonly v: Vec2;
  readonly half: number;
  readonly line1: Line;
  readonly line2: Line;
  readonly nearA: Id;
  readonly farA: Vec2;
  readonly dirA: Vec2;
  readonly nearB: Id;
  readonly farB: Vec2;
  readonly dirB: Vec2;
}

/** One line seen from the vertex: the direction to its far end and its near-end id. */
interface Ray {
  readonly dir: Vec2;
  readonly nearId: Id;
  readonly far: Vec2;
}

/** The fillet a radius produces, in world coordinates. */
interface Preview {
  readonly centre: Vec2;
  readonly radius: number;
  /** Tangent point on the first line, `d` from the vertex along it. */
  readonly t1: Vec2;
  /** Tangent point on the second line, `d` from the vertex along it. */
  readonly t2: Vec2;
  /** Midpoint of the arc, where the value box opens. */
  readonly midpoint: Vec2;
}

/** Waiting for the two lines; `first` is the one already picked, if any. */
interface Picking {
  readonly kind: 'pick';
  readonly first: Id | undefined;
}

/** The radius follows the cursor, clamped so the tangent points stay on the lines. */
interface Placing {
  readonly kind: 'placing';
  readonly line1: Id;
  readonly line2: Id;
  cursor: Vec2 | undefined;
}

/** The value box is open on a placed fillet. */
interface Entering {
  readonly kind: 'entering';
  readonly line1: Id;
  readonly line2: Id;
  /** The measured radius the box carries, and what accepting it commits. */
  readonly value: number;
  /** Where the value box opens: the arc's midpoint. */
  readonly at: Vec2;
  /** Where the cursor was when the fillet was placed, so Esc puts it back there. */
  readonly cursor: Vec2;
}

type Phase = Picking | Placing | Entering;

/**
 * The fillet command, Inventor's way: pick two lines that meet at a corner, move the cursor to set
 * the radius, click to place, then type the radius — pre-filled with the measurement, so accepting
 * it rounds the corner where the cursor put it while a typed value drives it.
 *
 * The construction: at the vertex V the two lines form an angle θ. A fillet of radius r touches
 * each line a tangent length `d = r / tan(θ/2)` from V, at the tangent points T1 and T2. Its centre
 * sits on the bisector of the two directions, `r / sin(θ/2)` from V, so it is r from both tangent
 * points. Each line is trimmed by replacing its endpoint at V with the tangent point, and the arc
 * is built from the two tangent points — so it shares an endpoint with each line. That makes each
 * tangency a shared-endpoint one, which the solver expresses as the angle between the curve normals
 * through the shared point (see solver/translate.ts), the same topology a hand-built rounded corner
 * uses. The vertex the fillet consumes is dropped once nothing else needs it.
 */
export class FilletCommand implements Command {
  readonly id = 'fillet';
  /** Overrides the prompt until the next change, e.g. after a rejected value. */
  private status: Message | undefined;
  private phase: Phase = { kind: 'pick', first: undefined };

  constructor(private readonly editor: Editor) {}

  prompt(): Message {
    if (this.status !== undefined) return this.status;
    const phase = this.phase;
    if (phase.kind === 'placing') return { key: 'prompts.filletPlace' };
    if (phase.kind === 'entering') return { key: 'prompts.filletValue' };
    return { key: 'prompts.fillet' };
  }

  pointerMove(input: PointerInput): void {
    const phase = this.phase;
    if (phase.kind !== 'placing') return;
    phase.cursor = input.world;
    this.editor.viewChanged();
  }

  pointerUp(input: PointerInput): void {
    this.status = undefined;
    const phase = this.phase;
    if (phase.kind === 'placing') {
      this.place(input.world);
      return;
    }
    if (phase.kind === 'pick') this.pick(input.world);
  }

  /** Enter places the fillet at the cursor, the keyboard path to a click. */
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
    const phase = this.phase;
    if (phase.kind === 'entering') {
      this.status = undefined;
      this.phase = {
        kind: 'placing',
        line1: phase.line1,
        line2: phase.line2,
        cursor: phase.cursor,
      };
      this.editor.viewChanged();
      return true;
    }
    if (phase.kind === 'placing') {
      this.phase = { kind: 'pick', first: phase.line1 };
      this.editor.viewChanged();
      return true;
    }
    return false;
  }

  overlay(): readonly OverlayShape[] {
    const phase = this.phase;
    if (phase.kind === 'pick') {
      const first = phase.first;
      return first === undefined ? [] : [{ kind: 'highlight', ids: [first] }];
    }
    const highlight: OverlayShape = { kind: 'highlight', ids: [phase.line1, phase.line2] };
    const vertex = this.vertex(phase.line1, phase.line2);
    if (vertex === undefined) return [highlight];
    const radius =
      phase.kind === 'placing'
        ? phase.cursor !== undefined
          ? this.clampRadius(vertex, phase.cursor)
          : undefined
        : phase.value;
    const preview = radius === undefined ? undefined : this.preview(vertex, radius);
    if (preview === undefined) return [highlight];
    return [
      highlight,
      { kind: 'previewCircle', center: preview.centre, radius: preview.radius },
      { kind: 'previewLine', from: preview.t1, to: preview.t2 },
    ];
  }

  /** The value box on a placed fillet, pre-filled with the measurement. */
  get edit(): EditRequest | undefined {
    const phase = this.phase;
    if (phase.kind !== 'entering') return undefined;
    return { at: phase.at, value: phase.value, label: { key: 'prompts.filletValue' } };
  }

  /**
   * Applies what the user typed. Accepting the measurement untouched (`edited` false) rounds the
   * corner exactly where the cursor put it; otherwise the text is a parameter name or an expression
   * and the radius drives the fillet to it. An unusable value, or one the solver rejects, keeps the
   * box open so it can be fixed.
   */
  commitEdit(text: string, edited: boolean): boolean {
    const phase = this.phase;
    if (phase.kind !== 'entering') return false;
    const value = edited ? this.parse(text) : phase.value;
    if (value === undefined) return false;
    const radius = typeof value === 'number' ? value : this.editor.sketch.params[value];
    if (radius === undefined || !Number.isFinite(radius) || !(radius > 0)) return false;
    const vertex = this.vertex(phase.line1, phase.line2);
    if (vertex === undefined) return false;
    const next = this.build(vertex, radius, value);
    if (next === undefined || !this.editor.commit(next)) return false;
    this.reset();
    return true;
  }

  dispose(): void {
    this.phase = { kind: 'pick', first: undefined };
  }

  /** Takes the line under `world`; a non-line is no pick, and so is the first line again. */
  private pick(world: Vec2): void {
    const phase = this.phase;
    if (phase.kind !== 'pick') return;
    const hit = hitTest(this.editor.sketch, world, {
      tolerance: this.editor.viewport.toWorldLength(HIT_PX),
    });
    const entity =
      hit === undefined ? undefined : this.editor.sketch.entities.find((e) => e.id === hit);
    if (entity?.kind !== 'line') return;
    const first = phase.first;
    if (first === undefined) {
      this.phase = { kind: 'pick', first: entity.id };
      this.editor.viewChanged();
      return;
    }
    if (first === entity.id) return;
    if (this.vertex(first, entity.id) === undefined) {
      this.editor.setMessage({ key: 'prompts.incompatible' });
      this.editor.viewChanged();
      return;
    }
    this.phase = { kind: 'placing', line1: first, line2: entity.id, cursor: world };
    this.editor.viewChanged();
  }

  /** Puts the fillet where the cursor resolved it and opens the value box on it. */
  private place(cursor: Vec2): void {
    const phase = this.phase;
    if (phase.kind !== 'placing') return;
    const vertex = this.vertex(phase.line1, phase.line2);
    if (vertex === undefined) return;
    const preview = this.preview(vertex, this.clampRadius(vertex, cursor));
    if (preview === undefined) return;
    this.phase = {
      kind: 'entering',
      line1: phase.line1,
      line2: phase.line2,
      value: preview.radius,
      at: preview.midpoint,
      cursor,
    };
    this.editor.viewChanged();
  }

  private pointAt(id: Id): Vec2 | undefined {
    const entity = this.editor.sketch.entities.find((e) => e.id === id);
    return entity?.kind === 'point' ? { x: entity.x, y: entity.y } : undefined;
  }

  private lineAt(id: Id): Line | undefined {
    const entity = this.editor.sketch.entities.find((e) => e.id === id);
    return entity?.kind === 'line' ? entity : undefined;
  }

  /** The two lines resolved at their vertex, or undefined when they do not meet (parallel). */
  private vertex(line1Id: Id, line2Id: Id): Vertex | undefined {
    const line1 = this.lineAt(line1Id);
    const line2 = this.lineAt(line2Id);
    if (line1 === undefined || line2 === undefined) return undefined;
    const a1 = this.pointAt(line1.p1);
    const a2 = this.pointAt(line1.p2);
    const b1 = this.pointAt(line2.p1);
    const b2 = this.pointAt(line2.p2);
    if (a1 === undefined || a2 === undefined || b1 === undefined || b2 === undefined)
      return undefined;
    const v = lineIntersection(a1, a2, b1, b2);
    if (v === undefined) return undefined;
    const rayA = rayFrom(line1, a1, a2, v);
    const rayB = rayFrom(line2, b1, b2, v);
    const half =
      rayA !== undefined && rayB !== undefined ? halfAngle(rayA.dir, rayB.dir) : undefined;
    if (rayA === undefined || rayB === undefined || half === undefined) return undefined;
    return {
      v,
      half,
      line1,
      line2,
      nearA: rayA.nearId,
      farA: rayA.far,
      dirA: rayA.dir,
      nearB: rayB.nearId,
      farB: rayB.far,
      dirB: rayB.dir,
    };
  }

  /**
   * The radius the cursor asks for, clamped so the tangent length `d` never runs past either line's
   * far endpoint: the shorter line caps how far from the vertex the fillet may reach, and the
   * radius is rebuilt from the capped `d`.
   */
  private clampRadius(vertex: Vertex, cursor: Vec2): number {
    const { half, v } = vertex;
    const reach = Math.min(distance(v, vertex.farA), distance(v, vertex.farB));
    const d = Math.min(distance(cursor, v) / Math.tan(half), reach);
    return d * Math.tan(half);
  }

  /** The fillet `radius` produces at the vertex, or undefined when it is degenerate. */
  private preview(vertex: Vertex, radius: number): Preview | undefined {
    if (!(radius > 0) || !Number.isFinite(radius)) return undefined;
    const { half, v, dirA, dirB } = vertex;
    const d = radius / Math.tan(half);
    const t1 = add(v, scaled(dirA, d));
    const t2 = add(v, scaled(dirB, d));
    const bisector = unit(add(dirA, dirB));
    if (bisector === undefined) return undefined;
    const centre = add(v, scaled(bisector, radius / Math.sin(half)));
    const midpoint = arcMidpoint(centre, radius, t1, t2);
    if (midpoint === undefined) return undefined;
    return { centre, radius, t1, t2, midpoint };
  }

  /**
   * Builds the filleted sketch: the two trimmed lines, the new points, the arc and its constraints.
   */
  private build(vertex: Vertex, radius: number, value: Value): Sketch | undefined {
    const preview = this.preview(vertex, radius);
    if (preview === undefined) return undefined;
    const { t1, t2, centre } = preview;
    const { line1, line2, nearA, nearB } = vertex;
    const sketch = this.editor.sketch;
    let next = nextIdNumber(sketch);
    const freshId = (): Id => `e${next++}`;
    const t1Id = freshId();
    const t2Id = freshId();
    const centreId = freshId();
    const arcId = freshId();
    // The arc runs from start to end clockwise on screen; order its ends so the
    // sweep is the minor one, as the model stores it.
    const swap = minorSwap(centre, t1, t2);
    const arc: Arc = {
      kind: 'arc',
      id: arcId,
      center: centreId,
      start: swap ? t2Id : t1Id,
      end: swap ? t1Id : t2Id,
    };
    // Trim each line: its endpoint at the vertex is rewritten to the tangent
    // point, the far endpoint keeps its id, so the arc shares a point with each.
    const line1Next: Line = nearA === line1.p1 ? { ...line1, p1: t1Id } : { ...line1, p2: t1Id };
    const line2Next: Line = nearB === line2.p1 ? { ...line2, p1: t2Id } : { ...line2, p2: t2Id };
    const points: Point[] = [
      { kind: 'point', id: t1Id, x: t1.x, y: t1.y },
      { kind: 'point', id: t2Id, x: t2.x, y: t2.y },
      { kind: 'point', id: centreId, x: centre.x, y: centre.y },
    ];
    const added: Constraint[] = [
      { kind: 'tangent', id: freshId(), a: line1.id, b: arcId },
      { kind: 'tangent', id: freshId(), a: line2.id, b: arcId },
      { kind: 'radius', id: freshId(), curve: arcId, value },
    ];
    const replaced = new Set<Id>([nearA, nearB]);
    const rewritten = sketch.entities.map((e): Entity =>
      e.id === line1.id ? line1Next : e.id === line2.id ? line2Next : e,
    );
    const entities: Entity[] = [...rewritten, ...points, arc];
    const constraints = [...sketch.constraints, ...added];
    const assembled: Sketch = { ...sketch, entities, constraints };
    // Drop the vertex points the fillet consumed once nothing else references them.
    const referenced = referencedPoints(assembled);
    const kept = entities.filter(
      (e) => !(e.kind === 'point' && replaced.has(e.id) && !referenced.has(e.id)),
    );
    return { ...assembled, entities: kept };
  }

  /**
   * The value the user typed: a parameter name binds the name itself, so the
   * fillet tracks it, and anything else is an expression evaluated against the
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

  /** Back to the start, ready for the next fillet; the command stays active. */
  private reset(): void {
    this.phase = { kind: 'pick', first: undefined };
    this.status = undefined;
    this.editor.viewChanged();
  }
}

/** Which of a line's endpoints is nearer the vertex, and the direction to the far one. */
function rayFrom(line: Line, p1: Vec2, p2: Vec2, v: Vec2): Ray | undefined {
  const nearIsP1 = distance(v, p1) <= distance(v, p2);
  const far = nearIsP1 ? p2 : p1;
  const dir = unit(sub(far, v));
  // A far endpoint sitting on the vertex has no direction to run along.
  if (dir === undefined) return undefined;
  return { dir, nearId: nearIsP1 ? line.p1 : line.p2, far };
}

/** Half the angle between two unit directions, or undefined when they are parallel. */
function halfAngle(dirA: Vec2, dirB: Vec2): number | undefined {
  const dot = Math.max(-1, Math.min(1, dirA.x * dirB.x + dirA.y * dirB.y));
  const theta = Math.acos(dot);
  // Parallel or anti-parallel directions leave no wedge to round.
  if (!(theta > 0) || !(theta < Math.PI)) return undefined;
  return theta / 2;
}

/** Whether the arc from t1 to t2 must swap its ends so the sweep is the minor one. */
function minorSwap(centre: Vec2, t1: Vec2, t2: Vec2): boolean {
  const { endAngle, startAngle } = arcParams(centre, t1, t2);
  return endAngle - startAngle > Math.PI;
}

/** The point halfway along the minor arc from t1 to t2, where the value box opens. */
function arcMidpoint(centre: Vec2, radius: number, t1: Vec2, t2: Vec2): Vec2 | undefined {
  const swap = minorSwap(centre, t1, t2);
  const { endAngle, startAngle } = arcParams(centre, swap ? t2 : t1, swap ? t1 : t2);
  const angle = (startAngle + endAngle) / 2;
  return { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
}

/** Every point id some entity or constraint in `sketch` still refers to. */
function referencedPoints(sketch: Sketch): Set<Id> {
  const referenced = new Set<Id>();
  for (const entity of sketch.entities) {
    if (entity.kind === 'point') continue;
    for (const point of definingPoints(entity)) referenced.add(point);
  }
  for (const constraint of sketch.constraints) {
    for (const id of constraintRefs(constraint)) referenced.add(id);
  }
  return referenced;
}
