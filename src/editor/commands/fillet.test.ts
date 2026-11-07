import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { arcParams, distance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Entity, Id } from '../../core/model';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { OverlayShape, PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { FilletCommand } from './fillet';
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
  ['fillet', (e) => new FilletCommand(e)],
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
    const { startAngle, endAngle } = arcParams(c, pt(e.start), pt(e.end));
    const angle = (startAngle + endAngle) / 2;
    const radius = distance(c, pt(e.start));
    return { x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) };
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

function previewLine(editor: Editor): PreviewLine | undefined {
  const shapes = editor.activeCommand.overlay?.() ?? [];
  return shapes.find((s): s is PreviewLine => s.kind === 'previewLine');
}

function previewCircle(editor: Editor): PreviewCircle | undefined {
  const shapes = editor.activeCommand.overlay?.() ?? [];
  return shapes.find((s): s is PreviewCircle => s.kind === 'previewCircle');
}

/** The entities a command is highlighting. */
function highlightIds(editor: Editor): readonly Id[] {
  const shape = (editor.activeCommand.overlay?.() ?? []).find((s) => s.kind === 'highlight');
  return shape?.kind === 'highlight' ? shape.ids : [];
}

/** The fillet arc: the sketch's only arc, built after the two lines. */
function filletArc(editor: Editor): Extract<Entity, { kind: 'arc' }> {
  const arc = editor.sketch.entities.find((e) => e.kind === 'arc');
  if (arc?.kind !== 'arc') throw new Error('no fillet arc');
  return arc;
}

function radiusOf(editor: Editor, id: Id): number {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind === 'circle') return e.radius;
  if (e?.kind !== 'arc') throw new Error(`"${id}" is not a curve`);
  return arcParams(pointOf(editor, e.center), pointOf(editor, e.start), pointOf(editor, e.end))
    .radius;
}

/** An arc's clockwise sweep, as `arcParams` measures it. */
function sweepOf(editor: Editor, id: Id): number {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'arc') throw new Error(`"${id}" is not an arc`);
  const { endAngle, startAngle } = arcParams(
    pointOf(editor, e.center),
    pointOf(editor, e.start),
    pointOf(editor, e.end),
  );
  return endAngle - startAngle;
}

/** Applies what the user typed in the value box; false keeps it open. */
function commitEdit(editor: Editor, text: string, edited: boolean): boolean {
  return editor.activeCommand.commitEdit?.(text, edited) ?? false;
}

const kinds = (s: Sketch) => s.constraints.map((c) => c.kind);

/** An L sharing the corner `v`, with the two lines' far endpoints. */
function corner(b: SketchBuilder): { v: Id; a: Id; c: Id; line1: Id; line2: Id } {
  const v = b.point(0, 0);
  const a = b.point(0, 100);
  const c = b.point(100, 0);
  return { v, a, c, line1: b.line(v, a), line2: b.line(v, c) };
}

describe('fillet', () => {
  it('asks for the first line, then the second', () => {
    const b = new SketchBuilder();
    const { line1, line2 } = corner(b);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.fillet' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.edit).toBeUndefined();
    // The first line is picked, and highlighted while the second is pending.
    clickCurve(editor, line1);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.fillet' });
    expect(highlightIds(editor)).toEqual([line1]);
    // A second, different line starts the placement.
    clickCurve(editor, line2);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.filletPlace' });
  });

  it('rounds a perpendicular corner into a quarter-circle fillet', () => {
    const b = new SketchBuilder();
    const { v, a, c, line1, line2 } = corner(b);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    // The radius is the cursor's distance from the corner (0, 0).
    const cursor = { x: 30, y: 30 };
    click(editor, cursor.x, cursor.y);
    const r = distance({ x: 0, y: 0 }, cursor);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.filletValue' });
    const beforeA = pointOf(editor, a);
    const beforeC = pointOf(editor, c);
    expect(commitEdit(editor, '', false)).toBe(true);

    // An arc, held by a radius, tangent to both trimmed lines.
    expect(kinds(editor.sketch).filter((k) => k === 'tangent' || k === 'radius')).toEqual([
      'tangent',
      'tangent',
      'radius',
    ]);
    const arc = filletArc(editor);
    expect(radiusOf(editor, arc.id)).toBeCloseTo(r, 6);
    // The arc is the minor one: a quarter turn, not the three-quarter way around.
    expect(sweepOf(editor, arc.id)).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(sweepOf(editor, arc.id)).toBeCloseTo(Math.PI / 2, 6);

    // A true quarter circle: the tangent points are r from the corner along each
    // line, and the centre is at (r, r) from it.
    const centre = pointOf(editor, arc.center);
    const ends = [pointOf(editor, arc.start), pointOf(editor, arc.end)];
    for (const end of ends) expect(distance({ x: 0, y: 0 }, end)).toBeCloseTo(r, 6);
    // One end sits on the vertical line (x = 0), the other on the horizontal (y = 0).
    const onVertical = ends.find((e) => Math.abs(e.x) < 1e-6);
    const onHorizontal = ends.find((e) => Math.abs(e.y) < 1e-6);
    expect(onVertical?.y).toBeCloseTo(r, 6);
    expect(onHorizontal?.x).toBeCloseTo(r, 6);
    expect(centre.x).toBeCloseTo(r, 6);
    expect(centre.y).toBeCloseTo(r, 6);

    // The corner the fillet consumed is gone; the far endpoints never moved.
    expect(editor.sketch.entities.find((e) => e.id === v)).toBeUndefined();
    expect(pointOf(editor, a)).toEqual(beforeA);
    expect(pointOf(editor, c)).toEqual(beforeC);
    // The command stays active, ready for the next fillet.
    expect(editor.activeCommand.id).toBe('fillet');
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.fillet' });
  });

  it('drives the radius to the typed value', () => {
    const b = new SketchBuilder();
    const { line1, line2 } = corner(b);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    click(editor, 30, 30);
    expect(commitEdit(editor, '25', true)).toBe(true);
    expect(radiusOf(editor, filletArc(editor).id)).toBeCloseTo(25, 6);
    // The tangent points are 25 from the corner along each line.
    const arc = filletArc(editor);
    for (const end of [pointOf(editor, arc.start), pointOf(editor, arc.end)]) {
      expect(distance({ x: 0, y: 0 }, end)).toBeCloseTo(25, 6);
    }
  });

  it('respects the tangent length r / tan(θ/2) for an acute corner', () => {
    const b = new SketchBuilder();
    const v = b.point(0, 0);
    const a = b.point(200, 0);
    const angle = Math.PI / 6; // 30° from the first line
    const c = b.point(200 * Math.cos(angle), 200 * Math.sin(angle));
    const line1 = b.line(v, a);
    const line2 = b.line(v, c);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    click(editor, 30, 30);
    expect(commitEdit(editor, '20', true)).toBe(true);

    const expected = 20 / Math.tan(Math.PI / 12); // r / tan(15°)
    expect(radiusOf(editor, filletArc(editor).id)).toBeCloseTo(20, 6);
    const arc = filletArc(editor);
    // The arc sweeps the supplement of the corner angle (180° − 30°), still minor.
    expect(sweepOf(editor, arc.id)).toBeLessThanOrEqual(Math.PI + 1e-9);
    expect(sweepOf(editor, arc.id)).toBeCloseTo(Math.PI - Math.PI / 6, 6);
    // The corner sat at the origin; each tangent point is the tangent length from it.
    for (const end of [pointOf(editor, arc.start), pointOf(editor, arc.end)]) {
      expect(distance({ x: 0, y: 0 }, end)).toBeCloseTo(expected, 6);
    }
  });

  it('clamps the radius so a tangent point never passes the shorter line', () => {
    const b = new SketchBuilder();
    const v = b.point(0, 0);
    const a = b.point(0, 100);
    const c = b.point(50, 0); // the shorter line
    const line1 = b.line(v, a);
    const line2 = b.line(v, c);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    // Drag far past the shorter line: the fillet clamps to it instead of
    // running a tangent point beyond its endpoint.
    editor.activeCommand.pointerMove?.(at(500, 500));
    expect(previewCircle(editor)?.radius).toBeCloseTo(50, 6);
    const chord = previewLine(editor);
    expect(chord).toBeDefined();
    // The tangent point on the shorter (horizontal) line sits at its endpoint
    // (50, 0), not beyond it; the other is 50 up the longer line.
    expect(chord?.to).toEqual({ x: 50, y: 0 });
    expect(chord?.from).toEqual({ x: 0, y: 50 });
  });

  it('refuses parallel lines and keeps the first pick', () => {
    const b = new SketchBuilder();
    const line1 = b.line(b.point(0, 0), b.point(100, 0));
    const line2 = b.line(b.point(0, 50), b.point(100, 50));
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    // The rejection surfaces as the editor's transient message, and the command
    // stays in the pick phase with its first line kept.
    expect(editor.message).toEqual({ key: 'prompts.incompatible' });
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.fillet' });
    expect(highlightIds(editor)).toEqual([line1]);
    expect(editor.activeCommand.id).toBe('fillet');
  });

  it('ignores a point, circle or arc, and the same line twice', () => {
    const b = new SketchBuilder();
    const { line1, line2 } = corner(b);
    const circle = b.circle(b.point(300, 50), 30);
    const arc = b.arc(b.point(300, 200), b.point(330, 200), b.point(300, 230));
    const pt = b.point(400, 400);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    // None of these is a line, so none is a pick.
    clickCurve(editor, circle);
    clickCurve(editor, arc);
    clickEntity(editor, pt);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.fillet' });
    expect(highlightIds(editor)).toEqual([]);
    // A line is picked, and clicking it again is no second pick.
    clickCurve(editor, line1);
    expect(highlightIds(editor)).toEqual([line1]);
    clickCurve(editor, line1);
    expect(highlightIds(editor)).toEqual([line1]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.fillet' });
    // A different line proceeds to the placement.
    clickCurve(editor, line2);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.filletPlace' });
  });

  it('Esc backs out of the value box, the placement, then the command', () => {
    const b = new SketchBuilder();
    const { line1, line2 } = corner(b);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    click(editor, 30, 30);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.filletValue' });
    // The value box: back to placing, with the fillet where it was put.
    editor.escape();
    expect(editor.activeCommand.edit).toBeUndefined();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.filletPlace' });
    expect(previewCircle(editor)).toBeDefined();
    // The placement: back to picking, keeping the first line.
    editor.escape();
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.fillet' });
    expect(highlightIds(editor)).toEqual([line1]);
    expect(editor.activeCommand.id).toBe('fillet');
    // The pick: the command ends.
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });

  it('places the fillet with Enter, at the cursor', () => {
    const b = new SketchBuilder();
    const { line1, line2 } = corner(b);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    editor.activeCommand.pointerMove?.(at(30, 30));
    expect(editor.activeCommand.keyDown!({ key: 'Enter' } as unknown as KeyboardEvent)).toBe(true);
    // The box opens on the arc, pre-filled with the measured radius.
    const edit = editor.activeCommand.edit;
    expect(edit?.value).toBeCloseTo(distance({ x: 0, y: 0 }, { x: 30, y: 30 }), 6);
    expect(edit?.label).toEqual({ key: 'prompts.filletValue' });
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.filletValue' });
    expect(commitEdit(editor, '', false)).toBe(true);
  });

  it('keeps the value box open on an unusable value', () => {
    const b = new SketchBuilder();
    const { line1, line2 } = corner(b);
    const editor = editorWith(b.build());
    editor.startCommand('fillet');
    clickCurve(editor, line1);
    clickCurve(editor, line2);
    click(editor, 30, 30);
    // Unparseable text, and a radius the solver would refuse, keep it open.
    expect(commitEdit(editor, 'abc', true)).toBe(false);
    expect(commitEdit(editor, '0', true)).toBe(false);
    expect(commitEdit(editor, '-5', true)).toBe(false);
    expect(kinds(editor.sketch)).toEqual([]);
    expect(editor.activeCommand.edit).toBeDefined();
    // The rejection surfaces as the command's prompt.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'properties.invalid' });
    // A usable value still applies.
    expect(commitEdit(editor, '30', true)).toBe(true);
    expect(radiusOf(editor, filletArc(editor).id)).toBeCloseTo(30, 6);
  });
});
