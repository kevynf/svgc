import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { constraintRefs } from '../../core/edit';
import { arcParams, distance, lineAngleDeg, perpendicularDistance } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Constraint, Id } from '../../core/model';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { DimensionCommand } from './dimension';
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
  ['dimension', (e) => new DimensionCommand(e)],
]);

function editorWith(sketch: Sketch = emptySketch()): Editor {
  const editor = new Editor(solver, sketch, commands, 'select');
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
    const { radius, startAngle, endAngle } = arcParams(c, pt(e.start), pt(e.end));
    const a = (startAngle + endAngle) / 2;
    return { x: c.x + radius * Math.cos(a), y: c.y + radius * Math.sin(a) };
  }
  throw new Error(`"${id}" is not a curve`);
}

function clickEntity(editor: Editor, id: Id): void {
  const p = pointOf(editor, id);
  click(editor, p.x, p.y);
}

function clickCurve(editor: Editor, id: Id): void {
  const p = onCurve(editor, id);
  click(editor, p.x, p.y);
}

const kinds = (s: Sketch) => s.constraints.map((c) => c.kind);

function last(editor: Editor): Constraint {
  const all = editor.sketch.constraints;
  const c = all[all.length - 1];
  if (c === undefined) throw new Error('no constraint was added');
  return c;
}

/** Every point's position, so a dimension can be proven to have moved nothing. */
function snapshot(editor: Editor): Map<Id, Vec2> {
  const points = new Map<Id, Vec2>();
  for (const e of editor.sketch.entities) {
    if (e.kind === 'point') points.set(e.id, { x: e.x, y: e.y });
  }
  return points;
}

function expectUnmoved(editor: Editor, before: Map<Id, Vec2>): void {
  for (const [id, was] of before) {
    expect(pointOf(editor, id)).toEqual(was);
  }
}

/** Both endpoints of a line, from their current positions. */
function endsOf(editor: Editor, id: Id): [Vec2, Vec2] {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind !== 'line') throw new Error(`"${id}" is not a line`);
  return [pointOf(editor, e.p1), pointOf(editor, e.p2)];
}

/** The angle the command should measure between two lines. */
function angleOf(editor: Editor, a: Id, b: Id): number {
  const [a1, a2] = endsOf(editor, a);
  const [b1, b2] = endsOf(editor, b);
  return lineAngleDeg(a1, a2, b1, b2);
}

describe('dimension', () => {
  it('asks for an object, then for the second one', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    clickEntity(editor, p1);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
    // The rubber band starts on the picked operand and ends on the cursor.
    expect(editor.activeCommand.overlay?.()).toEqual([
      { kind: 'highlight', ids: [p1] },
      { kind: 'previewLine', from: pointOf(editor, p1), to: pointOf(editor, p1) },
    ]);
  });

  it('draws a rubber band from the first operand to the cursor', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const line = b.line(a, c);
    const p = b.point(20, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p);
    editor.activeCommand.pointerMove?.(at(70, 90));
    expect(editor.activeCommand.overlay?.()).toEqual([
      { kind: 'highlight', ids: [p] },
      { kind: 'previewLine', from: pointOf(editor, p), to: { x: 70, y: 90 } },
    ]);
    // A line previews from its middle, where the dimension is measured from.
    editor.escape();
    clickCurve(editor, line);
    editor.activeCommand.pointerMove?.(at(70, 90));
    expect(editor.activeCommand.overlay?.()).toEqual([
      { kind: 'highlight', ids: [line] },
      { kind: 'previewLine', from: onCurve(editor, line), to: { x: 70, y: 90 } },
    ]);
  });

  it('dimensions a circle with its radius', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, circle);
    expect(kinds(editor.sketch)).toEqual(['radius']);
    expect(constraintRefs(last(editor))).toEqual([circle]);
    const added = last(editor);
    expect(added).toEqual({ kind: 'radius', id: added.id, curve: circle, value: 30 });
    expectUnmoved(editor, before);
  });

  it('dimensions an arc with the radius through its three points', () => {
    const b = new SketchBuilder();
    const center = b.point(0, 0);
    const start = b.point(50, 0);
    const end = b.point(0, 50);
    const arc = b.arc(center, start, end);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, arc);
    const expected = arcParams(pointOf(editor, center), pointOf(editor, start), pointOf(editor, end)).radius;
    const added = last(editor);
    expect(added).toEqual({ kind: 'radius', id: added.id, curve: arc, value: expected });
    expectUnmoved(editor, before);
  });

  it('dimensions two points with the distance between them', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    const p2 = b.point(30, 40);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickEntity(editor, p1);
    clickEntity(editor, p2);
    const value = distance(pointOf(editor, p1), pointOf(editor, p2));
    const added = last(editor);
    expect(added).toEqual({ kind: 'distance', id: added.id, a: p1, b: p2, value });
    expectUnmoved(editor, before);
  });

  it('dimensions a point and a line with the distance between them', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const line = b.line(a, c);
    const p = b.point(20, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickEntity(editor, p);
    clickCurve(editor, line);
    const value = perpendicularDistance(pointOf(editor, p), pointOf(editor, a), pointOf(editor, c));
    const added = last(editor);
    expect(added).toEqual({ kind: 'distance', id: added.id, a: p, b: line, value });
    expectUnmoved(editor, before);
  });

  it('keeps the point first when the line was picked first', () => {
    const b = new SketchBuilder();
    const a = b.point(0, 0);
    const c = b.point(100, 0);
    const line = b.line(a, c);
    const p = b.point(20, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, line);
    clickEntity(editor, p);
    const value = perpendicularDistance(pointOf(editor, p), pointOf(editor, a), pointOf(editor, c));
    const added = last(editor);
    // The solver reads a point-to-line distance as point first, line second.
    expect(added).toEqual({ kind: 'distance', id: added.id, a: p, b: line, value });
    expectUnmoved(editor, before);
  });

  it('dimensions two lines with the angle between them', () => {
    const b = new SketchBuilder();
    const l1 = b.line(b.point(0, 0), b.point(100, 0));
    const l2 = b.line(b.point(0, 60), b.point(30, 30));
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, l1);
    clickCurve(editor, l2);
    const added = last(editor);
    expect(added).toEqual({ kind: 'angle', id: added.id, a: l1, b: l2, value: angleOf(editor, l1, l2) });
    expectUnmoved(editor, before);
  });

  it('measures the angle counterclockwise on screen, wrapping past zero', () => {
    const b = new SketchBuilder();
    const l1 = b.line(b.point(0, 0), b.point(100, 0));
    const l2 = b.line(b.point(0, 60), b.point(0, 160));
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    const before = snapshot(editor);
    clickCurve(editor, l1);
    clickCurve(editor, l2);
    const added = last(editor);
    expect(added).toEqual({ kind: 'angle', id: added.id, a: l1, b: l2, value: 270 });
    expectUnmoved(editor, before);
  });

  it('rejects a curve as the second operand', () => {
    const b = new SketchBuilder();
    const p = b.point(0, 0);
    const circle = b.circle(b.point(50, 50), 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p);
    clickCurve(editor, circle);
    expect(editor.sketch.constraints).toEqual([]);
    // The rejection surfaces as the command's prompt, as it does for every
    // other constraint command.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.incompatible' });
  });

  it('rejects an arc after a line', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(0, 0), b.point(100, 0));
    const arc = b.arc(b.point(0, 60), b.point(50, 60), b.point(0, 110));
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, line);
    clickCurve(editor, arc);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.incompatible' });
  });

  it('rejects a second radius on the same circle', () => {
    const b = new SketchBuilder();
    const center = b.point(50, 50);
    const circle = b.circle(center, 30);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, circle);
    const before = snapshot(editor);
    clickCurve(editor, circle);
    expect(kinds(editor.sketch)).toEqual(['radius']);
    expectUnmoved(editor, before);
    // The value is measured, so the repeat says exactly what the first radius
    // already does: the solver calls that dependent rather than conflicting.
    // Either way the base class rejects the pick and commits nothing.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.redundant' });
  });

  it('stays active and starts a fresh dimension after one is applied', () => {
    const b = new SketchBuilder();
    const circle = b.circle(b.point(50, 50), 30);
    const p = b.point(-50, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickCurve(editor, circle);
    expect(editor.activeCommand.id).toBe('dimension');
    clickEntity(editor, p);
    expect(kinds(editor.sketch)).toEqual(['radius']);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimensionSecond' });
    expect(editor.activeCommand.overlay?.()).toEqual([
      { kind: 'highlight', ids: [p] },
      { kind: 'previewLine', from: pointOf(editor, p), to: pointOf(editor, p) },
    ]);
  });

  it('Esc backs out of the pending operand, then ends the command', () => {
    const b = new SketchBuilder();
    const p1 = b.point(0, 0);
    b.point(30, 0);
    const editor = editorWith(b.build());
    editor.startCommand('dimension');
    clickEntity(editor, p1);
    editor.escape();
    expect(editor.activeCommand.id).toBe('dimension');
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.dimension' });
    expect(editor.sketch.constraints).toEqual([]);
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });
});
