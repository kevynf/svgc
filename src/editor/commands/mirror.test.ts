import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SketchBuilder } from '../../core/builder';
import { constraintRefs } from '../../core/edit';
import { arcParams } from '../../core/geometry';
import type { Vec2 } from '../../core/geometry';
import type { Id, Line } from '../../core/model';
import { emptySketch } from '../../core/sketch';
import type { Sketch } from '../../core/sketch';
import { createSolver } from '../../solver/solver';
import type { Solver } from '../../solver/solver';
import type { PointerInput } from '../command';
import { Editor } from '../editor';
import type { CommandFactory } from '../editor';
import { MirrorCommand, reflectPoint } from './mirror';
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
  ['mirror', (e) => new MirrorCommand(e)],
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

/** A key press on the active command; true when the command consumed it. */
function press(editor: Editor, key: string): boolean {
  return editor.activeCommand.keyDown!({ key } as unknown as KeyboardEvent);
}

/** Enter, the key that takes the picked curves on to the axis. */
function enter(editor: Editor): void {
  expect(press(editor, 'Enter')).toBe(true);
}

/** Drags a point from one world position to another with the select command. */
function drag(editor: Editor, from: Vec2, to: Vec2): void {
  const command = editor.activeCommand;
  command.pointerDown?.(at(from.x, from.y));
  // Well past the drag threshold, so the press becomes a drag, not a click.
  command.pointerMove?.(at(from.x + 10, from.y));
  command.pointerMove?.(at(to.x, to.y));
  command.pointerUp?.(at(to.x, to.y));
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

/** Every point's position, so a mirror can be proven to have moved nothing. */
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

/** Where a point sits after the solve, compared within the solver's tolerance. */
function expectAt(editor: Editor, id: Id, p: Vec2): void {
  const solved = pointOf(editor, id);
  expect(solved.x).toBeCloseTo(p.x, 9);
  expect(solved.y).toBeCloseTo(p.y, 9);
}

/** The entities a command is highlighting, e.g. the curves it has picked. */
function highlightIds(editor: Editor): readonly Id[] {
  const shape = (editor.activeCommand.overlay?.() ?? []).find((s) => s.kind === 'highlight');
  return shape?.ids ?? [];
}

const kinds = (s: Sketch) => s.constraints.map((c) => c.kind);

function radiusOf(editor: Editor, id: Id): number {
  const e = editor.sketch.entities.find((x) => x.id === id);
  if (e?.kind === 'circle') return e.radius;
  if (e?.kind !== 'arc') throw new Error(`"${id}" is not a curve`);
  return arcParams(pointOf(editor, e.center), pointOf(editor, e.start), pointOf(editor, e.end))
    .radius;
}

function countKind(editor: Editor, kind: 'point' | 'line' | 'circle' | 'arc'): number {
  return editor.sketch.entities.filter((e) => e.kind === kind).length;
}

/** The ends of the axis every test below mirrors about: a line down the Y axis. */
const AXIS_FROM = { x: 0, y: -100 };
const AXIS_TO = { x: 0, y: 100 };

/** Where a point on the right of the axis ends up once it is mirrored. */
function mirrored(p: Vec2): Vec2 {
  return reflectPoint(p, AXIS_FROM, AXIS_TO);
}

/** The axis every test mirrors about. */
function axisLine(b: SketchBuilder): Id {
  return b.line(b.point(AXIS_FROM.x, AXIS_FROM.y), b.point(AXIS_TO.x, AXIS_TO.y));
}

describe('reflectPoint', () => {
  it('mirrors a point about a horizontal line', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    expect(reflectPoint({ x: 30, y: 40 }, a, b)).toEqual({ x: 30, y: -40 });
    expect(reflectPoint({ x: 30, y: -40 }, a, b)).toEqual({ x: 30, y: 40 });
    // A point on the line stays where it is.
    expect(reflectPoint({ x: 30, y: 0 }, a, b)).toEqual({ x: 30, y: 0 });
  });

  it('mirrors a point about a vertical line', () => {
    expect(reflectPoint({ x: 4, y: 7 }, { x: 10, y: -50 }, { x: 10, y: 50 })).toEqual({
      x: 16,
      y: 7,
    });
    expect(reflectPoint({ x: 10, y: 7 }, { x: 10, y: -50 }, { x: 10, y: 50 })).toEqual({
      x: 10,
      y: 7,
    });
  });

  it('mirrors a point about a diagonal line', () => {
    // About y = x a reflection swaps the two coordinates.
    const swapped = reflectPoint({ x: 6, y: 2 }, { x: 0, y: 0 }, { x: 10, y: 10 });
    expect(swapped.x).toBeCloseTo(2, 12);
    expect(swapped.y).toBeCloseTo(6, 12);
    // A point on the line stays where it is.
    const on = reflectPoint({ x: 4, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 10 });
    expect(on.x).toBeCloseTo(4, 12);
    expect(on.y).toBeCloseTo(4, 12);
    // A line that neither axis follows, offset from the origin.
    const off = reflectPoint({ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 40, y: 10 });
    expect(off.x).toBeCloseTo(0, 12);
    expect(off.y).toBeCloseTo(10, 12);
  });
});

describe('mirror', () => {
  it('asks for the curves to mirror, then for the line to mirror them about', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(20, 10), b.point(60, 40));
    axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirror' });
    expect(editor.activeCommand.overlay?.()).toEqual([]);
    clickCurve(editor, line);
    // Picking curves keeps the same prompt; the set is what changes.
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirror' });
    expect(highlightIds(editor)).toEqual([line]);
    enter(editor);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirrorLine' });
    // The set stays highlighted while the axis is pending.
    expect(highlightIds(editor)).toEqual([line]);
  });

  it('waits for a set before it asks for the axis', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(20, 10), b.point(60, 40));
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    // Enter with nothing picked goes nowhere: there is no mirror to place yet,
    // and the key is still the command's, so it cannot restart it either.
    expect(press(editor, 'Enter')).toBe(true);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirror' });
    clickCurve(editor, line);
    enter(editor);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirrorLine' });
  });

  it('mirrors a line across the axis', () => {
    const b = new SketchBuilder();
    const p1 = b.point(20, 10);
    const p2 = b.point(60, 40);
    const line = b.line(p1, p2);
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, line);
    enter(editor);
    const before = snapshot(editor);
    clickCurve(editor, axis);

    // One step: two points, a line between them, and a symmetric per point.
    expect(countKind(editor, 'point')).toBe(6);
    expect(countKind(editor, 'line')).toBe(3);
    expect(kinds(editor.sketch)).toEqual(['symmetric', 'symmetric']);
    const copy = editor.sketch.entities.find(
      (e) => e.kind === 'line' && e.id !== line && e.id !== axis,
    );
    if (copy?.kind !== 'line') throw new Error('the mirror added no line');
    expect(editor.sketch.constraints.map(constraintRefs)).toEqual([
      [copy.p1, p1, axis],
      [copy.p2, p2, axis],
    ]);
    // The copy is the reflection of the original, which has not moved.
    expectAt(editor, copy.p1, mirrored(pointOf(editor, p1)));
    expectAt(editor, copy.p2, mirrored(pointOf(editor, p2)));
    expectUnmoved(editor, before);
  });

  it('mirrors a circle, keeping its radius', () => {
    const b = new SketchBuilder();
    const center = b.point(40, -60);
    const circle = b.circle(center, 20);
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, circle);
    enter(editor);
    const before = snapshot(editor);
    clickCurve(editor, axis);

    // One step: the reflected centre, a circle of the same radius, and the two
    // constraints that hold it there.
    expect(countKind(editor, 'point')).toBe(4);
    expect(countKind(editor, 'circle')).toBe(2);
    expect(kinds(editor.sketch)).toEqual(['symmetric', 'equal']);
    const copy = editor.sketch.entities.find((e) => e.kind === 'circle' && e.id !== circle);
    if (copy?.kind !== 'circle') throw new Error('the mirror added no circle');
    expect(editor.sketch.constraints.map(constraintRefs)).toEqual([
      [copy.center, center, axis],
      [circle, copy.id],
    ]);
    expectAt(editor, copy.center, mirrored(pointOf(editor, center)));
    expect(radiusOf(editor, copy.id)).toBeCloseTo(radiusOf(editor, circle), 9);
    expectUnmoved(editor, before);
  });

  it('mirrors an arc, swapping its ends', () => {
    const b = new SketchBuilder();
    const center = b.point(120, 0);
    const start = b.point(150, 0);
    const end = b.point(120, -40);
    const arc = b.arc(center, start, end);
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, arc);
    enter(editor);
    const before = snapshot(editor);
    clickCurve(editor, axis);

    // One step: three points and an arc between them, no extra radius
    // constraint — the radius follows from the reflected points.
    expect(countKind(editor, 'point')).toBe(8);
    expect(countKind(editor, 'arc')).toBe(2);
    expect(kinds(editor.sketch)).toEqual(['symmetric', 'symmetric', 'symmetric']);
    const copy = editor.sketch.entities.find((e) => e.kind === 'arc' && e.id !== arc);
    if (copy?.kind !== 'arc') throw new Error('the mirror added no arc');
    // A reflection reverses orientation, and the model stores arcs running
    // clockwise on screen from start to end, so the copy's ends are the
    // reflected originals the other way round.
    expect(editor.sketch.constraints.map(constraintRefs)).toEqual([
      [copy.center, center, axis],
      [copy.start, end, axis],
      [copy.end, start, axis],
    ]);
    expectAt(editor, copy.center, mirrored(pointOf(editor, center)));
    expectAt(editor, copy.start, mirrored(pointOf(editor, end)));
    expectAt(editor, copy.end, mirrored(pointOf(editor, start)));
    expect(radiusOf(editor, copy.id)).toBeCloseTo(radiusOf(editor, arc), 9);
    expectUnmoved(editor, before);
  });

  it('mirrors every picked curve in one step', () => {
    const b = new SketchBuilder();
    const l1 = b.point(30, 20);
    const l2 = b.point(90, 60);
    const line = b.line(l1, l2);
    const center = b.point(40, -60);
    const circle = b.circle(center, 20);
    const c1 = b.point(120, 0);
    const s1 = b.point(150, 0);
    const e1 = b.point(120, -40);
    const arc = b.arc(c1, s1, e1);
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, line);
    clickCurve(editor, circle);
    clickCurve(editor, arc);
    expect(highlightIds(editor)).toEqual([line, circle, arc]);
    enter(editor);
    clickCurve(editor, axis);

    // The lot in one undo step: three curves, six constraints.
    expect(countKind(editor, 'line')).toBe(3);
    expect(countKind(editor, 'circle')).toBe(2);
    expect(countKind(editor, 'arc')).toBe(2);
    expect(kinds(editor.sketch)).toEqual([
      'symmetric',
      'symmetric',
      'symmetric',
      'equal',
      'symmetric',
      'symmetric',
      'symmetric',
    ]);
    const copyLine = editor.sketch.entities.find(
      (e) => e.kind === 'line' && e.id !== line && e.id !== axis,
    );
    const copyCircle = editor.sketch.entities.find((e) => e.kind === 'circle' && e.id !== circle);
    const copyArc = editor.sketch.entities.find((e) => e.kind === 'arc' && e.id !== arc);
    if (copyLine?.kind !== 'line' || copyCircle?.kind !== 'circle' || copyArc?.kind !== 'arc') {
      throw new Error('the mirror did not add one of the copies');
    }
    expectAt(editor, copyLine.p1, mirrored(pointOf(editor, l1)));
    expectAt(editor, copyLine.p2, mirrored(pointOf(editor, l2)));
    expectAt(editor, copyCircle.center, mirrored(pointOf(editor, center)));
    expectAt(editor, copyArc.center, mirrored(pointOf(editor, c1)));
    expectAt(editor, copyArc.start, mirrored(pointOf(editor, e1)));
    expectAt(editor, copyArc.end, mirrored(pointOf(editor, s1)));
  });

  it('drags the copy along when the original is edited', () => {
    const b = new SketchBuilder();
    const p1 = b.point(20, 10);
    const p2 = b.point(60, 40);
    const line = b.line(p1, p2);
    const a1 = b.point(AXIS_FROM.x, AXIS_FROM.y);
    const a2 = b.point(AXIS_TO.x, AXIS_TO.y);
    const axis = b.line(a1, a2);
    // The axis is pinned, so the mirror has one place to be: a sketch left
    // free would let the solver slide the axis as well as the dragged point.
    b.fix(a1);
    b.fix(a2);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, line);
    enter(editor);
    clickCurve(editor, axis);
    const copy = editor.sketch.entities.find(
      (e) => e.kind === 'line' && e.id !== line && e.id !== axis,
    );
    if (copy?.kind !== 'line') throw new Error('the mirror added no line');

    editor.startCommand('select');
    drag(editor, pointOf(editor, p1), { x: 40, y: 30 });

    // The symmetric constraints keep the copy where the original reflects to.
    expectAt(editor, p1, { x: 40, y: 30 });
    expectAt(editor, copy.p1, { x: -40, y: 30 });
    // The end that was not dragged has not moved, and neither has its mirror.
    expectAt(editor, p2, { x: 60, y: 40 });
    expectAt(editor, copy.p2, { x: -60, y: 40 });
  });

  it('takes a curve back out of the set on a second click', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(20, 10), b.point(60, 40));
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, line);
    expect(highlightIds(editor)).toEqual([line]);
    clickCurve(editor, line);
    expect(highlightIds(editor)).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirror' });
  });

  it('Esc clears the set, then ends the command', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(20, 10), b.point(60, 40));
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, line);
    editor.escape();
    expect(editor.activeCommand.id).toBe('mirror');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirror' });
    expect(highlightIds(editor)).toEqual([]);
    expect(editor.sketch.constraints).toEqual([]);
    editor.escape();
    expect(editor.activeCommand.id).toBe('select');
  });

  it('Esc in the line phase goes back to picking, keeping the set', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(20, 10), b.point(60, 40));
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, line);
    enter(editor);
    editor.escape();
    expect(editor.activeCommand.id).toBe('mirror');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirror' });
    expect(highlightIds(editor)).toEqual([line]);
  });

  it('takes the axis from a click only once the set is confirmed', () => {
    const b = new SketchBuilder();
    const line = b.line(b.point(20, 10), b.point(60, 40));
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    // Clicking the axis while still picking adds it to the set, like any other
    // curve; Enter is what moves the command on to the axis.
    clickCurve(editor, axis);
    expect(highlightIds(editor)).toEqual([axis]);
    expect(editor.sketch.constraints).toEqual([]);
    clickCurve(editor, line);
    expect(highlightIds(editor)).toEqual([axis, line]);
    enter(editor);
    // The same line a second time is no axis: mirroring it about itself would
    // only lay a copy on top of it.
    const entities = editor.sketch.entities.length;
    clickCurve(editor, axis);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirrorLine' });
    expect(editor.sketch.entities).toHaveLength(entities);
    expect(editor.sketch.constraints).toEqual([]);
  });

  it('ignores a click on a point', () => {
    const b = new SketchBuilder();
    const p = b.point(10, 10);
    const line = b.line(b.point(20, 10), b.point(60, 40));
    axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    // Picking: a point is not a curve, so the click picks nothing.
    clickEntity(editor, p);
    expect(highlightIds(editor)).toEqual([]);
    clickCurve(editor, line);
    enter(editor);
    // The axis: a point is not a line either.
    const entities = editor.sketch.entities.length;
    clickEntity(editor, p);
    expect(editor.sketch.entities).toHaveLength(entities);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirrorLine' });
  });

  it('ignores a curve while the axis is pending', () => {
    const b = new SketchBuilder();
    const center = b.point(40, -60);
    const circle = b.circle(center, 20);
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, circle);
    enter(editor);
    const entities = editor.sketch.entities.length;
    // A circle is no mirror line, so the click is not an axis.
    clickCurve(editor, circle);
    expect(editor.sketch.entities).toHaveLength(entities);
    expect(editor.sketch.constraints).toEqual([]);
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirrorLine' });
    // The line still mirrors the circle.
    clickCurve(editor, axis);
    expect(kinds(editor.sketch)).toEqual(['symmetric', 'equal']);
  });

  it('mirrors the construction flag', () => {
    const b = new SketchBuilder();
    const construction = b.line(b.point(20, 10), b.point(60, 40), { construction: true });
    const normal = b.line(b.point(20, 60), b.point(60, 90));
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, construction);
    clickCurve(editor, normal);
    enter(editor);
    clickCurve(editor, axis);

    const copies = editor.sketch.entities.filter(
      (e): e is Line =>
        e.kind === 'line' && e.id !== construction && e.id !== normal && e.id !== axis,
    );
    expect(copies).toHaveLength(2);
    const copyOfConstruction = copies.find((e) => Math.abs(pointOf(editor, e.p1).y - 10) < 1);
    const copyOfNormal = copies.find((e) => Math.abs(pointOf(editor, e.p1).y - 60) < 1);
    // Inventor mirrors the flag, so the construction line's copy is construction.
    expect(copyOfConstruction?.construction).toBe(true);
    expect(copyOfNormal?.construction).toBeUndefined();
  });

  it('stays active for the next mirror', () => {
    const b = new SketchBuilder();
    const p1 = b.point(20, 10);
    const p2 = b.point(60, 40);
    const line = b.line(p1, p2);
    const center = b.point(40, -60);
    const circle = b.circle(center, 20);
    const axis = axisLine(b);
    const editor = editorWith(b.build());
    editor.startCommand('mirror');
    clickCurve(editor, line);
    enter(editor);
    clickCurve(editor, axis);
    // Back to picking with an empty set, ready for the next one.
    expect(editor.activeCommand.id).toBe('mirror');
    expect(editor.activeCommand.prompt()).toEqual({ key: 'prompts.mirror' });
    expect(highlightIds(editor)).toEqual([]);

    clickCurve(editor, circle);
    enter(editor);
    clickCurve(editor, axis);
    expect(kinds(editor.sketch)).toEqual(['symmetric', 'symmetric', 'symmetric', 'equal']);
  });
});
