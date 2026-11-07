import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { arcParams, distance, perpendicularDistance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Constraint, Entity, Id } from '../../core/model';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { OverlayShape, PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { OffsetCommand } from './offset';
import { SelectCommand } from './select';

let solver: Solver;

beforeAll(async () => {
  solver = await createSolver();
});

afterAll(() => {
  solver.dispose();
});

const commands = new Map<string, CommandFactory>([
  ['select', (e) => new SelectCommand(e)],
  ['offset', (e) => new OffsetCommand(e)],
]);

function editorWith(sketch: Sketch = emptySketch()): Editor {
  const editor = new Editor(solver, sketch, new Map(commands), 'select');
  editor.viewport.resize(800, 600);
  return editor;
}

function at(x: number, y: number): PointerInput {
  return { screen: { x, y }, world: { x, y }, shift: false, ctrl: false, alt: false };
}

function click(editor: Editor, x: number, y: number): void {
  const input = at(x, y);
  editor.activeCommand.pointerMove?.(input);
  editor.activeCommand.pointerDown?.(input);
  editor.activeCommand.pointerUp?.(input);
}

/** Where a point currently sits; the solver may have moved it since it was built. */
function pointOf(editor: Editor, id: Id): Vec2 {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'point') throw new Error(`"${id}" is not a point`);
  return { x: e.x, y: e.y };
}

function expectPoint(editor: Editor, id: Id, x: number, y: number): void {
  const p = pointOf(editor, id);
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
}

/** A point on the middle of a line, or on the rim of a circle or arc. */
function onCurve(editor: Editor, id: Id): Vec2 {
  const e = editor.sketch.entities.find((x) => x.id === id);
  const pt = (p: Id) => pointOf(editor, p);
  if (e?.kind === 'line') {
    const [a, b] = [pt(e.p1), pt(e.p2)];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  if (e?.kind === 'circle') {
    const c = pt(e.center);
    return { x: c.x + e.radius, y: c.y };
  }
  if (e?.kind === 'arc') {
    const c = pt(e.center);
    const { radius, startAngle, endAngle } = arcParams(c, pt(e.start), pt(e.end));
    const a = (startAngle + endAngle) / 2;
    return { x: c.x + radius * Math.cos(a), y: c.y + radius * Math.sin(a) };
  }
  throw new Error(`"${id}" is not a curve`);
}

function clickCurve(editor: Editor, id: Id): void {
  const p = onCurve(editor, id);
  click(editor, p.x, p.y);
}

function clickEntity(editor: Editor, id: Id): void {
  const p = pointOf(editor, id);
  click(editor, p.x, p.y);
}

type PreviewLine = Extract<OverlayShape, { kind: 'previewLine' }>;
type PreviewCircle = Extract<OverlayShape, { kind: 'previewCircle' }>;

/** The parallel copy's preview line, or undefined when the command draws none. */
function previewLine(editor: Editor): PreviewLine | undefined {
  const shapes = editor.activeCommand.overlay?.() ?? [];
  return shapes.find((s): s is PreviewLine => s.kind === 'previewLine');
}

/** The concentric copy's preview circle, or undefined when the command draws none. */
function previewCircle(editor: Editor): PreviewCircle | undefined {
  const shapes = editor.activeCommand.overlay?.() ?? [];
  return shapes.find((s): s is PreviewCircle => s.kind === 'previewCircle');
}

/** The entities a command is highlighting, e.g. the curve it has picked. */
function highlightIds(editor: Editor): readonly Id[] {
  const shape = (editor.activeCommand.overlay?.() ?? []).find((s) => s.kind === 'highlight');
  return shape?.kind === 'highlight' ? shape.ids : [];
}

/** The curve the offset command added: the sketch's last one, built after the original. */
function copyCurve(editor: Editor): Entity {
  const curves = editor.sketch.entities.filter((e) => e.kind !== 'point');
  const copy = curves[curves.length - 1];
  if (copy === undefined) throw new Error('no copy curve');
  return copy;
}

/** The line the offset command added: the sketch's last one, built after the original. */
function copyLine(editor: Editor): Extract<Entity, { kind: 'line' }> {
  const lines = editor.sketch.entities.filter((e) => e.kind === 'line');
  const copy = lines[lines.length - 1];
  if (copy?.kind !== 'line') throw new Error('no copy line');
  return copy;
}

function radiusOf(editor: Editor, id: Id): number {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind === 'circle') return e.radius;
  if (e?.kind !== 'arc') throw new Error(`"${id}" is not a curve`);
  return arcParams(pointOf(editor, e.center), pointOf(editor, e.start), pointOf(editor, e.end)).radius;
}

/** An arc's start and end angles, as `arcParams` measures them. */
function anglesOf(editor: Editor, id: Id): { startAngle: number; endAngle: number } {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'arc') throw new Error(`"${id}" is not an arc`);
  return arcParams(pointOf(editor, e.center), pointOf(editor, e.start), pointOf(editor, e.end));
}

/** The last constraint, failing loudly when none was added. */
function last(editor: Editor): Constraint {
  const all = editor.sketch.constraints;
  const c = all[all.length - 1];
  if (c === undefined) throw new Error('no constraint was added');
  return c;
}

/** Every point's position, so an offset can be proven to have moved nothing. */
function snapshot(editor: Editor): Map<Id, Vec2> {
  const points = new Map<Id, Vec2>();
  for (const e of editor.sketch.entities) {
    if (e.kind === 'point') points.set(e.id, { x: e.x, y: e.y });
  }
  return points;
}

function expectUnmoved(editor: Editor, before: Map<Id, Vec2>): void {
  for (const [id, was] of before) {
    const now = pointOf(editor, id);
    expect(now.x).toBeCloseTo(was.x, 6);
    expect(now.y).toBeCloseTo(was.y, 6);
  }
}

/** Applies what the user typed in the value box; false keeps it open. */
function commitEdit(editor: Editor, text: string, edited: boolean): boolean {
  return editor.activeCommand.commitEdit?.(text, edited) ?? false;
}

/** A horizontal line to offset, with the points it runs between. */
function horizontalLine(b: SketchBuilder): { a: Id; c: Id; line: Id } {
  const a = b.point(0, 0);
  const c = b.point(100, 0);
  return { a, c, line: b.line(a, c) };
}

describe('offset', () => {
  it('asks for a curve, and a point is no pick', () => {
    const b = new SketchBuilder();
    // A point on the line, where the line is at least as close to the cursor.
    const p = b.point(30, 0);
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offset' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.edit).toBeUndefined();
    // A point wins the hit test over any curve through it, so it is no pick.
    clickEntity(editor, p);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offset' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.id).toBe('offset');
    // The line itself is.
    clickCurve(editor, line);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetPlace' });
  });

  it('follows the cursor with a parallel copy, mirrored to the other side', () => {
    const b = new SketchBuilder();
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetPlace' });
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(highlightIds(editor)).toEqual([line]);
    // The click landed on the line, so the copy sits the minimum distance off it.
    expect(previewLine(editor)).toEqual({ kind: 'previewLine', from: { x: 0, y: -14 }, to: { x: 100, y: -14 } });
    // The cursor picks the side and the distance: below the line, 50 away…
    editor.activeCommand.pointerMove?.(at(50, 50));
    expect(previewLine(editor)).toEqual({ kind: 'previewLine', from: { x: 0, y: 50 }, to: { x: 100, y: 50 } });
    // …and above it, mirrored, at whatever distance the cursor is.
    editor.activeCommand.pointerMove?.(at(50, -30));
    expect(previewLine(editor)).toEqual({ kind: 'previewLine', from: { x: 0, y: -30 }, to: { x: 100, y: -30 } });
    // Nothing is committed while the copy follows the cursor.
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.sketch.entities).toHaveLength(3);
  });

  it('opens the value box on the placed copy, pre-filled with the distance', () => {
    const b = new SketchBuilder();
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 50));
    click(editor, 50, 50);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetValue' });
    // The box opens on the copy's middle, carrying the distance the cursor measured.
    expect(editor.activeCommand.edit).toEqual({
      at: { x: 50, y: 50 },
      value: 50,
      label: { key: 'prompts.offsetValue' },
    });
    // The copy is still only a preview: nothing is committed until it is valued.
    expect(editor.sketch.constraints).toEqual([]);
  });

  it('places the copy at the measured distance, moving nothing', () => {
    const b = new SketchBuilder();
    const { a, c, line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 50));
    click(editor, 50, 50);
    const before = snapshot(editor);
    expect(commitEdit(editor, '', false)).toBe(true);
    // A parallel copy, one of its ends a measured distance from the original.
    const added = editor.sketch.constraints.slice(-2);
    expect(added.map((x) => x.kind)).toEqual(['parallel', 'distance']);
    const [parallel, offset] = added;
    if (parallel?.kind !== 'parallel' || offset?.kind !== 'distance') throw new Error('not the offset constraints');
    expect(parallel.a).toBe(line);
    const copy = copyLine(editor);
    expect(parallel.b).toBe(copy.id);
    expect(offset.a).toBe(copy.p1);
    expect(offset.b).toBe(line);
    expect(offset.value).toBe(50);
    // The copy is a full parallel line 50 below the original, its own length kept.
    expectPoint(editor, copy.p1, 0, 50);
    expectPoint(editor, copy.p2, 100, 50);
    expect(distance(pointOf(editor, copy.p1), pointOf(editor, copy.p2))).toBeCloseTo(100, 9);
    expect(perpendicularDistance(pointOf(editor, copy.p1), pointOf(editor, a), pointOf(editor, c))).toBeCloseTo(50, 9);
    expectUnmoved(editor, before);
    // The command stays active, ready for the next offset.
    expect(editor.activeCommand.id).toBe('offset');
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offset' });
    clickCurve(editor, line);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetPlace' });
  });

  it('drives the copy to the typed distance, on the side the cursor chose', () => {
    const b = new SketchBuilder();
    const { a, c, line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 50));
    click(editor, 50, 50);
    expect(commitEdit(editor, '40', true)).toBe(true);
    // The copy keeps the side it was placed on and takes the typed distance.
    const copy = copyLine(editor);
    expectPoint(editor, copy.p1, 0, 40);
    expectPoint(editor, copy.p2, 100, 40);
    expect(perpendicularDistance(pointOf(editor, copy.p1), pointOf(editor, a), pointOf(editor, c))).toBeCloseTo(40, 9);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: copy.p1, b: line, value: 40 });
    // The original never moved.
    expectPoint(editor, a, 0, 0);
    expectPoint(editor, c, 100, 0);
  });

  it('binds a parameter name, so the copy tracks it', () => {
    const b = new SketchBuilder();
    b.param('gap', 25);
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 50));
    click(editor, 50, 50);
    expect(commitEdit(editor, 'gap', true)).toBe(true);
    const copy = copyLine(editor);
    expectPoint(editor, copy.p1, 0, 25);
    expectPoint(editor, copy.p2, 100, 25);
    expect(last(editor)).toMatchObject({ kind: 'distance', a: copy.p1, b: line, value: 'gap' });
  });

  it('offsets a circle with a concentric copy sharing its centre', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, circle);
    expect(highlightIds(editor)).toEqual([circle]);
    // The click landed on the rim, so the copy is the minimum distance outside it.
    expect(previewCircle(editor)).toEqual({ kind: 'previewCircle', center: { x: 50, y: 50 }, radius: 44 });
    // The cursor measures from the centre: 20 from it, inside a circle of 30.
    editor.activeCommand.pointerMove?.(at(50, 30));
    expect(previewCircle(editor)).toEqual({ kind: 'previewCircle', center: { x: 50, y: 50 }, radius: 16 });
    // …and outside it, where the distance is taken as it stands.
    editor.activeCommand.pointerMove?.(at(50, 150));
    expect(previewCircle(editor)).toEqual({ kind: 'previewCircle', center: { x: 50, y: 50 }, radius: 100 });
    click(editor, 50, 150);
    const before = snapshot(editor);
    expect(commitEdit(editor, '', false)).toBe(true);
    // The copy shares the original's centre, so it follows it as it moves.
    const copy = copyCurve(editor);
    if (copy.kind !== 'circle') throw new Error('not a circle');
    expect(copy.center).toBe(center);
    expect(radiusOf(editor, copy.id)).toBeCloseTo(100, 9);
    expect(radiusOf(editor, circle)).toBeCloseTo(30, 9);
    // A radius carries the copy, and nothing else is constrained.
    expect(editor.sketch.constraints.map((x) => x.kind)).toEqual(['radius']);
    expect(last(editor)).toMatchObject({ kind: 'radius', curve: copy.id, value: 100 });
    expectUnmoved(editor, before);
  });

  it('drives the circle copy to the typed radius, leaving the original alone', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, circle);
    editor.activeCommand.pointerMove?.(at(50, 150));
    click(editor, 50, 150);
    expect(commitEdit(editor, '12', true)).toBe(true);
    const copy = copyCurve(editor);
    if (copy.kind !== 'circle') throw new Error('not a circle');
    expect(copy.center).toBe(center);
    expect(radiusOf(editor, copy.id)).toBeCloseTo(12, 9);
    expect(radiusOf(editor, circle)).toBeCloseTo(30, 9);
  });

  it('offsets an arc with a concentric copy at the same start and end angles', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(50, 0);
    const end = b.point(0, 50);
    const arc = b.arc(center, start, end);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    const before = snapshot(editor);
    clickCurve(editor, arc);
    expect(previewCircle(editor)).toEqual({ kind: 'previewCircle', center: { x: 0, y: 0 }, radius: 64 });
    // The cursor measures from the centre: 80 from it puts the copy outside the arc.
    editor.activeCommand.pointerMove?.(at(80, 0));
    expect(previewCircle(editor)).toEqual({ kind: 'previewCircle', center: { x: 0, y: 0 }, radius: 80 });
    click(editor, 80, 0);
    expect(commitEdit(editor, '', false)).toBe(true);
    const copy = copyCurve(editor);
    if (copy.kind !== 'arc') throw new Error('not an arc');
    // The copy is concentric with the original and keeps its start and end angles.
    expect(copy.center).toBe(center);
    const original = anglesOf(editor, arc);
    const copied = anglesOf(editor, copy.id);
    expect(copied.startAngle).toBeCloseTo(original.startAngle, 9);
    expect(copied.endAngle).toBeCloseTo(original.endAngle, 9);
    expect(radiusOf(editor, copy.id)).toBeCloseTo(80, 9);
    expect(radiusOf(editor, arc)).toBeCloseTo(50, 9);
    // Two new ends at the new radius, and a radius to hold it.
    expect(editor.sketch.entities.filter((e) => e.kind === 'point')).toHaveLength(5);
    expect(last(editor)).toMatchObject({ kind: 'radius', curve: copy.id, value: 80 });
    expectUnmoved(editor, before);
  });

  it('drives the arc copy to the typed radius', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(50, 0);
    const end = b.point(0, 50);
    const arc = b.arc(center, start, end);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, arc);
    editor.activeCommand.pointerMove?.(at(80, 0));
    click(editor, 80, 0);
    expect(commitEdit(editor, '80', true)).toBe(true);
    const copy = copyCurve(editor);
    if (copy.kind !== 'arc') throw new Error('not an arc');
    expect(radiusOf(editor, copy.id)).toBeCloseTo(80, 9);
    expect(radiusOf(editor, arc)).toBeCloseTo(50, 9);
    expect(anglesOf(editor, copy.id).startAngle).toBeCloseTo(anglesOf(editor, arc).startAngle, 9);
    expect(anglesOf(editor, copy.id).endAngle).toBeCloseTo(anglesOf(editor, arc).endAngle, 9);
  });

  it('leaves a copy that would collapse onto the centre unplaced', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 10);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, circle);
    // The cursor is on the centre, less than the minimum offset away: the copy
    // would be a negative radius, so nothing is drawn and the click places nothing.
    editor.activeCommand.pointerMove?.(at(50, 50));
    expect(previewCircle(editor)).toBeUndefined();
    expect(highlightIds(editor)).toEqual([circle]);
    click(editor, 50, 50);
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetPlace' });
    expect(editor.sketch.entities).toHaveLength(2);
    // Clear of the centre the copy is placed again.
    editor.activeCommand.pointerMove?.(at(50, 20));
    expect(previewCircle(editor)).toEqual({ kind: 'previewCircle', center: { x: 50, y: 50 }, radius: 30 });
    click(editor, 50, 20);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetValue' });
  });

  it('refuses a value the copy cannot carry, keeping the box open', () => {
    const b = new SketchBuilder();
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 50));
    click(editor, 50, 50);
    // A negative distance makes the solver throw, so it is refused.
    expect(commitEdit(editor, '-10', true)).toBe(false);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.edit).toBeDefined();
    // So is text that is not a value at all.
    expect(commitEdit(editor, 'abc', true)).toBe(false);
    expect(commitEdit(editor, '   ', true)).toBe(false);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.edit).toBeDefined();
    // The rejection surfaces as the command's prompt.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'properties.invalid' });
    // The measurement still applies once the box holds a usable value.
    expect(commitEdit(editor, '30', true)).toBe(true);
    expect(last(editor)).toMatchObject({ kind: 'distance', value: 30 });
  });

  it('refuses a radius the solver would reject', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, circle);
    editor.activeCommand.pointerMove?.(at(50, 150));
    click(editor, 50, 150);
    // A zero or negative radius makes the solver throw, so it is refused.
    expect(commitEdit(editor, '0', true)).toBe(false);
    expect(commitEdit(editor, '-5', true)).toBe(false);
    expect(editor.sketch.entities).toHaveLength(2);
    expect(editor.activeCommand.edit).toBeDefined();
    expect(commitEdit(editor, '20', true)).toBe(true);
    const copy = copyCurve(editor);
    expect(radiusOf(editor, copy.id)).toBeCloseTo(20, 9);
  });

  it('Esc backs out of the value box, the placement, then the command', () => {
    const b = new SketchBuilder();
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 50));
    click(editor, 50, 50);
    // The value box: back to placing, with the copy where it was put.
    editor.escape();
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetPlace' });
    expect(previewLine(editor)).toEqual({ kind: 'previewLine', from: { x: 0, y: 50 }, to: { x: 100, y: 50 } });
    expect(editor.sketch.constraints).toEqual([]);
    // The placement: back to picking, with nothing left to draw.
    editor.escape();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offset' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.id).toBe('offset');
    // The pick: the command ends.
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });

  it('drops the entry when the value box is cancelled', () => {
    const b = new SketchBuilder();
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 50));
    click(editor, 50, 50);
    editor.activeCommand.cancelEdit?.();
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetPlace' });
    expect(editor.sketch.constraints).toEqual([]);
    // The copy follows the cursor again, and can still be placed.
    editor.activeCommand.pointerMove?.(at(50, 20));
    click(editor, 50, 20);
    expect(editor.activeCommand.edit).toEqual({
      at: { x: 50, y: 20 },
      value: 20,
      label: { key: 'prompts.offsetValue' },
    });
  });

  it('places the copy with Enter, at the cursor', () => {
    const b = new SketchBuilder();
    const { line } = horizontalLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('offset');
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(50, 60));
    expect(editor.activeCommand.keyDown!({ key: 'Enter' } as unknown as KeyboardEvent)).toBe(true);
    // The box opens where the copy was following the cursor.
    expect(editor.activeCommand.edit).toEqual({
      at: { x: 50, y: 60 },
      value: 60,
      label: { key: 'prompts.offsetValue' },
    });
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.offsetValue' });
    expect(commitEdit(editor, '', false)).toBe(true);
  });
});
